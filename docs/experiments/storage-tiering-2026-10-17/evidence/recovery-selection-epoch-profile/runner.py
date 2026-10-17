#!/usr/bin/env python3
"""Prepared only. --run executes one fixed candidate, bounded at 240 seconds.
No baseline, warmup or second sample. Only the owned engine DB copy is opened.
"""
import argparse
import gzip
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import time
import traceback

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[4]
OUTPUT = HERE / 'result'
CANDIDATE = '551a6b9020b919862434346d276a21fe3d1f4ac1'
PROFILE = HERE.parent / 'recovery-selection-profile/runner.py'
MARKER = 'recovery-selection-epoch-profile/run12-terminal/single-candidate-240s-v1'


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    if not parser.parse_args().run:
        print('Prepared only; no archive, database copy/open, or worker execution.')
        return
    assert not OUTPUT.exists(), 'Never overwrite or repeat this single checkpoint'
    assert subprocess.check_output(['git', 'rev-parse', CANDIDATE + '^{commit}'], cwd=ROOT, text=True).strip() == CANDIDATE
    lifecycle = load(PROFILE, 'profile_lifecycle')
    prior = load(lifecycle.PRIOR, 'anchor_archive')
    helper = load(prior.HELPER, 'source_manifest')
    # Import definitions only; none of the historical main functions is called.
    prior.HERE = HERE
    before = prior.protected_inputs()
    closure = json.loads(prior.CLOSURE.read_text())
    database = prior.SOURCE / 'engine/engine.sqlite'
    assert pathlib.Path(closure['source']).resolve() == prior.SOURCE.resolve()
    assert prior.sha(database) == closure['sourceDatabase']['sha256'] == prior.DATABASE_SHA
    assert prior.sha(prior.SOURCE / 'plugin/explorer.sqlite') == closure['pluginDatabase']['sha256']
    assert prior.sha(prior.RUN / 'task-after.json') == prior.TASK_SHA
    for base in [database, prior.SOURCE / 'plugin/explorer.sqlite']:
        assert not pathlib.Path(str(base) + '-wal').exists() and not pathlib.Path(str(base) + '-shm').exists()
    hashes = {str(path.relative_to(ROOT)): prior.sha(path) for path in [HERE / 'runner.py', HERE / 'worker.ts', PROFILE, lifecycle.PRIOR, prior.HELPER]}
    OUTPUT.mkdir()
    owned = pathlib.Path(tempfile.mkdtemp(prefix='bie-selection-epoch-')).resolve()
    (owned / 'owner.txt').write_text(MARKER)
    archive = child = None
    stage = 'archive_preparation'
    record = {'revision': CANDIDATE, 'workerHardDeadlineSeconds': 240, 'terminationGraceSeconds': 5,
              'killGraceSeconds': 5, 'repeats': 0, 'sourceInputs': before, 'scriptsAndHelpers': hashes,
              'ownedDirectory': str(owned), 'commands': [], 'cleanupErrors': []}
    try:
        archive = prior.setup_runtime_archive(owned / 'candidate', CANDIDATE, helper)
        prior.write(OUTPUT / 'source-manifest.json', archive['sourceManifest'])
        stage = 'private_copy_preparation'
        engine_dir = owned / 'engine'
        engine_dir.mkdir()
        shutil.copy2(database, engine_dir / 'engine.sqlite')
        assert prior.sha(engine_dir / 'engine.sqlite') == prior.DATABASE_SHA
        config = {'ownedDirectory': str(owned), 'ownershipMarker': MARKER, 'archiveRoot': archive['root'],
                  'engineDirectory': str(engine_dir), 'databaseSha256': prior.DATABASE_SHA,
                  'taskFile': str(prior.RUN / 'task-after.json'), 'taskSha256': prior.TASK_SHA,
                  'sessionId': '412937f3-c4f5-4799-b86c-74adf480f329',
                  'currentObservationId': 'dbb04d18-bd75-407a-a146-bda06280bc80',
                  'semantic': str(owned / 'semantic.json'), 'output': str(OUTPUT / 'report.json'), 'revision': CANDIDATE}
        prior.write(owned / 'config.json', config)
        prior.write(OUTPUT / 'setup.json', {**record,
            'archive': {**{key: value for key, value in archive.items() if key != 'sourceManifest'},
                        'sourceManifest': {'path': 'source-manifest.json', 'sha256': prior.sha(OUTPUT / 'source-manifest.json')}},
            'inputTransformation': 'Only in-memory task.status paused to running; plan/budget/usage/cursor/retry debt retained',
            'instrumentation': 'Host facade and returned view facade only. Engine/adapter/store reads and prototypes are unchanged. No exact SQL-read claim.',
            'browserGuard': 'Playwright browser-type launch/connect entry points throw before any browser is created or connected',
            'comparisonLimit': 'Previous baseline and fe3 candidate both timed out. Instrumentation differs; no paired percentage speedup or full semantic equivalence claim.'})
        env = {key: os.environ[key] for key in ['HOME', 'LANG', 'LC_ALL'] if key in os.environ}
        env.update(PATH=str(prior.NODE.parent) + ':/usr/bin:/bin:/usr/sbin:/sbin', CI='true', NO_COLOR='1', TSX_DISABLE_CACHE='1', TMPDIR=str(owned))
        argv = [str(prior.NODE), '--max-old-space-size=6144', '--conditions=development', '--import=tsx',
                str(pathlib.Path(archive['root']) / '.data/worker.ts'), str(owned / 'config.json')]
        stage = 'worker'
        command = {'argv': argv, 'startedEpoch': time.time(), 'telemetry': 'worker.jsonl', 'stderr': 'worker.stderr.log'}
        record['commands'].append(command)
        with open(OUTPUT / 'worker.jsonl', 'xb') as stdout, open(OUTPUT / 'worker.stderr.log', 'xb') as stderr:
            child = subprocess.Popen(argv, cwd=archive['root'], env=env, stdout=stdout, stderr=stderr, start_new_session=True)
            try:
                command['pid'] = child.pid
                prior.write(OUTPUT / 'progress.json', command)
                try:
                    command['exitCode'] = child.wait(timeout=240)
                except subprocess.TimeoutExpired:
                    command['timedOut'] = True
            finally:
                lifecycle.reap(child, command)
                command['exitCode'] = child.poll()
                command['finishedEpoch'] = time.time()
        record['completed'] = not command.get('timedOut') and command['exitCode'] == 0
        record['timedOut'] = bool(command.get('timedOut'))
    except BaseException as error:
        record.update(error=type(error).__name__ + ': ' + str(error), failureStage=stage, traceback=traceback.format_exc())
    finally:
        try:
            lifecycle.reap(child, record)
        except BaseException as error:
            record['cleanupErrors'].append(str(error))
        record['workerExited'] = child is None or child.poll() is not None
        try:
            record['inputsUnchanged'] = prior.protected_inputs() == before
            record['scriptsUnchanged'] = all(prior.sha(ROOT / path) == value for path, value in hashes.items())
            if archive:
                record['archiveSourcesUnchanged'] = helper.manifest(pathlib.Path(archive['root'])) == archive['sourceManifest']
                record['archiveWorkerUnchanged'] = prior.sha(pathlib.Path(archive['root']) / '.data/worker.ts') == archive['workerSha256']
            if (owned / 'engine/engine.sqlite').exists():
                record['copyAfterWorker'] = {suffix or 'main': prior.fingerprint(pathlib.Path(str(owned / 'engine/engine.sqlite') + suffix)) for suffix in ['', '-wal', '-shm']}
            semantic = owned / 'semantic.json'
            if semantic.exists() and record['workerExited']:
                digest = prior.sha(semantic)
                packed = OUTPUT / ('semantic-' + digest + '.json.gz')
                with open(semantic, 'rb') as source, open(packed, 'xb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as output:
                    shutil.copyfileobj(source, output)
                record['semanticArtifact'] = {'path': packed.name, 'logicalSha256': digest, 'logicalBytes': semantic.stat().st_size, 'gzipSha256': prior.sha(packed)}
        except BaseException as error:
            record['cleanupErrors'].append(str(error))
        cleanup_started = time.monotonic()
        assert (owned / 'owner.txt').read_text() == MARKER
        if record['workerExited']:
            shutil.rmtree(owned)
        else:
            record['directoryRetainedReason'] = 'Worker exit not confirmed'
        record['temporaryDirectoryRemoved'] = not owned.exists()
        record['parentCleanupMs'] = (time.monotonic() - cleanup_started) * 1000
        prior.write(OUTPUT / 'execution.json', record)
    print(json.dumps({key: record.get(key) for key in ['completed', 'timedOut', 'error', 'workerExited', 'temporaryDirectoryRemoved']}))
    if not record.get('completed') or record['cleanupErrors'] or not all(record.get(key) for key in ['inputsUnchanged', 'scriptsUnchanged', 'archiveSourcesUnchanged', 'archiveWorkerUnchanged']):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
