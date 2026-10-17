"""Freeze settled run metadata and create one temporary DB-only audit copy."""
import hashlib, json, os, pathlib, shutil, subprocess, sys, tempfile
from datetime import datetime, timezone

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[4]
SOURCE = ROOT / '.data/okx-storage-acceptance-20261017-v2'
FROZEN = ROOT / '.data/okx-storage-acceptance-20261017-v1'
def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''): h.update(block)
    return h.hexdigest()
def inventory(directory):
    rows = []
    for path in sorted(directory.rglob('*')):
        assert not path.is_symlink()
        if path.is_file(): rows.append({'path': path.relative_to(directory).as_posix(), 'bytes': path.stat().st_size, 'sha256': digest(path)})
    return rows
def tree_hash(rows): return hashlib.sha256(json.dumps(rows, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
def write(name, value):
    with (HERE / name).open('x') as stream: json.dump(value, stream, indent=2); stream.write('\n')

assert sys.argv[1:] == ['--closed-copy']
assert not (HERE / 'closed-evidence.json').exists() and not (HERE / 'audit-copy.json').exists()
active = json.loads((SOURCE / 'active-run.json').read_text())
assert active['state'] == 'finished' and active.get('finishedAt')
try: os.kill(active['pid'], 0)
except ProcessLookupError: pass
else: raise RuntimeError('Recorded PID is still live; do not freeze or stop it here')
run = SOURCE / 'runs' / active['runId']
summary = json.loads((run / 'summary.json').read_text())
assert summary['runId'] == active['runId'] and summary.get('finishedAt')
assert not summary.get('diagnosticFailure'), 'Inspect failed settlement before audit'
prior = json.loads((HERE.parent / 'real-okx-8/closed-evidence.json').read_text())
assert tree_hash(inventory(FROZEN)) == prior['sourceInventorySha256'], 'Frozen run 8 changed'
rows = inventory(SOURCE)
assert not any(row['path'].endswith(('-wal', '-shm')) for row in rows), 'Unexpected SQLite sidecars after settlement'
closed = {'at': datetime.now(timezone.utc).isoformat(), 'runId': active['runId'], 'taskId': active['taskId'],
          'source': str(SOURCE), 'runDirectory': str(run), 'sourceInventorySha256': tree_hash(rows),
          'sourceFiles': len(rows), 'sourceLogicalBytes': sum(row['bytes'] for row in rows),
          'sourceDatabase': next(row for row in rows if row['path'] == 'engine/engine.sqlite'),
          'pluginDatabase': next(row for row in rows if row['path'] == 'plugin/explorer.sqlite'),
          'summarySha256': digest(run / 'summary.json'), 'run8FrozenBytesUnchanged': True,
          'sourceCodeRevision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
          'noDatabaseOpened': True, 'retention': 'Closed evidence stays here once. No restart or migration of this frozen directory. Audit uses an exclusive temporary DB-only copy; immutable blobs remain shared with frozen run 8.'}
write('closed-evidence.json', closed)
owned = pathlib.Path(tempfile.mkdtemp(prefix='bie-run9-receipt-audit-')).resolve()
engine = owned / 'engine'; engine.mkdir()
src, dest = SOURCE / 'engine/engine.sqlite', engine / 'engine.sqlite'
shutil.copyfile(src, dest)
assert src.stat().st_ino != dest.stat().st_ino and digest(src) == digest(dest)
copy = {'at': datetime.now(timezone.utc).isoformat(), 'source': str(src), 'engineDirectory': str(engine),
        'runDirectory': str(run), 'sha256': digest(dest), 'bytes': dest.stat().st_size, 'databaseOpened': False,
        'evidenceBlobsCopied': False, 'cleanup': 'Remove the temporary audit directory after the one settled audit; source and output hashes retain reproducibility without duplicate evidence.'}
(owned / 'ownership.json').write_text(json.dumps(copy, indent=2) + '\n')
write('audit-copy.json', copy)
print(json.dumps({'engineDirectory': str(engine), 'runDirectory': str(run), 'run8Unchanged': True}))
