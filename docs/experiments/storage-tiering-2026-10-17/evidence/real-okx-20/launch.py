"""One owned process group, one 240-second window; no service or provider setup."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import os
import signal
import subprocess
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
NODE = Path('/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin/node')
prep = json.loads((HERE / 'preparation.json').read_text())
revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
assert revision == prep['productCommit']
subprocess.check_call(['git', 'diff', '--exit-code', 'HEAD', '--', 'packages', 'pnpm-lock.yaml'], cwd=ROOT)
assert not subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', '--', 'packages'], cwd=ROOT, text=True).strip()
assert not (HERE / 'launch.json').exists()
env = {key: os.environ[key] for key in ['HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'] if key in os.environ}
env['PATH'] = str(NODE.parent) + ':/usr/bin:/bin:/usr/sbin:/sbin'
args = [str(NODE), '--conditions=development', '--import', 'tsx', str(HERE / 'run.mts'), '--run', prep['destination']]
record = {'startedAt': datetime.now(timezone.utc).isoformat(), 'productCommit': revision,
          'limitMs': 240000, 'internalStopMs': 235000, 'args': args,
          'runnerSha256': hashlib.sha256((HERE / 'run.mts').read_bytes()).hexdigest(),
          'providerVariablesLoaded': False,
          'stopPolicy': 'At 235 seconds refuse new stages and close owned driver. At 240 seconds terminate only the new owned process group, then kill it after two seconds if necessary. Cleanup grace never counts as accepted work.'}
start = time.monotonic()
with (HERE / 'launch.log').open('x') as log:
    child = subprocess.Popen(args, cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    record['pid'] = child.pid
    (HERE / 'launch.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps({'started': True, 'pid': child.pid, 'limitMs': 240000}), flush=True)
    try:
        record['exitCode'] = child.wait(timeout=max(0, 240 - (time.monotonic() - start)))
    except subprocess.TimeoutExpired:
        record['supervisorDeadline'] = True
        record['stopRequestedMs'] = (time.monotonic() - start) * 1000
        os.killpg(child.pid, signal.SIGTERM)
        try:
            record['exitCode'] = child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            record['exitCode'] = child.wait(timeout=3)
    record['finishedAt'] = datetime.now(timezone.utc).isoformat()
    record['processElapsedMs'] = (time.monotonic() - start) * 1000
    (HERE / 'launch.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps({key: record[key] for key in ['exitCode', 'processElapsedMs', 'finishedAt']}), flush=True)
