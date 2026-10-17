#!/usr/bin/env python3
"""One isolated release of the read-only checkpoint recovery candidate API."""
import hashlib
import json
from pathlib import Path
import shutil
import sys

HERE = Path(__file__).resolve().parent
REVISION = 'c3a7d1a5cf08de45900b28d3aa134fbf9c600768'
REFERENCE = HERE.parent / 'step3-release-run9-fixes/runner.py'
REFERENCE_SHA = 'f9b5df66f2644dba77f28f3c66c41544e8e9dcbce6268ed40696bacb9158c395'
assert hashlib.sha256(REFERENCE.read_bytes()).hexdigest() == REFERENCE_SHA
assert not (HERE / 'reference.json').exists(), 'This checkpoint is single-use'

source = REFERENCE.read_text()
def replace_once(before, after):
    global source
    assert source.count(before) == 1, before
    source = source.replace(before, after)

# Root/core source checks already passed after the product fix. This release
# intentionally retains only build, published declarations, and compiled API.
replace_once('    source = once(source, "[(\'build\', [\'pnpm\', \'run\', \'build\']),", "[(\'final-root-core-types\', [\'pnpm\', \'run\', \'typecheck\']), (\'build\', [\'pnpm\', \'run\', \'build\']),")\n', '')
replace_once("prefix='bie-step3-release-run9-fixes-'", "prefix='bie-recovery-candidate-release-'")
replace_once("('compiled-producer-runtime-api', ['node', '.data/compiled-smoke.mjs'])", "('compiled-recovery-candidate-api', ['node', '.data/compiled-smoke.mjs'])")
replace_once('Release availability of producer injection and runtime selection changes; controlled source behavior is covered by their focused tests.',
    'Published availability of checkpointRecoveryCandidates at the fixed product commit; behavior was checked separately.')
replace_once('Root/core typecheck, one build, published declarations, compiled public imports and emitted collector seventh-argument type check.',
    'One build, published declarations, and compiled checkpoint recovery candidate API/type checks. No repeated root/core typecheck.')
(HERE / 'reference.json').write_text(json.dumps({'revision': REVISION,
    'reference': str(REFERENCE.relative_to(HERE.parent)), 'referenceSha256': REFERENCE_SHA,
    'wrapperSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    'effectiveWrapperSha256': hashlib.sha256(source.encode()).hexdigest(),
    'excluded': ['root/core source typecheck', 'behavior tests', 'receipt', 'protocol', 'performance', 'browser', 'service', 'task database'],
}, indent=2) + '\n')
namespace = {'__file__': str(Path(__file__).resolve()), '__name__': 'recovery_candidate_release'}
exec(compile(source, str(REFERENCE), 'exec'), namespace)
sys.argv = [str(Path(__file__).resolve()), '--revision', REVISION]
passed = False
try:
    namespace['main']()
    passed = True
finally:
    preparation = HERE / 'preparation.json'
    if preparation.exists():
        record = json.loads(preparation.read_text())
        owned = Path(record['ownedDirectory'])
        marker = json.loads((owned / 'ownership.json').read_text())
        assert marker['revision'] == REVISION and Path(marker['evidence']) == HERE
        assert owned.name.startswith('bie-recovery-candidate-release-')
        if passed:
            shutil.rmtree(owned)
        (HERE / 'cleanup.json').write_text(json.dumps({'revision': REVISION,
            'ownedDirectory': str(owned), 'removed': passed and not owned.exists(),
            'status': 'removed_after_success' if passed else 'retained_for_failure_diagnosis',
            'externalDependenciesRemoved': False,
        }, indent=2) + '\n')
