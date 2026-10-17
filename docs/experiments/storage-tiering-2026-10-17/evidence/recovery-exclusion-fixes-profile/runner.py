#!/usr/bin/env python3
"""Prepare only. Fixed post-fix commit is required before one authorized --run.
One frozen-input selector + actual selected.revalidate, <=240 seconds; no dispatch.
SDK/store/adapter/plugin product sources stay unchanged. No predicate injection.
"""
import difflib
import gzip
import hashlib
import importlib.util
import json
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[4]
EPOCH = HERE.parent / 'recovery-selection-epoch-profile'
DIAGNOSTIC = HERE.parent / 'recovery-selection-exclusion-diagnostic/result'
ORACLE = EPOCH / 'result/semantic-264bde57836f0ab768bb49251eeb31ec5cba844f252a62f2ca1e2c07ee66e5d6.json.gz'
OUTPUT = HERE / 'result'
CANDIDATE = '63c57e5b435864cf4948afe385b50e479e849a67'
MARKER = 'recovery-exclusion-fixes-profile/run12/one-240s-v1'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def forwarding_worker(original):
    """Add only outer forwarding/counts; preserve default SDK function identity."""
    text = original
    changes = []

    def replace(old, new, label):
        nonlocal text
        assert text.count(old) == 1, (label, text.count(old))
        text = text.replace(old, new, 1)
        changes.append(label)

    replace("'recoveryAnchorMaterial', 'recoverySelectionView', 'checkpointRecoveryCandidates'",
            "'recoveryAnchorMaterial', 'recoveryReviewMaterial', 'recoverySelectionView', 'checkpointRecoveryCandidates'", 'optional host read allowed')
    replace("const read = (method: 'source' | 'anchor', observationId: string)",
            "const read = (method: 'source' | 'anchor' | 'reviewMaterial', observationId: string)", 'view review forwarding type')
    replace("        if (method === 'source') quantity('view.source.returnedActions', result.actions.length);",
            "        if (method === 'source') quantity('view.source.returnedActions', result.actions.length);\n        if (method === 'reviewMaterial') quantity('view.reviewMaterial.returnedControls', result.controls.length);", 'view actual material quantities')
    replace("      ...(view.anchor ? { anchor: (id: string) => read('anchor', id) } : {}),",
            "      ...(view.anchor ? { anchor: (id: string) => read('anchor', id) } : {}),\n      ...(view.reviewMaterial ? { reviewMaterial: (id: string) => read('reviewMaterial', id) } : {}),", 'optional view read forwarded')
    replace("      if (name === 'checkpointRecoveryCandidates') { quantity",
            "      if (name === 'recoveryReviewMaterial') idCount('host.recoveryReviewMaterial.observationId', input?.observationId);\n      if (name === 'checkpointRecoveryCandidates') { quantity", 'host review IDs counted')
    replace("        if (name === 'recoverySourceMaterial') quantity(`host.${name}.returnedActions`, result?.actions?.length ?? 0);",
            "        if (name === 'recoverySourceMaterial') quantity(`host.${name}.returnedActions`, result?.actions?.length ?? 0);\n        if (name === 'recoveryReviewMaterial') quantity('host.recoveryReviewMaterial.returnedControls', result?.controls?.length ?? 0);", 'host actual material quantities')
    return text, changes


def main():
    if sys.argv[1:] != ['--run']:
        assert not sys.argv[1:], 'Only --run is supported'
        print('Prepared only; no frozen commit assigned, archive, DB copy/open, or worker execution.')
        return
    assert isinstance(CANDIDATE, str) and re.fullmatch('[0-9a-f]{40}', CANDIDATE), 'Freeze and review the product commit first'
    assert not OUTPUT.exists(), 'One sample only; do not overwrite or rerun'
    assert sha(ORACLE) == '0338dff992c98dcaeafb9eede052504622a67dc59f2659e3cdfa867ec19f1730'
    old_semantic = json.loads(gzip.decompress(ORACLE.read_bytes()))
    diagnostic_verification = json.loads((DIAGNOSTIC / 'diagnostic-verification.json').read_text())
    diagnostic_trace = DIAGNOSTIC / diagnostic_verification['trace']['path']
    assert sha(diagnostic_trace) == diagnostic_verification['trace']['gzipSha256']
    prior_present = []
    with gzip.open(diagnostic_trace, 'rt') as source:
        for line in source:
            row = json.loads(line)
            if row.get('event') == 'diagnostic' and row.get('kind') == 'explanation.present':
                prior_present.append((row['data']['itemId'], row['data']['sourceId']))
    assert len(prior_present) == 72
    epoch = load(EPOCH / 'runner.py', 'postfix_epoch_lifecycle')
    original_load = epoch.load
    tracked = [HERE / 'runner.py', HERE / 'worker.ts', EPOCH / 'runner.py', EPOCH / 'worker.ts', ORACLE,
               DIAGNOSTIC / 'diagnostic-verification.json', diagnostic_trace]
    hashes = {str(path.relative_to(ROOT)): sha(path) for path in tracked}
    state = {}

    def intercepted_load(path, name):
        module = original_load(path, name)
        if name == 'source_manifest':
            original_manifest = module.manifest

            def checked_manifest(root):
                if state.get('workerPath') and state['workerPath'].exists():
                    state['workerUnchanged'] = sha(state['workerPath']) == state['workerHash']
                return original_manifest(root)
            module.manifest = checked_manifest
        if name != 'anchor_archive':
            return module
        state['prior'] = module
        original_archive, original_write = module.setup_runtime_archive, module.write

        def archive(path, revision, helper):
            result = original_archive(path, revision, helper)
            assert revision == CANDIDATE
            original_worker = (EPOCH / 'worker.ts').read_text()
            worker, changes = forwarding_worker(original_worker)
            state['workerPath'] = path / '.data/base-worker.ts'
            state['workerPath'].write_text(worker)
            state['workerHash'] = sha(state['workerPath'])
            patch = OUTPUT / 'worker.forwarding.patch'
            patch.write_text(''.join(difflib.unified_diff(original_worker.splitlines(True), worker.splitlines(True),
                fromfile='epoch-worker.ts', tofile='owned-forwarding-worker.ts')))
            assert helper.manifest(path) == result['sourceManifest'], 'No archived product source may change'
            result['instrumentation'] = {'productFilesChanged': [], 'workerForwardingChanges': changes,
                'baseWorkerReference': str((EPOCH / 'worker.ts').relative_to(ROOT)), 'baseWorkerSha256': hashes[str((EPOCH / 'worker.ts').relative_to(ROOT))],
                'instrumentedBaseWorkerSha256': state['workerHash'], 'patch': patch.name, 'patchSha256': sha(patch), 'extraProtectedFiles': hashes}
            return result

        def record(path, value):
            if pathlib.Path(path) == OUTPUT / 'setup.json':
                value = {**value, 'instrumentation': 'Host/view facades only; optional recoveryReviewMaterial/reviewMaterial forwarded and counted. All product sources and default method identities unchanged.',
                    'comparisonLimit': 'Behavior intentionally changes. Earlier selected return can reduce examined work, so elapsed time/read reduction is not a pure performance gain. No browser restoration or dispatch.'}
            if pathlib.Path(path) == OUTPUT / 'execution.json':
                value = {**value, 'extraScriptsUnchanged': all(sha(ROOT / name) == digest for name, digest in hashes.items()),
                    'forwardingWorkerUnchanged': state.get('workerUnchanged', False)}
            return original_write(path, value)

        module.setup_runtime_archive, module.write = archive, record
        return module

    epoch.HERE, epoch.OUTPUT, epoch.MARKER, epoch.CANDIDATE = HERE, OUTPUT, MARKER, CANDIDATE
    epoch.load = intercepted_load
    error = None
    try:
        epoch.main()  # One existing 240s TERM/5s/KILL/5s lifecycle, then cleanup.
    except BaseException as failure:
        error = failure
    execution_path = OUTPUT / 'execution.json'
    if execution_path.exists():
        execution = json.loads(execution_path.read_text())
        verification = {'oldSemanticReference': str(ORACLE.relative_to(ROOT)), 'excludedFields': [],
            'expectedSemanticIdentity': False, 'parentCleanupComplete': execution.get('workerExited') and execution.get('temporaryDirectoryRemoved'),
            'extraScriptsUnchanged': execution.get('extraScriptsUnchanged'), 'forwardingWorkerUnchanged': execution.get('forwardingWorkerUnchanged'),
            'comparisonLimit': 'Different selection stopping point/actual work prohibits a pure speedup conclusion.'}
        artifact = execution.get('semanticArtifact')
        if artifact:
            packed = OUTPUT / artifact['path']
            current = json.loads(gzip.decompress(packed.read_bytes()))
            differences = state['prior'].differences(old_semantic, current)
            selection = current['selection']
            verification.update(semanticDifferences=differences,
                topLevelChangedKeys=[key for key in current if old_semantic.get(key) != current[key]],
                selected=({ 'itemId': selection['itemId'], 'sourceId': selection['source']['id'], 'checkpointId': selection['frame']['checkpointId'],
                    'itemPreviouslyRejectedAsPresent': any(item == selection['itemId'] for item, source in prior_present),
                    'exactPairPreviouslyRejectedAsPresent': (selection['itemId'], selection['source']['id']) in prior_present} if selection else None),
                callback=current['callback'])
            if selection:
                assert current['callback'] == {'present': True, 'invoked': True, 'status': 'passed'}, 'Actual pure revalidate must pass for a selected result'
            if differences['count'] == 0:
                packed.unlink()
                execution['semanticArtifact'] = {**artifact, 'path': str(ORACLE.relative_to(OUTPUT.parent.parent)),
                    'pathBase': str(OUTPUT.parent.parent.relative_to(ROOT)), 'reusedExistingOracle': True, 'gzipSha256': sha(ORACLE)}
                write(execution_path, execution)
        write(OUTPUT / 'verification.json', verification)
        if not all(verification.get(key) for key in ['parentCleanupComplete', 'extraScriptsUnchanged', 'forwardingWorkerUnchanged']):
            error = error or SystemExit(1)
    if error:
        raise error


if __name__ == '__main__':
    main()
