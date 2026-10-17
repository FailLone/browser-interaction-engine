#!/usr/bin/env python3
"""One corrected-fixture red check of 551a6b9; no DB, browser or service.

The first fixture accidentally left independent unknown debt unmapped. This
check isolates the exclusion predicate after repairing that fixture only.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
BASE = '551a6b9020b919862434346d276a21fe3d1f4ac1'
TEST = 'tests/explorer-current-source-exclusion.test.ts'


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    if sys.argv[1:] != ['--run']:
        assert not sys.argv[1:]
        print('Prepared only.')
        return
    log = HERE / 'corrected-baseline-red.log'
    assert not log.exists(), 'Do not overwrite or repeat this checkpoint'
    prior = load(HERE.parent / 'recovery-anchor-material/runner.py', 'archive_only')
    helper = load(prior.HELPER, 'manifest_only')
    lifecycle = load(HERE.parent / 'recovery-selection-profile/runner.py', 'reap_only')
    owned = Path(tempfile.mkdtemp(prefix='bie-exclusion-red-')).resolve()
    marker = 'corrected-exclusion-fixture-one-red'
    (owned / 'owner.txt').write_text(marker)
    child = None
    result = {'revision': BASE, 'fixture': TEST, 'fixtureSha256': prior.sha(ROOT / TEST),
              'workerHardDeadlineSeconds': 30, 'databaseAccess': False, 'repeats': 0}
    try:
        archive = prior.setup_runtime_archive(owned / 'source', BASE, helper)
        source = Path(archive['root'])
        (source / 'tests').mkdir()
        shutil.copy2(ROOT / TEST, source / TEST)
        shutil.copy2(ROOT / 'vitest.config.ts', source / 'vitest.config.ts')
        command = [str(prior.NODE), '--conditions=development', str(source / 'node_modules/vitest/vitest.mjs'), 'run', TEST]
        result['argv'] = command
        env = {key: os.environ[key] for key in ['HOME', 'LANG', 'LC_ALL'] if key in os.environ}
        env.update(PATH=str(prior.NODE.parent) + ':/usr/bin:/bin', CI='true', NO_COLOR='1', TMPDIR=str(owned))
        with log.open('xb') as output:
            child = subprocess.Popen(command, cwd=source, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            result['pid'] = child.pid
            try:
                result['exitCode'] = child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                result['timedOut'] = True
            finally:
                lifecycle.reap(child, result)
                result['exitCode'] = child.poll()
        result['fixtureUnchanged'] = prior.sha(ROOT / TEST) == result['fixtureSha256'] == prior.sha(source / TEST)
        result['runtimeUnchanged'] = prior.sha(source / 'packages/explorer-plugin/src/runtime.ts') == hashlib.sha256(subprocess.check_output(['git', 'show', BASE + ':packages/explorer-plugin/src/runtime.ts'], cwd=ROOT)).hexdigest()
        result['logSha256'] = prior.sha(log)
    finally:
        lifecycle.reap(child, result)
        result['workerExited'] = child is None or child.poll() is not None
        assert (owned / 'owner.txt').read_text() == marker
        if result['workerExited']:
            shutil.rmtree(owned)
        result['temporaryDirectoryRemoved'] = not owned.exists()
        (HERE / 'corrected-baseline-red.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
