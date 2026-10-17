#!/usr/bin/env python3
"""Prepared single A/B retained-facts comparison; no action without --run.

Requires a frozen candidate commit. One private engine directory is reset from
the unchanged closed source before each serial fresh-process worker. This is a
terminal-task counterfactual, never the original run12 live timing. No automatic
repeat, install, build, browser, provider, service, or original DB connection.
"""
import argparse
import gzip
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import tarfile
import tempfile
import time
import traceback

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[4]
BASELINE = '8c5c0a15465cd9d85de1f51b431b37c821aa8172'
NODE = pathlib.Path('/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin/node')
RUN = ROOT / '.data/okx-storage-acceptance-20261017-v5/runs/bb1d2382-753b-43e4-849c-4ca04066b822'
SOURCE = RUN.parents[1]
CLOSURE = HERE.parent / 'real-okx-12/closed-evidence.json'
HELPER = HERE.parent / 'real-okx-6/audit-serial/runner.py'
REFERENCE = HERE.parent / 'real-okx-7/source-material-isolation/runner.py'
QUERY_REFERENCE = HERE.parent / 'recovery-candidate-contract/frozen-query.ts'
DATABASE_SHA = '55bff5f72d7c84bf7352481fba4fc1c8492cd8db7533c62d6cb43dff4495b7f7'
TASK_SHA = 'f02ec00c20712401e492d5f9f9a84d24071b47eb992b77f6ccdf710acab1b4d8'
MARKER = 'recovery-anchor-material/run12-closed-terminal/single-ab-v1'
ARCHIVE_INPUTS = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json',
                  'tsconfig.build.json', '.node-version', 'packages', 'apps', 'scripts']


def sha(path):
    value = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def fingerprint(path):
    return {'bytes': path.stat().st_size, 'sha256': sha(path)} if path.exists() else None


def protected_inputs():
    paths = [CLOSURE, RUN / 'task-after.json', RUN / 'task-before.json', RUN / 'coverage-review.json', RUN / 'metrics.jsonl',
             SOURCE / 'engine/engine.sqlite', SOURCE / 'engine/engine.sqlite-wal', SOURCE / 'engine/engine.sqlite-shm',
             SOURCE / 'plugin/explorer.sqlite', SOURCE / 'plugin/explorer.sqlite-wal', SOURCE / 'plugin/explorer.sqlite-shm']
    return {str(path): fingerprint(path) for path in paths}


def differences(left, right, path='$', found=None):
    """Inspect every field/ordered array; cap stored mismatch paths, not comparison."""
    if found is None:
        found = {'count': 0, 'firstPaths': []}
    if type(left) is not type(right):
        mismatch = True
    elif isinstance(left, dict):
        for key in sorted(set(left) | set(right)):
            if key not in left or key not in right:
                found['count'] += 1
                if len(found['firstPaths']) < 80:
                    found['firstPaths'].append(path + '.' + key + ' (missing)')
            else:
                differences(left[key], right[key], path + '.' + key, found)
        return found
    elif isinstance(left, list):
        if len(left) != len(right):
            found['count'] += 1
            if len(found['firstPaths']) < 80:
                found['firstPaths'].append(path + '.length')
        for index, (a, b) in enumerate(zip(left, right)):
            differences(a, b, f'{path}[{index}]', found)
        return found
    else:
        mismatch = left != right
    if mismatch:
        found['count'] += 1
        if len(found['firstPaths']) < 80:
            found['firstPaths'].append(path)
    return found


def record_reads(report, phases=('selection', 'revalidation')):
    # Nested require and decodeStoredEntity are reported separately, not counted
    # twice. This is public raw-record accessor calls, not exact SQL statement IO.
    methods = {'get', 'list', 'listByObservation', 'events', 'request'}
    return sum(count for phase in phases for key, count in report['reads'].get(phase, {}).items() if key.split(':')[0] in methods)


def setup_runtime_archive(path, revision, helper):
    """Same workspace-isolation rules as the prior helper, runtime inputs only.

    Deliberately exclude historical docs/evidence, tests and examples. No build
    or test runs here. Every included runtime/source/config file is manifested.
    Do not weaken the old helper's symlink rule or copy old evidence inputs.
    """
    path.mkdir()
    archive_path = path / '.source.tar'
    with open(archive_path, 'wb') as output:
        subprocess.run(['git', 'archive', '--format=tar', revision, '--', *ARCHIVE_INPUTS], cwd=ROOT, stdout=output, check=True)
    archive_hash = sha(archive_path)
    with tarfile.open(archive_path) as archive:
        for member in archive.getmembers():
            name = pathlib.PurePosixPath(member.name)
            assert not name.is_absolute() and '..' not in name.parts, f'Unsafe archive path: {member.name}'
            assert not member.issym() and not member.islnk(), f'Unexpected runtime-input symlink: {member.name} -> {member.linkname}'
            assert member.isfile() or member.isdir(), f'Unexpected archive member type: {member.name}'
            assert name.parts[0] in ARCHIVE_INPUTS, f'Archive scope escaped: {member.name}'
            assert not any(part == '.env' or part.startswith('.env.') and not part.endswith('.example') for part in name.parts), f'Unexpected environment file: {member.name}'
        archive.extractall(path)
    archive_path.unlink()
    source_manifest = helper.manifest(path)
    packages = [path / 'package.json'] + sorted((path / 'packages').glob('*/package.json')) + sorted((path / 'apps').glob('*/package.json'))
    names = {json.loads(package.read_text())['name']: package.parent for package in packages[1:]}
    workspace_links, external_dependencies = [], []
    for package in packages:
        local = package.parent / 'node_modules'
        original = ROOT / package.parent.relative_to(path) / 'node_modules'
        local.mkdir(exist_ok=True)

        def link(name, source):
            destination = local / name
            if destination.exists():
                return
            target = names[name] if name in names else source.resolve(strict=True)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.symlink_to(target, target_is_directory=True)
            row = {'name': name, 'link': str(destination.relative_to(path)), 'target': str(destination.resolve())}
            if name in names:
                assert destination.resolve().is_relative_to(path), f'Workspace import escapes archive: {name}'
                workspace_links.append(row)
            else:
                assert 'node_modules' in target.parts, f'External dependency is not in node_modules: {name}'
                external_dependencies.append(row)

        if original.is_dir():
            for entry in sorted(original.iterdir()):
                if entry.name.startswith('.'):
                    continue
                if entry.name.startswith('@'):
                    for dependency in sorted(entry.iterdir()):
                        link(entry.name + '/' + dependency.name, dependency)
                else:
                    link(entry.name, entry)
        metadata = json.loads(package.read_text())
        for name in {**metadata.get('dependencies', {}), **metadata.get('devDependencies', {}), **metadata.get('peerDependencies', {})}:
            if name in names:
                link(name, names[name])
    (path / '.data').mkdir()
    shutil.copy2(HERE / 'worker.ts', path / '.data/worker.ts')
    return {'revision': revision, 'root': str(path), 'archiveInputs': ARCHIVE_INPUTS, 'archiveSha256': archive_hash,
            'sourceManifest': source_manifest, 'workspaceLinks': workspace_links, 'externalDependencies': external_dependencies,
            'workerSha256': sha(path / '.data/worker.ts')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--candidate', help='Exact frozen product commit; required for --run')
    args = parser.parse_args()
    if not args.run:
        print('Prepared only. No archive, input copy, database access, or algorithm execution. Explicit --run and --candidate are required.')
        return
    assert args.candidate and re.fullmatch('[0-9a-f]{40}', args.candidate), 'A full fixed candidate SHA is required'
    assert not (HERE / 'setup.json').exists() and not (HERE / 'execution.json').exists(), 'Never overwrite/repeat this single checkpoint'
    for revision in [BASELINE, args.candidate]:
        resolved = subprocess.check_output(['git', 'rev-parse', revision + '^{commit}'], cwd=ROOT, text=True).strip()
        assert resolved == revision
    original = protected_inputs()
    closure = json.loads(CLOSURE.read_text())
    database = SOURCE / 'engine/engine.sqlite'
    assert pathlib.Path(closure['source']).resolve() == SOURCE.resolve()
    assert closure['sourceDatabase']['sha256'] == DATABASE_SHA == sha(database)
    assert closure['pluginDatabase']['sha256'] == sha(SOURCE / 'plugin/explorer.sqlite')
    assert sha(RUN / 'task-after.json') == TASK_SHA
    for base in [database, SOURCE / 'plugin/explorer.sqlite']:
        assert not pathlib.Path(str(base) + '-wal').exists() and not pathlib.Path(str(base) + '-shm').exists(), 'Frozen source has sidecars'
    task = json.loads((RUN / 'task-after.json').read_text())
    assert task['status'] == 'paused' and 'activeSince' not in task and 'pendingDispatch' not in task
    assert not task.get('unverifiedRecoveries')
    assert task['usage']['actions'] < task['budget']['actions'] and task['usage']['durationMs'] < task['budget']['durationMs'], 'No budget changes allowed'
    assert len(task['plan']) == 1241 and len(task['routeRetries']['routes']) == 8
    assert task['rounds'][-1]['sessionId'] == '412937f3-c4f5-4799-b86c-74adf480f329'
    assert task['rounds'][-1]['position']['observationId'] == 'dbb04d18-bd75-407a-a146-bda06280bc80'
    spec = importlib.util.spec_from_file_location('archive_helper', HELPER)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)  # Only definitions; never call the old runner.
    helper.HERE, helper.SOURCE = HERE, ROOT
    owned = pathlib.Path(tempfile.mkdtemp(prefix='bie-recovery-anchor-material-')).resolve()
    (owned / 'owner.txt').write_text(MARKER)
    archives, reports, commands, semantics = {}, {}, [], {}
    children = []
    error = None
    result = {'scope': 'Single A→B first pair only; no automatic extra samples, input adjustment or claimed live run12 speedup', 'negativeCheckpoint': []}
    script_hashes = {path.name: sha(path) for path in [HERE / 'runner.py', HERE / 'worker.ts']}
    stage = 'archive_preparation'
    try:
        for name, revision in [('baseline', BASELINE), ('candidate', args.candidate)]:
            stage = f'archive_preparation:{name}'
            archives[name] = setup_runtime_archive(owned / name, revision, helper)
            write(HERE / f'{name}-source.json', archives[name]['sourceManifest'])
        archive_references = {name: {**{key: value for key, value in archive.items() if key != 'sourceManifest'},
                                     'sourceManifest': {'path': f'{name}-source.json', 'sha256': sha(HERE / f'{name}-source.json')}}
                              for name, archive in archives.items()}
        setup = {'baseline': BASELINE, 'candidate': args.candidate, 'ownedDirectory': str(owned), 'archives': archive_references,
                 'inputs': original, 'inputTransformation': 'Only in-memory task.status paused→running', 'scripts': script_hashes,
                 'referenceScripts': {str(path.relative_to(ROOT)): sha(path) for path in [HELPER, REFERENCE, QUERY_REFERENCE]},
                 'plan': {'pairs': 1, 'order': ['baseline', 'candidate'], 'onePrivateEngineDirectoryResetFromSourceForEachWorker': True,
                          'retentionSweepIntervalMs': 0, 'noWarmup': True, 'noOriginalDatabaseConnection': True,
                          'timeoutSecondsPerWorker': 240, 'wallRegressionThreshold': 1.10,
                          'memoryCapture': 'Immediately after await selector + callback, before output/hash/serialization',
                          'limits': 'OS caches, cohost load and first-process order are uncontrolled. One sample is a checkpoint, not statistical proof.'}}
        write(HERE / 'setup.json', setup)
        env = {key: os.environ[key] for key in ['HOME', 'LANG', 'LC_ALL'] if key in os.environ}
        env.update(PATH=str(NODE.parent) + ':/usr/bin:/bin:/usr/sbin:/sbin', CI='true', NO_COLOR='1', TSX_DISABLE_CACHE='1', TMPDIR=str(owned))
        engine_directory = owned / 'engine'
        for name in ['baseline', 'candidate']:
            stage = f'private_copy_preparation:{name}'
            assert protected_inputs() == original, 'Source inputs changed; stop before another worker'
            if engine_directory.exists():
                shutil.rmtree(engine_directory)  # Only after previous owned worker exited/closed.
            engine_directory.mkdir()
            shutil.copy2(database, engine_directory / 'engine.sqlite')
            assert sha(engine_directory / 'engine.sqlite') == DATABASE_SHA
            archive = archives[name]
            assert helper.manifest(pathlib.Path(archive['root'])) == archive['sourceManifest']
            assert sha(pathlib.Path(archive['root']) / '.data/worker.ts') == script_hashes['worker.ts']
            semantic = owned / f'{name}-semantic.json'
            config = {'variant': name, 'revision': archive['revision'], 'archiveRoot': archive['root'], 'ownedDirectory': str(owned),
                      'ownershipMarker': MARKER, 'engineDirectory': str(engine_directory), 'databaseSha256': DATABASE_SHA,
                      'taskFile': str(RUN / 'task-after.json'), 'taskSha256': TASK_SHA, 'taskId': task['id'],
                      'sessionId': task['rounds'][-1]['sessionId'], 'currentObservationId': task['rounds'][-1]['position']['observationId'],
                      'output': str(HERE / f'{name}.json'), 'semantic': str(semantic)}
            config_path = owned / f'{name}-config.json'
            write(config_path, config)
            argv = [str(NODE), '--max-old-space-size=6144', '--conditions=development', '--import=tsx', str(pathlib.Path(archive['root']) / '.data/worker.ts'), str(config_path)]
            row = {'variant': name, 'argv': argv, 'startedEpoch': time.time()}
            commands.append(row)
            stage = f'worker:{name}'
            with open(HERE / f'{name}.log', 'xb') as log:
                child = subprocess.Popen(argv, cwd=archive['root'], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                children.append(child)
                try:
                    row['pid'] = child.pid
                    write(HERE / 'progress.json', commands)
                    try:
                        row['exitCode'] = child.wait(timeout=240)
                    except subprocess.TimeoutExpired:
                        row['timedOut'] = True
                finally:
                    # Runs for timeout, KeyboardInterrupt, and every other
                    # exception after spawn. Never delete a copy still in use.
                    if child.poll() is None:
                        row['terminationRequested'] = True
                        try:
                            os.killpg(child.pid, signal.SIGTERM)
                        except ProcessLookupError:
                            pass
                        try:
                            child.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            row['killRequested'] = True
                            try:
                                os.killpg(child.pid, signal.SIGKILL)
                            except ProcessLookupError:
                                pass
                            child.wait(timeout=10)
                    row['exitCode'] = child.poll()
            row['finishedEpoch'] = time.time()
            write(HERE / 'progress.json', commands)
            assert not row.get('timedOut') and row['exitCode'] == 0, f'{name} failed; preserve log and stop'
            reports[name] = json.loads((HERE / f'{name}.json').read_text())
            assert reports[name]['success']
            logical_hash = sha(semantic)
            packed = HERE / f'semantic-{logical_hash}.json.gz'
            if not packed.exists():
                with open(semantic, 'rb') as source, open(packed, 'xb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as output:
                    shutil.copyfileobj(source, output)
            semantics[name] = {'path': packed.name, 'logicalSha256': logical_hash, 'logicalBytes': semantic.stat().st_size, 'gzipSha256': sha(packed)}
        stage = 'complete_semantic_comparison'
        baseline, candidate = reports['baseline'], reports['candidate']
        a = json.loads((owned / 'baseline-semantic.json').read_text())
        b = json.loads((owned / 'candidate-semantic.json').read_text())
        comparison = {key: differences(a[key], b[key], '$.' + key) for key in ['selection', 'callback', 'task', 'events', 'routeRetriesBefore', 'routeRetriesAfter']}
        comparison['full'] = differences(a, b)
        result['comparison'] = comparison
        result['sameInputFacts'] = baseline['inputFacts'] == candidate['inputFacts'] and baseline['inputTaskSha256'] == candidate['inputTaskSha256']
        result['sameConstructorRecordWrites'] = baseline['copy']['constructorWritesSha256'] == candidate['copy']['constructorWritesSha256']
        result['semanticMetadataExclusions'] = []
        result['samples'] = {name: {'revision': archives[name]['revision'], 'report': {'path': f'{name}.json', 'sha256': sha(HERE / f'{name}.json')},
                                   'timingsMs': report['timingsMs'], 'rawRecordAccessorCalls': record_reads(report),
                                   'rssBytesBeforeSerialization': report['resourcesAtSelectionEnd']['memory']['rss'],
                                   'maxRssKiBBeforeSerialization': report['resourcesAtSelectionEnd']['usage']['maxRSS']}
                             for name, report in reports.items()}
        result['wallRatio'] = candidate['timingsMs']['total'] / baseline['timingsMs']['total']
        anchor_calls = sum(candidate['hostCalls'].get(phase, {}).get('recoveryAnchorMaterial', 0) for phase in ['selection', 'revalidation'])
        if comparison['full']['count']:
            result['negativeCheckpoint'].append('complete_semantics_differ')
        if not result['sameInputFacts'] or not result['sameConstructorRecordWrites']:
            result['negativeCheckpoint'].append('same_facts_not_established')
        if anchor_calls == 0:
            result['negativeCheckpoint'].append('new_anchor_api_not_exercised')
        if record_reads(candidate) >= record_reads(baseline):
            result['negativeCheckpoint'].append('raw_record_accessor_calls_not_reduced')
        if result['wallRatio'] > 1.10:
            result['negativeCheckpoint'].append('first_pair_wall_regression_over_10_percent')
        result['firstPairPassed'] = not result['negativeCheckpoint']
        result['furtherRuns'] = 'None. Any extra pair needs a separate decision after reviewing this first checkpoint.'
    except BaseException as exc:
        error = type(exc).__name__ + ': ' + str(exc)
        result['failureStage'] = stage
        result['traceback'] = traceback.format_exc()
    finally:
        result['error'] = error
        result['scriptHashes'] = script_hashes
        result['archiveHelperSha256'] = sha(HELPER)
        result['commands'] = commands
        result['semanticArtifacts'] = semantics
        result['inputsUnchanged'] = protected_inputs() == original
        result['scriptsUnchanged'] = all(sha(HERE / name) == value for name, value in script_hashes.items())
        result['archiveSourcesUnchanged'] = {name: helper.manifest(pathlib.Path(archive['root'])) == archive['sourceManifest'] for name, archive in archives.items()}
        result['archiveWorkersUnchanged'] = {name: sha(pathlib.Path(archive['root']) / '.data/worker.ts') == script_hashes['worker.ts'] for name, archive in archives.items()}
        result['activeWorkerPids'] = [child.pid for child in children if child.poll() is None]
        assert (owned / 'owner.txt').read_text() == MARKER, 'Ownership mismatch: do not remove temporary directory'
        if not result['activeWorkerPids']:
            shutil.rmtree(owned)
        else:
            result['temporaryDirectoryRetained'] = {'path': str(owned), 'reason': 'Worker exit not confirmed; do not delete its open copy'}
        result['temporaryDirectoryRemoved'] = not owned.exists()
        write(HERE / 'execution.json', result)
    print(json.dumps({'output': str(HERE / 'execution.json'), 'error': error, 'firstPairPassed': result.get('firstPairPassed'), 'negativeCheckpoint': result['negativeCheckpoint'], 'temporaryDirectoryRemoved': result['temporaryDirectoryRemoved']}, ensure_ascii=False))
    if error or result['negativeCheckpoint'] or not result['inputsUnchanged'] or not result['scriptsUnchanged'] or not all(result['archiveSourcesUnchanged'].values()) or not all(result['archiveWorkersUnchanged'].values()):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
