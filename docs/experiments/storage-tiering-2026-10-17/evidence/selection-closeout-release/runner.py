#!/usr/bin/env python3
"""One bounded release checkpoint; reuse the archived build/link setup only."""
import hashlib
import json
from pathlib import Path
import shutil

HERE = Path(__file__).resolve().parent
REVISION = 'd11b4f32c19620fd9581eb3d5cd5486811af50f0'
REFERENCE = HERE.parent / 'step3-release-7c1bf9c/runner.py'
REFERENCE_SHA = '2f25132b9b412ebe4ee570e712df455e6a277f88e55cbfc6d6ecb38cd779818b'
assert hashlib.sha256(REFERENCE.read_bytes()).hexdigest() == REFERENCE_SHA
assert not (HERE / 'reference.json').exists(), 'Single-use checkpoint: do not overwrite evidence'
source = REFERENCE.read_text()

def once(before, after):
    global source
    assert source.count(before) == 1, before
    source = source.replace(before, after, 1)

once("REVISION = '7c1bf9c25fbba0d2302db68e765e68bfffd61866'", f"REVISION = '{REVISION}'")
once("prefix='bie-step3-release-7c1bf9c-'", "prefix='bie-selection-closeout-'")
once("seed = HERE.parent / 'receipt-condition-batch/fixture.json.gz'\nreference = HERE.parent / 'receipt-condition-batch/baseline-fixed.json'\n", '')
once("env['BIE_RELEASE_FIXTURE'] = str(seed)\nenv['BIE_RELEASE_REFERENCE'] = str(reference)\n", '')
once("'fixtureSha256': sha(seed), 'referenceSha256': sha(reference),", "'releaseInputs': INPUTS,")
once("('compiled-receipt-api', ['node', '.data/compiled-smoke.mjs'])", "('compiled-selection-api', ['node', '.data/compiled-smoke.mjs'])")
once('result = subprocess.run(command, cwd=archive, env=env, stdout=log, stderr=subprocess.STDOUT)',
     'result = subprocess.run(command, cwd=archive, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=90)')
inputs = {'revision': REVISION, 'reference': str(REFERENCE.relative_to(HERE.parent)), 'referenceSha256': REFERENCE_SHA,
          'runnerSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          'compiledSmokeSha256': hashlib.sha256((HERE / 'compiled-smoke.mjs').read_bytes()).hexdigest(),
          'effectiveRunnerSha256': hashlib.sha256(source.encode()).hexdigest(),
          'scope': 'One isolated fixed archive, one build, published types and compiled API; no source-test reruns, browser, service or task database.'}
(HERE / 'reference.json').write_text(json.dumps(inputs, indent=2) + '\n')
passed = False
try:
    exec(compile(source, str(REFERENCE), 'exec'), {'__file__': str(Path(__file__).resolve()), '__name__': '__main__', 'INPUTS': inputs})
    passed = True
finally:
    preparation = HERE / 'preparation.json'
    if preparation.exists():
        record = json.loads(preparation.read_text())
        owned = Path(record['ownedDirectory'])
        marker = json.loads((owned / 'ownership.json').read_text())
        assert marker['revision'] == REVISION and Path(marker['evidence']) == HERE
        assert owned.name.startswith('bie-selection-closeout-')
        if passed:
            shutil.rmtree(owned)
        (HERE / 'cleanup.json').write_text(json.dumps({'revision': REVISION, 'ownedDirectory': str(owned),
            'removed': passed and not owned.exists(), 'externalDependenciesRemoved': False,
            'status': 'removed_after_success' if passed else 'retained_for_failure_diagnosis'}, indent=2) + '\n')
