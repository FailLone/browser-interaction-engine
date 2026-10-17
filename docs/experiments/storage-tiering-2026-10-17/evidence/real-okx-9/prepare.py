"""Create one continuation workspace; retain run 8 once, without opening its DBs."""
import hashlib, json, os, pathlib, shutil, subprocess, sys, uuid
from datetime import datetime, timezone

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[4]
SOURCE = ROOT / '.data/okx-storage-acceptance-20261017-v1'
DEST = ROOT / '.data/okx-storage-acceptance-20261017-v2'
RECORD = HERE / 'preparation.json'

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def inventory(directory):
    rows = []
    for path in sorted(directory.rglob('*')):
        assert not path.is_symlink(), 'Unexpected symlink in frozen source'
        if path.is_file():
            rows.append({'path': path.relative_to(directory).as_posix(), 'bytes': path.stat().st_size, 'sha256': digest(path)})
    return rows

def inventory_hash(rows):
    return hashlib.sha256(json.dumps(rows, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

assert len(sys.argv) == 3 and sys.argv[1] == '--prepare', 'Explicit --prepare <verified revision> required'
revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
assert sys.argv[2] == revision
assert not DEST.exists() and not RECORD.exists(), 'Never replace an existing continuation workspace or evidence'
closed = json.loads((HERE.parent / 'real-okx-8/closed-evidence.json').read_text())
control = json.loads((SOURCE / 'active-run.json').read_text())
assert control['state'] == 'finished' and control['runId'] == closed['runId']
try:
    os.kill(control['pid'], 0)
except ProcessLookupError:
    pass
else:
    raise RuntimeError('Recorded process ID is live; inspect before preparing, never stop it here')
before = inventory(SOURCE)
assert inventory_hash(before) == closed['sourceInventorySha256'], 'Frozen source has changed'
assert not any(row['path'].endswith(('-wal', '-shm')) for row in before)
DEST.mkdir(mode=0o700)
copied, linked = [], []
for row in before:
    rel = pathlib.PurePosixPath(row['path'])
    if rel.parts[0] not in ('engine', 'plugin') or '.coordination' in rel.parts:
        continue
    source, target = SOURCE / rel, DEST / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    # FileEvidenceStore publishes blobs by atomic rename and only unlinks them
    # during GC. Linking immutable content leaves a single retained byte copy;
    # every mutable SQLite file, manifest and control record remains independent.
    immutable = rel.parts[:3] == ('engine', 'evidence', 'blobs') and source.suffix in ('.gz', '.bin')
    if immutable:
        os.link(source, target)
        linked.append(row['path'])
    else:
        shutil.copyfile(source, target)
        copied.append(row['path'])
    assert target.stat().st_size == row['bytes'] and digest(target) == row['sha256']
    if not immutable:
        assert source.stat().st_ino != target.stat().st_ino
marker = json.loads((SOURCE / 'owner.json').read_text())
marker.update(directory=str(DEST), owner=str(uuid.uuid4()), createdAt=datetime.now(timezone.utc).isoformat())
(DEST / 'owner.json').write_text(json.dumps(marker, indent=2) + '\n')
after = inventory(SOURCE)
assert after == before, 'Preparing continuation changed frozen source bytes'
result = {'revision': revision, 'at': datetime.now(timezone.utc).isoformat(), 'source': str(SOURCE), 'destination': str(DEST),
          'sourceInventorySha256': inventory_hash(before), 'sourceUnchanged': True, 'taskId': marker['taskId'],
          'mutableFilesCopied': copied, 'immutableBlobsHardLinked': len(linked),
          'retainedEvidence': 'Run 8 remains frozen. Old run exports are referenced in place, not copied. Blob bytes are shared by hard link; GC of the working link cannot delete the frozen link.',
          'databaseOpened': False, 'taskBudgetOrUsageChanged': False, 'browserStarted': False}
RECORD.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({k: result[k] for k in ('destination', 'taskId', 'sourceUnchanged', 'immutableBlobsHardLinked')}))
