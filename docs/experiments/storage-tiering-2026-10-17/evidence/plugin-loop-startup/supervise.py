import hashlib, json, os, pathlib, signal, subprocess, time

root = pathlib.Path(__file__).resolve().parents[5]
out = pathlib.Path(__file__).resolve().parent
source = root / '.data/okx-storage-acceptance-20261017-v8/engine'
task = out.parent / 'plugin-loop-1/task-before.json'
node = pathlib.Path('/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin/node')

def inventory():
    files = sorted(source.glob('engine.sqlite*')) + [task]
    result = {}
    for path in files:
        h = hashlib.sha256()
        with path.open('rb') as reader:
            for block in iter(lambda: reader.read(1024 * 1024), b''):
                h.update(block)
        result[str(path)] = {'bytes': path.stat().st_size, 'sha256': h.hexdigest()}
    return result

before = inventory()
assert before[str(source / 'engine.sqlite-wal')]['bytes'] == 0, 'Immutable input must have no uncheckpointed WAL'
assert not (out / 'supervisor.json').exists() and not (out / 'progress.jsonl').exists(), 'One diagnostic invocation only'
env = os.environ.copy()
env['PATH'] = str(node.parent) + ':' + env['PATH']
env['NODE_OPTIONS'] = '--conditions=development'
env['SQLITE_USE_URI'] = '1'
command = [str(node), '--conditions=development', '--import', 'tsx', str(out / 'diagnose.mts')]
started = time.monotonic()
with (out / 'process.log').open('x') as log:
    process = subprocess.Popen(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    timed_out = False
    try:
        exit_code = process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(process.pid, signal.SIGKILL)
        exit_code = process.wait()
elapsed = time.monotonic() - started
after = inventory()
try:
    os.killpg(process.pid, 0)
    process_group_gone = False
except ProcessLookupError:
    process_group_gone = True
progress = [json.loads(line) for line in (out / 'progress.jsonl').read_text().splitlines()] if (out / 'progress.jsonl').exists() else []
report = {'command': command, 'timeoutSeconds': 30, 'elapsedSeconds': elapsed, 'exitCode': exit_code, 'timedOut': timed_out,
          'status': 'partial' if timed_out else 'completed' if exit_code == 0 else 'failed',
          'sourceUnchanged': before == after, 'processGroupGone': process_group_gone,
          'before': before, 'after': after, 'progressRecords': len(progress), 'lastProgress': progress[-1] if progress else None,
          'browserStarted': False, 'taskDatabaseOpened': False}
(out / 'supervisor.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({k: report[k] for k in ['status','elapsedSeconds','exitCode','sourceUnchanged','processGroupGone','progressRecords','lastProgress']}, indent=2))
assert report['sourceUnchanged'] and process_group_gone
