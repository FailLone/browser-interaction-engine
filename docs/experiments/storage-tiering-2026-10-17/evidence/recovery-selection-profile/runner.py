#!/usr/bin/env python3
"""One explicitly authorized fixed candidate process, at most 240 seconds.
No baseline rerun, warmup, second sample, live browser or source DB connection.
Stage and work counters persist even when the process is terminated.
"""
import argparse
import gzip
import importlib.util
import json
import os
import pathlib
import shutil
import signal
import subprocess
import tempfile
import time
import traceback

TOOLS = pathlib.Path(__file__).resolve().parent
HERE = TOOLS.parent / 'recovery-candidate-bounded'
ROOT = TOOLS.parents[4]
PRIOR = TOOLS.parent / 'recovery-anchor-material/runner.py'
CANDIDATE = 'fe3cb7a70585de64c6638c6b43584bce141d969a'
MARKER = 'recovery-candidate-bounded/run12-terminal/single-candidate-240s-v1'


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def reap(child, record):
    # Same bounded cleanup invariant as the referenced runner. Its cleanup is
    # inline, so no callable helper exists; do not edit old execution evidence.
    if child is None or child.poll() is not None:
        return
    record['terminationRequested'] = True
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        record['killRequested'] = True
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    if not parser.parse_args().run:
        print('Prepared only; no archive, database copy/open, or worker execution.')
        return
    assert not HERE.exists(), 'One candidate only; never overwrite/repeat evidence'
    HERE.mkdir()
    assert subprocess.check_output(['git', 'rev-parse', CANDIDATE + '^{commit}'], cwd=ROOT, text=True).strip() == CANDIDATE
    prior = load(PRIOR, 'anchor_archive')
    helper = load(prior.HELPER, 'source_manifest')
    # Reuse the already-reviewed runtime archive and workspace isolation code.
    # Only its worker source directory changes; no old runner main is invoked.
    prior.HERE = TOOLS
    before = prior.protected_inputs()
    closure = json.loads(prior.CLOSURE.read_text())
    database = prior.SOURCE / 'engine/engine.sqlite'
    assert prior.sha(database) == closure['sourceDatabase']['sha256'] == prior.DATABASE_SHA
    assert prior.sha(prior.SOURCE / 'plugin/explorer.sqlite') == closure['pluginDatabase']['sha256']
    assert prior.sha(prior.RUN / 'task-after.json') == prior.TASK_SHA
    assert pathlib.Path(closure['source']).resolve() == prior.SOURCE.resolve()
    for base in [database, prior.SOURCE / 'plugin/explorer.sqlite']:
        for suffix in ['-wal', '-shm']:
            assert not pathlib.Path(str(base) + suffix).exists(), 'Frozen source has sidecars'
    owned = pathlib.Path(tempfile.mkdtemp(prefix='bie-candidate-bounded-')).resolve()
    (owned / 'owner.txt').write_text(MARKER)
    hashes = {str(path.relative_to(ROOT)): prior.sha(path) for path in [TOOLS / 'runner.py', TOOLS / 'worker.ts', PRIOR, prior.HELPER]}
    archive = None
    child = None
    stage = 'archive_preparation'
    record = {'purpose': 'One user-authorized candidate at the same 240-second process bound as the prior failed baseline; stage/read attribution, no statistical or full-semantic A/B claim',
              'revision': CANDIDATE, 'sourceInputs': before, 'scriptsAndReferencedHelpers': hashes,
              'ownedDirectory': str(owned), 'workerHardDeadlineSeconds': 240,
              'cleanupGraceSeconds': 10, 'repeats': 0, 'commands': []}
    try:
        archive = prior.setup_runtime_archive(owned / 'candidate', CANDIDATE, helper)
        prior.write(HERE / 'source-manifest.json', archive['sourceManifest'])
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
                  'semantic': str(owned / 'semantic.json'), 'output': str(HERE / 'report.json'), 'revision': CANDIDATE}
        prior.write(owned / 'config.json', config)
        prior.write(HERE / 'setup.json', {**record, 'archive': {**{key: value for key, value in archive.items() if key != 'sourceManifest'},
                                                            'sourceManifest': {'path': 'source-manifest.json', 'sha256': prior.sha(HERE / 'source-manifest.json')}},
                                            'inputTransformation': 'task.status paused→running in memory only; no budget/cursor/plan/debt changes',
                                            'telemetry': 'Synchronous stage and outer host call begin/end JSONL, about one-second call-boundary aggregates, output counts without source-result retention; inclusive nested timings are not additive',
                                            'baselineReference': {'path': '../recovery-anchor-material/execution.json', 'sha256': prior.sha(PRIOR.parent / 'execution.json'), 'workerHardDeadlineSeconds': 240},
                                            'limits': 'Instrumentation differs from prior incomplete baseline. No percentage speedup or full semantic-equivalence claim is possible from these samples.'})
        env = {key: os.environ[key] for key in ['HOME', 'LANG', 'LC_ALL'] if key in os.environ}
        env.update(PATH=str(prior.NODE.parent) + ':/usr/bin:/bin:/usr/sbin:/sbin', CI='true', NO_COLOR='1', TSX_DISABLE_CACHE='1', TMPDIR=str(owned))
        argv = [str(prior.NODE), '--max-old-space-size=6144', '--conditions=development', '--import=tsx',
                str(pathlib.Path(archive['root']) / '.data/worker.ts'), str(owned / 'config.json')]
        stage = 'worker'
        command = {'argv': argv, 'startedEpoch': time.time(), 'telemetry': 'worker.jsonl', 'stderr': 'worker.stderr.log'}
        record['commands'].append(command)
        with open(HERE / 'worker.jsonl', 'xb') as stdout, open(HERE / 'worker.stderr.log', 'xb') as stderr:
            child = subprocess.Popen(argv, cwd=archive['root'], env=env, stdout=stdout, stderr=stderr, start_new_session=True)
            try:
                command['pid'] = child.pid
                prior.write(HERE / 'progress.json', command)
                try:
                    command['exitCode'] = child.wait(timeout=240)
                except subprocess.TimeoutExpired:
                    command['timedOut'] = True
            finally:
                reap(child, command)
                command['exitCode'] = child.poll()
                command['finishedEpoch'] = time.time()
        record['candidateCompleted'] = not command.get('timedOut') and command['exitCode'] == 0
        record['candidateTimedOut'] = bool(command.get('timedOut'))
    except BaseException as error:
        record['error'] = type(error).__name__ + ': ' + str(error)
        record['failureStage'] = stage
        record['traceback'] = traceback.format_exc()
    finally:
        try:
            reap(child, record)
        except BaseException as error:
            record['cleanupError'] = str(error)
        record['workerExited'] = child is None or child.poll() is not None
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
            packed = HERE / ('semantic-' + digest + '.json.gz')
            with open(semantic, 'rb') as source, open(packed, 'xb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as output:
                shutil.copyfileobj(source, output)
            record['semanticArtifact'] = {'path': packed.name, 'logicalSha256': digest, 'logicalBytes': semantic.stat().st_size, 'gzipSha256': prior.sha(packed)}
        cleanup_started = time.monotonic()
        assert (owned / 'owner.txt').read_text() == MARKER
        if record['workerExited']:
            shutil.rmtree(owned)
        else:
            record['directoryRetainedReason'] = 'Worker exit not confirmed; do not delete its open database copy'
        record['temporaryDirectoryRemoved'] = not owned.exists()
        record['parentCleanupMs'] = (time.monotonic() - cleanup_started) * 1000
        prior.write(HERE / 'execution.json', record)
    print(json.dumps({'output': str(HERE / 'execution.json'), 'timedOut': record.get('candidateTimedOut'), 'completed': record.get('candidateCompleted'),
                      'error': record.get('error'), 'workerExited': record['workerExited'], 'temporaryDirectoryRemoved': record['temporaryDirectoryRemoved']}))
    if not record.get('candidateCompleted') or not record['inputsUnchanged'] or not record['scriptsUnchanged'] or not record.get('archiveSourcesUnchanged'):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
