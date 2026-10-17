"""Explicit, parameterized continuation file operations; never opens SQLite.

The copy/settlement rules are retained from run9 prepare.py / close-and-copy.py.
This replaces the nested text wrappers with one helper used by both entrypoints.
Nothing executes merely by importing this module.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tempfile
import uuid
from datetime import datetime, timezone

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def inventory(directory):
    rows = []
    for path in sorted(directory.rglob('*')):
        assert not path.is_symlink(), 'Unexpected symlink in owned evidence'
        if path.is_file():
            rows.append({'path': path.relative_to(directory).as_posix(),
                         'bytes': path.stat().st_size, 'sha256': digest(path)})
    return rows


def tree_hash(rows):
    return hashlib.sha256(json.dumps(rows, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def write_once(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')


def context():
    config = json.loads((HERE / 'window.json').read_text())
    source, destination = ROOT / config['source'], ROOT / config['destination']
    assert source.parent == ROOT / '.data' and destination.parent == ROOT / '.data'
    assert config['window'] == 12 and source != destination
    prior_path = (HERE / config['priorClosedEvidence']).resolve()
    assert digest(prior_path) == config['priorClosedEvidenceSha256'], 'Frozen closure metadata changed'
    prior = json.loads(prior_path.read_text())
    assert prior['runId'] == config['priorRunId'] and prior['source'] == str(source)
    return config, source, destination, prior


def verified_revision(config, requested):
    git = lambda *args: subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()
    revision = git('rev-parse', 'HEAD')
    assert requested == revision == git('rev-parse', 'main'), 'Requested revision must equal HEAD and merged main'
    subprocess.check_call(['git', 'merge-base', '--is-ancestor', config['productCommit'], revision], cwd=ROOT)
    subprocess.check_call(['git', 'merge-base', '--is-ancestor', config['publishedMainCommit'], revision], cwd=ROOT)
    subprocess.check_call(['git', 'diff', '--exit-code', config['publishedMainCommit'], revision, '--', 'packages', config['runner'], 'pnpm-lock.yaml'], cwd=ROOT)
    subprocess.check_call(['git', 'diff', '--exit-code', 'HEAD', '--', 'packages', config['runner'], 'pnpm-lock.yaml'], cwd=ROOT)
    assert not git('ls-files', '--others', '--exclude-standard', '--', 'packages', config['runner'], 'pnpm-lock.yaml'), 'Untracked runtime input'
    assert digest(ROOT / config['runner']) == config['runnerSha256'], 'Acceptance protocol changed'
    return revision


def finished(directory):
    active = json.loads((directory / 'active-run.json').read_text())
    assert active['state'] == 'finished' and active.get('finishedAt'), 'Run has not settled'
    assert isinstance(active['pid'], int) and active['pid'] > 0
    try:
        os.kill(active['pid'], 0)
    except ProcessLookupError:
        pass
    else:
        raise RuntimeError('Recorded PID is live; inspect ownership, never stop it here')
    return active


def prepare(requested):
    config, source, destination, prior = context()
    revision = verified_revision(config, requested)
    record = HERE / 'preparation.json'
    assert not destination.exists() and not record.exists(), 'Never overwrite continuation data or evidence'
    active = finished(source)
    assert active['runId'] == prior['runId'] and active['taskId'] == prior['taskId']
    before = inventory(source)
    assert tree_hash(before) == prior['sourceInventorySha256'], 'Frozen run11 changed'
    assert not any(row['path'].endswith(('-wal', '-shm')) for row in before), 'Frozen SQLite sidecar present'
    marker = json.loads((source / 'owner.json').read_text())
    assert marker['directory'] == str(source) and marker['taskId'] == prior['taskId']
    destination.mkdir(mode=0o700)
    copied, linked = 0, 0
    for row in before:
        relative = PurePosixPath(row['path'])
        if relative.parts[0] not in ('engine', 'plugin') or '.coordination' in relative.parts:
            continue
        original, target = source / relative, destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        immutable = relative.parts[:3] == ('engine', 'evidence', 'blobs') and original.suffix in ('.gz', '.bin')
        if immutable:
            os.link(original, target)
            linked += 1
        else:
            shutil.copyfile(original, target)
            copied += 1
            assert original.stat().st_ino != target.stat().st_ino
        assert target.stat().st_size == row['bytes'] and digest(target) == row['sha256']
    marker.update(directory=str(destination), owner=str(uuid.uuid4()), createdAt=datetime.now(timezone.utc).isoformat())
    write_once(destination / 'owner.json', marker)
    assert inventory(source) == before, 'Preparing continuation changed frozen source bytes'
    result = {'revision': revision, 'productCommit': config['productCommit'], 'at': datetime.now(timezone.utc).isoformat(),
              'source': str(source), 'destination': str(destination), 'sourceInventorySha256': tree_hash(before),
              'sourceUnchanged': True, 'taskId': marker['taskId'], 'mutableFilesCopied': copied,
              'immutableBlobsHardLinked': linked, 'priorRunId': prior['runId'],
              'retainedEvidence': 'Run11 remains frozen. Old exports, summaries, locks and run control metadata are not copied. Immutable blob links share content; mutable DBs and manifests are independent.',
              'databaseOpened': False, 'taskBudgetOrUsageChanged': False, 'browserStarted': False}
    write_once(record, result)
    print(json.dumps({key: result[key] for key in ('destination', 'taskId', 'sourceUnchanged', 'immutableBlobsHardLinked')}))


def close_and_copy():
    config, frozen, working, prior = context()
    assert not (HERE / 'closed-evidence.json').exists() and not (HERE / 'audit-copy.json').exists()
    preparation = json.loads((HERE / 'preparation.json').read_text())
    launch = json.loads((HERE / 'launch.json').read_text())
    assert preparation['destination'] == str(working) and preparation['sourceUnchanged']
    assert launch['directory'] == str(working) and launch.get('finishedAt')
    active = finished(working)
    assert active['taskId'] == preparation['taskId'] and active['runId'] != prior['runId']
    run = working / 'runs' / active['runId']
    summary = json.loads((run / 'summary.json').read_text())
    assert summary['runId'] == active['runId'] and summary.get('finishedAt')
    assert not summary.get('diagnosticFailure'), 'Inspect settlement failure before audit'
    assert tree_hash(inventory(frozen)) == prior['sourceInventorySha256'], 'Frozen run11 changed'
    rows = inventory(working)
    assert not any(row['path'].endswith(('-wal', '-shm')) for row in rows), 'Unexpected SQLite sidecar after settlement'
    closed = {'at': datetime.now(timezone.utc).isoformat(), 'runId': active['runId'], 'taskId': active['taskId'],
              'source': str(working), 'runDirectory': str(run), 'sourceInventorySha256': tree_hash(rows),
              'sourceFiles': len(rows), 'sourceLogicalBytes': sum(row['bytes'] for row in rows),
              'sourceDatabase': next(row for row in rows if row['path'] == 'engine/engine.sqlite'),
              'pluginDatabase': next(row for row in rows if row['path'] == 'plugin/explorer.sqlite'),
              'summarySha256': digest(run / 'summary.json'), 'run11FrozenBytesUnchanged': True,
              'sourceCodeRevision': launch['sourceRevision'], 'noDatabaseOpened': True,
              'retention': 'Closed evidence stays once in v5. No restart or migration of the frozen directory; one exclusive temporary DB-only copy is reserved for the settled receipt audit.'}
    write_once(HERE / 'closed-evidence.json', closed)
    owned = Path(tempfile.mkdtemp(prefix='bie-run12-receipt-audit-')).resolve()
    engine = owned / 'engine'
    engine.mkdir()
    original, copied = working / 'engine/engine.sqlite', engine / 'engine.sqlite'
    shutil.copyfile(original, copied)
    assert original.stat().st_ino != copied.stat().st_ino and digest(original) == digest(copied)
    audit = {'at': datetime.now(timezone.utc).isoformat(), 'source': str(original), 'engineDirectory': str(engine),
             'runDirectory': str(run), 'sha256': digest(copied), 'bytes': copied.stat().st_size,
             'databaseOpened': False, 'evidenceBlobsCopied': False,
             'cleanup': 'Remove the exclusive temporary audit directory after the one settled audit; preserve source/output hashes and the frozen evidence.'}
    write_once(owned / 'ownership.json', audit)
    write_once(HERE / 'audit-copy.json', audit)
    print(json.dumps({'engineDirectory': str(engine), 'runDirectory': str(run), 'run11Unchanged': True}))
