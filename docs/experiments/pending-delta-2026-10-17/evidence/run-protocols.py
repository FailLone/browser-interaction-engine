"""Run the four unchanged fixture protocols on an explicit isolated source root."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--root', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--revision', required=True)
parser.add_argument('--label', required=True)
args = parser.parse_args()
root, output = Path(args.root).resolve(), Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=True)
node = Path('/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin/node')
def snapshot():
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for top in ['packages', 'apps', 'scripts', 'tests'] for p in sorted((root/top).rglob('*'))
            if p.is_file() and 'node_modules' not in p.parts and 'dist' not in p.parts}
def write(name, value):
    (output/name).write_text(json.dumps(value, indent=2) + '\n')
before = snapshot()
protocols = {f'scripts/verify-exploration-{name}.ts': before[f'scripts/verify-exploration-{name}.ts']
             for name in ['conditions', 'continuation', 'input-identity', 'recovery']}
expected = json.loads((Path(__file__).parent/'baseline/setup.json').read_text())['protocolSha256']
if protocols != expected:
    raise RuntimeError('Protocol differs from the baseline; do not present as same-protocol comparison')
write('setup.json', {'revision': args.revision, 'revisionMeaning': 'Declared source label; dirty after source is identified by exact source-before/after hashes.',
                    'sourceRoot': str(root), 'protocolSha256': protocols, 'sourceFileCount': len(before)})
write('source-before.json', before)
commands = []
runs = [('conditions', ['scripts/verify-exploration-conditions.ts', f'--revision={args.revision}', f'--output={output}/conditions.json', '--runs=5', '--ticks=100']),
        ('continuation', ['scripts/verify-exploration-continuation.ts', '--label', args.label, '--revision', args.revision, '--repeats', '5', '--out', str(output/'continuation.json')]),
        ('input-identity', ['scripts/verify-exploration-input-identity.ts', '--revision', args.revision, '--runs', '5', '--output', str(output/'input-identity.json')])] + [
        ('recovery', ['scripts/verify-exploration-recovery.ts', '--variant', 'refactor', '--revision', args.revision, '--replicate', str(i), '--output', str(output/f'recovery-refactor-r{i}.json')]) for i in range(1, 6)]
try:
    for index, (name, command_args) in enumerate(runs, 1):
        started = time.time()
        command = [str(node), str(root/'node_modules/tsx/dist/cli.mjs'), '--conditions=development'] + command_args
        log = f'{index:02d}-{name}.log'
        print(f'Starting {index}: {name}', flush=True)
        with (output/log).open('w') as stream:
            result = subprocess.run(command, cwd=root, env={**os.environ, 'PATH': str(node.parent)+':'+os.environ['PATH']}, stdout=stream, stderr=subprocess.STDOUT)
        commands.append({'index': index, 'name': name, 'command': command, 'startedAtEpoch': started,
                         'elapsedSeconds': time.time()-started, 'exitCode': result.returncode, 'log': log})
        write('commands.json', commands)
        print(f'Finished {index}: {name}, exit {result.returncode}', flush=True)
        if result.returncode:
            raise RuntimeError(f'{name} failed; inspect {log}')
finally:
    after = snapshot()
    write('source-after.json', after)
    print(f'Source unchanged: {before == after}', flush=True)
if before != after:
    raise RuntimeError('Source changed while protocols were running')
