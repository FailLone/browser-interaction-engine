#!/usr/bin/env python3
"""Run the unchanged release flow once for the guarded review-defer commit."""
import hashlib
import json
from pathlib import Path
import runpy
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
REVISION = 'f3c43168812ab414e31a42ae3f237450abb8acfb'
REFERENCE = HERE.parent / 'step3-release-run9-fixes'
HASHES = {
    'runner.py': 'f9b5df66f2644dba77f28f3c66c41544e8e9dcbce6268ed40696bacb9158c395',
    'compiled-smoke.mjs': '27268c31929bfddcf509bd57154d5d9400980aa146ac252d5b924c26fb45c5f2',
}

assert not (HERE / 'wrapper-inputs.json').exists(), 'This checkpoint is single-use'
for name, expected in HASHES.items():
    assert hashlib.sha256((REFERENCE / name).read_bytes()).hexdigest() == expected, f'Changed reference {name}'
# Retain a relative reference in the evidence directory rather than duplicating
# the smoke source or any old fixture. The reused runner copies this one program
# into its owned archive so imports resolve only to that archive's dist outputs.
(HERE / 'compiled-smoke.mjs').symlink_to('../step3-release-run9-fixes/compiled-smoke.mjs')
(HERE / 'reference.json').write_text(json.dumps({
    'revision': REVISION, 'reusedDirectory': '../step3-release-run9-fixes', 'referenceSha256': HASHES,
    'wrapperSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    'purpose': 'Build publication artifacts containing the guarded current_review_occurrence_present item defer.',
    'scope': 'Unchanged root/core types, build, public declarations and compiled API checks. No receipt, protocol, performance, browser, service or persistent database checks.',
}, indent=2) + '\n')
run = runpy.run_path(str(REFERENCE / 'runner.py'))['main']
run.__globals__.update(HERE=HERE, ROOT=ROOT, __file__=str(Path(__file__).resolve()))
sys.argv = [str(Path(__file__).resolve()), '--revision', REVISION]
run()
