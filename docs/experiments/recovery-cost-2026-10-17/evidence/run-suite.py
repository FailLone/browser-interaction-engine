"""Run the complete suite on an explicit source root and retain source identity."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import sys
import time

root = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
output.mkdir(parents=True, exist_ok=True)
node = Path('/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin/node')

def snapshot():
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for top in ['packages', 'apps', 'scripts', 'tests'] for p in sorted((root/top).rglob('*'))
            if p.is_file() and 'node_modules' not in p.parts and 'dist' not in p.parts}

def write(name, value):
    (output/name).write_text(json.dumps(value, indent=2) + '\n')

revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
before = snapshot()
write('suite-source-before.json', before)
command = [str(node), str(root/'node_modules/vitest/vitest.mjs'), 'run']
started = time.time()
with (output/'full-suite.log').open('w') as stream:
    result = subprocess.run(command, cwd=root, env={**os.environ, 'PATH': str(node.parent)+':'+os.environ['PATH']}, stdout=stream, stderr=subprocess.STDOUT)
after = snapshot()
write('suite-source-after.json', after)
write('suite-result.json', {'revision': revision, 'sourceRoot': str(root), 'command': command,
                          'exitCode': result.returncode, 'startedAtEpoch': started,
                          'elapsedSeconds': time.time()-started, 'sourceUnchanged': before == after,
                          'sourceFileCount': len(before)})
print(json.dumps({'exitCode': result.returncode, 'sourceUnchanged': before == after}), flush=True)
sys.exit(result.returncode or (0 if before == after else 1))
