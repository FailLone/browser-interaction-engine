"""Validate the final budget correction and related recovery/storage boundaries."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import sys
import time

root, output = map(lambda x: Path(x).resolve(), sys.argv[1:3])
output.mkdir(parents=True, exist_ok=True)
node = Path('/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin/node')
env = dict(os.environ, PATH=str(node.parent)+':'+os.environ['PATH'])
revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
def snapshot():
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for top in ['packages', 'apps', 'scripts', 'tests'] for p in sorted((root/top).rglob('*'))
            if p.is_file() and 'node_modules' not in p.parts and 'dist' not in p.parts}
def save(name, value):
    (output/name).write_text(json.dumps(value, indent=2)+'\n')
before = snapshot()
save('source-before.json', before)
tests = ['recovery-route-cost', 'recovery-route-alternatives', 'exploration-target-reach',
         'exploration-recovery', 'grouped-navigation-path', 'navigation-cost', 'navigation-index',
         'entity-changes', 'retention', 'storage-contract', 'architecture', 'observation-stability-window']
commands = [('typecheck', [str(node), str(root/'node_modules/typescript/bin/tsc'), '--noEmit']),
            ('core-typecheck', [str(node), str(root/'node_modules/typescript/bin/tsc'), '-p', 'packages/core/tsconfig.json']),
            ('related-tests', [str(node), str(root/'node_modules/vitest/vitest.mjs'), 'run'] + ['tests/'+t+'.test.ts' for t in tests])]
results = []
try:
    for name, command in commands:
        started = time.time()
        with (output/(name+'.log')).open('w') as stream:
            result = subprocess.run(command, cwd=root, env=env, stdout=stream, stderr=subprocess.STDOUT)
        results.append({'name': name, 'command': command, 'exitCode': result.returncode, 'elapsedSeconds': time.time()-started})
        print(json.dumps(results[-1]), flush=True)
        if result.returncode: raise RuntimeError(name+' failed')
finally:
    after = snapshot()
    save('source-after.json', after)
    save('summary.json', {'revision': revision, 'sourceRoot': str(root), 'sourceUnchanged': before == after,
                          'sourceFileCount': len(before), 'results': results})
assert before == after, 'Source changed during validation'
