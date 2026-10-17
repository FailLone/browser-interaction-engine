#!/usr/bin/env python3
"""Prepare only unless --run is explicitly supplied. One diagnostic <=240s.

Reuse the already-reviewed epoch lifecycle without a second baseline/candidate.
Only an owned archive's explorer runtime receives a recorded diagnostic patch.
Never connect the original DB; SDK/store/adapter remain their default methods.
"""
import difflib
import gzip
import hashlib
import importlib.util
import json
import pathlib
import shutil
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[4]
EPOCH = HERE.parent / 'recovery-selection-epoch-profile'
ORACLE = EPOCH / 'result/semantic-264bde57836f0ab768bb49251eeb31ec5cba844f252a62f2ca1e2c07ee66e5d6.json.gz'
ORACLE_LOGICAL_SHA = '264bde57836f0ab768bb49251eeb31ec5cba844f252a62f2ca1e2c07ee66e5d6'
ORACLE_GZIP_SHA = '0338dff992c98dcaeafb9eede052504622a67dc59f2659e3cdfa867ec19f1730'
OUTPUT = HERE / 'result'
MARKER = 'recovery-selection-exclusion-diagnostic/run12/one-240s-v1'
RUNTIME = pathlib.Path('packages/explorer-plugin/src/runtime.ts')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def patch_diff(before, after, filename):
    return ''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True),
                                      fromfile='551a6b9/' + filename, tofile='owned-diagnostic/' + filename))


def main():
    if sys.argv[1:] != ['--run']:
        assert not sys.argv[1:], 'Only --run is supported; no alternate input, revision, repeat, or time limit'
        print('Prepared only. No archive, DB copy/open, selector, or diagnostic executed.')
        return
    assert not OUTPUT.exists(), 'One diagnostic only; existing evidence must not be overwritten'
    assert sha(ORACLE) == ORACLE_GZIP_SHA
    oracle_bytes = gzip.decompress(ORACLE.read_bytes())
    assert hashlib.sha256(oracle_bytes).hexdigest() == ORACLE_LOGICAL_SHA
    oracle = json.loads(oracle_bytes)
    epoch = load(EPOCH / 'runner.py', 'diagnostic_epoch_lifecycle')
    injector = load(HERE / 'injector.py', 'diagnostic_exact_injector')
    # Importing helpers does not call any of their historical main functions.
    original_load = epoch.load
    tracked = [HERE / 'runner.py', HERE / 'worker.ts', HERE / 'injector.py', EPOCH / 'runner.py', EPOCH / 'worker.ts', ORACLE]
    hashes = {str(path.relative_to(ROOT)): sha(path) for path in tracked}
    state = {}

    def intercepted_load(path, name):
        module = original_load(path, name)
        if name != 'anchor_archive':
            return module
        state['prior'] = module
        original_archive, original_write = module.setup_runtime_archive, module.write

        def archive_with_diagnostic(path, revision, helper):
            archive = original_archive(path, revision, helper)
            assert revision == '551a6b9020b919862434346d276a21fe3d1f4ac1'
            runtime = path / RUNTIME
            pristine = runtime.read_text()
            injected, replacements = injector.apply_runtime(pristine)
            runtime.write_text(injected)
            original_worker = (EPOCH / 'worker.ts').read_text()
            base_worker = injector.apply_worker(original_worker)
            (path / '.data/base-worker.ts').write_text(base_worker)
            runtime_diff = OUTPUT / 'runtime.diagnostic.patch'
            runtime_diff.write_text(patch_diff(pristine, injected, str(RUNTIME)))
            worker_diff = OUTPUT / 'worker.diagnostic.patch'
            worker_diff.write_text(patch_diff(original_worker, base_worker, 'epoch-worker.ts'))
            after = helper.manifest(path)
            before_map = {row['path']: row for row in archive['sourceManifest']}
            after_map = {row['path']: row for row in after}
            assert before_map.keys() == after_map.keys()
            changed = [name for name in before_map if before_map[name] != after_map[name]]
            assert changed == [str(RUNTIME)], changed
            state['workerPath'] = path / '.data/base-worker.ts'
            state['workerHash'] = sha(state['workerPath'])
            archive.update(sourceManifest=after, diagnostic={
                'productRevision': revision, 'onlyProductPathChanged': str(RUNTIME),
                'pristineRuntimeSha256': hashlib.sha256(pristine.encode()).hexdigest(),
                'instrumentedRuntimeSha256': sha(runtime), 'replacements': replacements,
                'runtimePatch': runtime_diff.name, 'runtimePatchSha256': sha(runtime_diff),
                'baseWorkerReference': str((EPOCH / 'worker.ts').relative_to(ROOT)),
                'baseWorkerReferenceSha256': sha(EPOCH / 'worker.ts'), 'instrumentedBaseWorkerSha256': state['workerHash'],
                'workerPatch': worker_diff.name, 'workerPatchSha256': sha(worker_diff),
                'extraProtectedFiles': hashes,
                'semanticOracle': {'path': str(ORACLE.relative_to(ROOT)), 'logicalSha256': ORACLE_LOGICAL_SHA, 'gzipSha256': ORACLE_GZIP_SHA},
                'semanticComparisonExcludedFields': [],
                'timingUse': 'Diagnostic bound only. Explanatory pure projections/read-only strategy queries add work. No performance comparison.',
                'classificationLimits': 'Projection equality is evidence of matching captured conditions only, not historical review material, arrival, execution, or coverage.',
            })
            return archive

        def record_with_diagnostic(path, value):
            if pathlib.Path(path) == OUTPUT / 'setup.json':
                value = {**value, 'instrumentation': 'Recorded diagnostic-only runtime.ts patch in owned archive plus host/view facades. Default SDK/store/adapter methods unchanged. Additional source reads and pure projections are explicitly labeled.',
                         'comparisonLimit': 'Single diagnostic, no performance claim. Exact semantic oracle comparison without excluded fields; result is not browser restoration or step dispatch.'}
            if pathlib.Path(path) == OUTPUT / 'execution.json':
                # The epoch lifecycle writes this after reaping/deleting owned
                # files. Check the additional worker during its manifest check
                # in the intercepted manifest function below instead.
                value = {**value, 'extraScriptsUnchanged': all(sha(ROOT / name) == digest for name, digest in hashes.items()),
                         'diagnosticWorkerUnchanged': state.get('workerUnchanged', False)}
            return original_write(path, value)

        module.setup_runtime_archive = archive_with_diagnostic
        module.write = record_with_diagnostic
        return module

    def load_with_manifest_check(path, name):
        module = intercepted_load(path, name)
        if name == 'source_manifest':
            original_manifest = module.manifest

            def manifest(root):
                if state.get('workerPath') and state['workerPath'].exists():
                    state['workerUnchanged'] = sha(state['workerPath']) == state['workerHash']
                return original_manifest(root)
            module.manifest = manifest
        return module

    epoch.HERE, epoch.OUTPUT, epoch.MARKER = HERE, OUTPUT, MARKER
    epoch.load = load_with_manifest_check
    lifecycle_error = None
    try:
        epoch.main()  # The sole process; existing 240s TERM/5s/KILL/5s lifecycle.
    except BaseException as error:
        lifecycle_error = error
    # No new selector/process is started for verification. Read only artifacts
    # produced above, after the parent has confirmed exit and cleaned its temp.
    execution_path = OUTPUT / 'execution.json'
    if execution_path.exists():
        execution = json.loads(execution_path.read_text())
        verification = {'oracle': str(ORACLE.relative_to(ROOT)), 'excludedFields': [],
                        'diagnosticOnly': True, 'parentCleanupComplete': execution.get('workerExited') and execution.get('temporaryDirectoryRemoved'),
                        'extraScriptsUnchanged': execution.get('extraScriptsUnchanged'),
                        'diagnosticWorkerUnchanged': execution.get('diagnosticWorkerUnchanged')}
        artifact = execution.get('semanticArtifact')
        if artifact:
            packed = OUTPUT / artifact['path']
            observed = json.loads(gzip.decompress(packed.read_bytes()))
            mismatch = state['prior'].differences(oracle, observed)
            verification.update(completeSemanticEqual=mismatch['count'] == 0, differences=mismatch)
            if not mismatch['count']:
                packed.unlink()  # Identical complete facts are stored only once.
                execution['semanticArtifact'] = {**artifact, 'path': str(ORACLE.relative_to(OUTPUT.parent.parent)),
                    'pathBase': str(OUTPUT.parent.parent.relative_to(ROOT)), 'reusedExistingOracle': True,
                    'gzipSha256': ORACLE_GZIP_SHA}
                write(execution_path, execution)
        # Preserve the synchronous raw trace on failure/timeout. On completion,
        # gzip once and remove raw only after confirming byte identity.
        trace = OUTPUT / 'worker.jsonl'
        if trace.exists() and execution.get('workerExited'):
            packed_trace = OUTPUT / 'worker.jsonl.gz'
            with trace.open('rb') as source, packed_trace.open('xb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as target:
                shutil.copyfileobj(source, target)
            assert hashlib.sha256(gzip.decompress(packed_trace.read_bytes())).hexdigest() == sha(trace)
            verification['trace'] = {'path': packed_trace.name, 'logicalSha256': sha(trace), 'logicalBytes': trace.stat().st_size, 'gzipSha256': sha(packed_trace)}
            trace.unlink()
        write(OUTPUT / 'diagnostic-verification.json', verification)
        if not all(verification.get(key) for key in ['completeSemanticEqual', 'parentCleanupComplete', 'extraScriptsUnchanged', 'diagnosticWorkerUnchanged']):
            lifecycle_error = lifecycle_error or SystemExit(1)
    if lifecycle_error:
        raise lifecycle_error


if __name__ == '__main__':
    main()
