#!/usr/bin/env python3
"""Reuse the immutable release checkpoint against one explicitly supplied commit.

Prepare only until the parent confirms static admission. No browser or task DB.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
REFERENCE = HERE.parent / 'step3-release-7c1bf9c'
HASHES = {
    'runner.py': '2f25132b9b412ebe4ee570e712df455e6a277f88e55cbfc6d6ecb38cd779818b',
    'compiled-smoke.mjs': '39ea468b664b941510e49f3e9dbc7cb5c1326d9467f56f82f4058784c7a134da',
}

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def once(source, old, new):
    assert source.count(old) == 1, f'Reference changed: {old}'
    return source.replace(old, new, 1)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--revision', required=True, help='Full 40-character frozen commit SHA')
    args = parser.parse_args()
    assert len(args.revision) == 40 and all(c in '0123456789abcdef' for c in args.revision)
    assert subprocess.check_output(['git', 'rev-parse', args.revision], cwd=ROOT, text=True).strip() == args.revision
    assert not (HERE / 'preparation.json').exists(), 'Use a new checkpoint rather than overwrite an attempted release'
    for name, expected in HASHES.items():
        assert sha(REFERENCE / name) == expected, f'Changed reference {name}'
    source = (REFERENCE / 'runner.py').read_text()
    source = once(source, "REVISION = '7c1bf9c25fbba0d2302db68e765e68bfffd61866'", f"REVISION = '{args.revision}'")
    source = once(source, "prefix='bie-step3-release-7c1bf9c-'", "prefix='bie-step3-release-compact-v3-'")
    copy = "shutil.copy2(HERE / 'compiled-smoke.mjs', archive / '.data/compiled-smoke.mjs')"
    source = once(source, copy, "shutil.copy2(REFERENCE_SMOKE, archive / '.data/legacy-compiled-smoke.mjs')\n" + copy)
    source = once(source, "[('build', ['pnpm', 'run', 'build']),", "[('final-root-core-types', ['pnpm', 'run', 'typecheck']), ('build', ['pnpm', 'run', 'build']),")
    inputs = {'revision': args.revision, 'referenceDirectory': str(REFERENCE), 'referenceSha256': HASHES,
        'staticAdmission': {'path': '../compact-profile-admission/result.json', 'sha256': sha(HERE.parent / 'compact-profile-admission/result.json')},
        'wrapperSha256': sha(Path(__file__)), 'compiledWrapperSha256': sha(HERE / 'compiled-smoke.mjs'),
        'effectiveRunnerSha256': hashlib.sha256(source.encode()).hexdigest(),
        'scope': 'One fixed archive. Internal workspace links stay in archive; borrowed external dependencies. One build, final root/core types, published types, compiled legacy receipts plus compact codec. No browser, service, persistent database, or performance claim.'}
    (HERE / 'wrapper-inputs.json').write_text(json.dumps(inputs, indent=2) + '\n')
    os.environ['BIE_RELEASE_CODEC_RESULT'] = str(HERE / 'compiled-codec.json')
    namespace = {'__file__': str(Path(__file__).resolve()), '__name__': '__main__', 'REFERENCE_SMOKE': REFERENCE / 'compiled-smoke.mjs'}
    exec(compile(source, str(REFERENCE / 'runner.py'), 'exec'), namespace)
    validation = json.loads((HERE / 'validation.json').read_text())
    validation['reusedCheckpoint'] = inputs
    validation['compiledCodecSha256'] = sha(HERE / 'compiled-codec.json')
    (HERE / 'validation.json').write_text(json.dumps(validation, indent=2) + '\n')

if __name__ == '__main__':
    main()
