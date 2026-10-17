#!/usr/bin/env python3
"""One frozen release check for the run9 producer/runtime fixes; no receipt batch."""
import argparse
import hashlib
import json
from pathlib import Path
import runpy
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
COMPACT = HERE.parent / 'step3-release-compact-v3/runner.py'
BASE = HERE.parent / 'step3-release-7c1bf9c/runner.py'
REFERENCES = {
    str(COMPACT.relative_to(ROOT)): '970eb3fcd1ba1627e3f1bc082b2970c596f2b32c1a9a1d7a7d177aa0846b2663',
    str(BASE.relative_to(ROOT)): '2f25132b9b412ebe4ee570e712df455e6a277f88e55cbfc6d6ecb38cd779818b',
}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--revision', required=True, help='Parent-authorized frozen 40-character commit')
    args = parser.parse_args()
    assert len(args.revision) == 40 and all(c in '0123456789abcdef' for c in args.revision)
    assert subprocess.check_output(['git', 'rev-parse', args.revision], cwd=ROOT, text=True).strip() == args.revision
    assert not (HERE / 'preparation.json').exists(), 'Do not repeat or overwrite a completed/attempted checkpoint'
    for name, expected in REFERENCES.items():
        assert hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == expected, f'Changed reference {name}'
    helpers = runpy.run_path(str(COMPACT))  # Load immutable helpers; its main is not called.
    once, sha = helpers['once'], helpers['sha']
    source = BASE.read_text()
    source = once(source, "REVISION = '7c1bf9c25fbba0d2302db68e765e68bfffd61866'", f"REVISION = '{args.revision}'")
    source = once(source, "prefix='bie-step3-release-7c1bf9c-'", "prefix='bie-step3-release-run9-fixes-'")
    source = once(source, "seed = HERE.parent / 'receipt-condition-batch/fixture.json.gz'\nreference = HERE.parent / 'receipt-condition-batch/baseline-fixed.json'\n", '')
    source = once(source, "env['BIE_RELEASE_FIXTURE'] = str(seed)\nenv['BIE_RELEASE_REFERENCE'] = str(reference)\n", '')
    source = once(source, "'fixtureSha256': sha(seed), 'referenceSha256': sha(reference),", "'reusedCheckpoints': INPUTS,")
    source = once(source, "[('build', ['pnpm', 'run', 'build']),", "[('final-root-core-types', ['pnpm', 'run', 'typecheck']), ('build', ['pnpm', 'run', 'build']),")
    source = once(source, "('compiled-receipt-api', ['node', '.data/compiled-smoke.mjs'])", "('compiled-producer-runtime-api', ['node', '.data/compiled-smoke.mjs'])")
    inputs = {'revision': args.revision, 'referenceSha256': REFERENCES,
        'wrapperSha256': sha(Path(__file__)), 'compiledSmokeSha256': sha(HERE / 'compiled-smoke.mjs'),
        'effectiveRunnerSha256': hashlib.sha256(source.encode()).hexdigest(),
        'purpose': 'Release availability of producer injection and runtime selection changes; controlled source behavior is covered by their focused tests.',
        'scope': 'One fixed git archive, workspace links within archive, borrowed external dependencies. Root/core typecheck, one build, published declarations, compiled public imports and emitted collector seventh-argument type check.',
        'excluded': ['retained receipt fixture/batch', 'browser', 'service', 'task database', 'full protocol', 'performance claims']}
    (HERE / 'wrapper-inputs.json').write_text(json.dumps(inputs, indent=2) + '\n')
    namespace = {'__file__': str(Path(__file__).resolve()), '__name__': '__main__', 'INPUTS': inputs}
    exec(compile(source, str(BASE), 'exec'), namespace)

if __name__ == '__main__':
    main()
