#!/usr/bin/env python3
"""Prepared runner. Execute only after root supplies the final SHA and CPU window.

Only output destinations and declared revision change from the original commands.
No protocol, fixture, oracle or summary projection is modified.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path('/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine')
BASE = ROOT / 'docs/experiments/storage-tiering-2026-10-17/evidence/run7-selection-protocols'
OUT = BASE.parent / 'run7-fixes-protocols'
NODE = '/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin/node'
BASE_SHA = 'cbd5b878329f8d3e454e8fd5110d0e2da4f749a7'

def read(path):
    return json.loads(path.read_text())

def save(name, data):
    (OUT / name).write_text(json.dumps(data, indent=2) + '\n')

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()

def sources():
    paths = subprocess.check_output(['rg', '--files', 'packages', 'apps', 'scripts', 'tests'], cwd=ROOT, text=True).splitlines()
    return {p: sha(ROOT / p) for p in sorted(paths) if '/dist/' not in p and '/node_modules/' not in p}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-revision', required=True, help='Full final commit explicitly supplied by root')
    parser.add_argument('--cpu-released', action='store_true', required=True, help='Run only after root releases the CPU window')
    args = parser.parse_args()
    expected = args.expected_revision
    assert re.fullmatch(r'[0-9a-f]{40}', expected), 'A full final SHA is required'
    assert git('rev-parse', 'HEAD') == expected, 'HEAD differs from authorized final revision'
    assert not git('diff', 'HEAD', '--name-only', '--', 'packages', 'apps', 'scripts', 'tests'), 'Product/source tree is dirty'
    assert not git('ls-files', '--others', '--exclude-standard', '--', 'packages', 'apps', 'scripts', 'tests'), 'Untracked source files would affect snapshot'
    assert read(OUT / '.protocol-owned.json')['output'] == str(OUT)
    assert not (OUT / 'commands.json').exists(), 'Refuse to overwrite a prior run'
    prep = read(OUT / 'preparation.json')
    assert prep['status'] == 'prepared-not-run'
    assert prep['expectedFinalRevision'] == expected, 'Revision was not bound by root during preparation'
    assert sha(BASE / 'commands.json') == prep['baselineCommandSha256']
    assert sha(OUT / 'summarize.py') == prep['summarizerSha256'] == sha(BASE / 'summarize.py')
    for path, digest in prep['originalProtocolScriptSha256'].items():
        assert sha(ROOT / path) == digest, f'Original protocol changed: {path}'
    before = sources()
    save('source-before.json', {'revision': expected, 'files': before})
    save('authorization.json', {'revision': expected, 'cpuReleased': True, 'baselineRequestedRevision': prep['baselineRequestedRevision'],
        'baselineActualProtocolRevision': BASE_SHA, 'atEpoch': time.time(), 'noPerformanceConclusion': True})
    commands, analyses, fatal = [], [], None
    env = dict(os.environ)
    env['PATH'] = str(Path(NODE).parent) + ':' + env.get('PATH', '')
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    try:
        for old in read(BASE / 'commands.json'):
            assert git('rev-parse', 'HEAD') == expected, 'Revision changed between protocols'
            command = [arg.replace(str(BASE), str(OUT)).replace(BASE_SHA, expected) for arg in old['command']]
            record = {'index': old['index'], 'name': old['name'], 'command': command, 'startedAtEpoch': time.time(), 'log': old['log']}
            print(json.dumps({'started': record['name'], 'index': record['index']}), flush=True)
            with (OUT / record['log']).open('w') as log:
                result = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
            record.update(exitCode=result.returncode, elapsedSeconds=time.time() - record['startedAtEpoch'])
            commands.append(record)
            save('commands.json', commands)
            print(json.dumps({'finished': record['name'], 'index': record['index'], 'exitCode': result.returncode}), flush=True)
            if result.returncode:
                raise RuntimeError('Original protocol failed; raw failure is retained and the oracle is unchanged')
    except Exception as error:
        fatal = str(error)
    finally:
        after, after_revision = sources(), git('rev-parse', 'HEAD')
        save('source-after.json', {'revision': expected, 'files': after})
        unchanged = before == after and expected == after_revision
        save('execution.json', {'revision': expected, 'sourceUnchanged': unchanged, 'afterRevision': after_revision,
            'commands': len(commands), 'allExitZero': len(commands) == 8 and all(c['exitCode'] == 0 for c in commands), 'fatal': fatal})
    if fatal or not unchanged:
        print(json.dumps({'fatal': fatal, 'sourceUnchanged': unchanged}), flush=True)
        return 1
    for name, command, logname in [
        ('original-summary', [sys.executable, str(OUT / 'summarize.py'), '--input-dir', str(OUT), '--baseline-dir', str(BASE), '--output-dir', str(OUT)], 'summary-run7-fixes.log'),
        ('original-trial-projection', [sys.executable, str(OUT / 'compare-trials.py')], 'trial-comparison.log'),
    ]:
        with (OUT / logname).open('w') as log:
            result = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        analyses.append({'name': name, 'command': command, 'stdoutAndStderr': logname, 'exitCode': result.returncode})
        save('analysis-commands.json', analyses)
        print(json.dumps({'analysis': name, 'exitCode': result.returncode}), flush=True)
        # Run the trial diff even when the original summary oracle rejects a
        # result; preserve that rejection and all diagnostic differences.
    return 0 if all(r['exitCode'] == 0 for r in analyses) else 2

if __name__ == '__main__':
    sys.exit(main())
