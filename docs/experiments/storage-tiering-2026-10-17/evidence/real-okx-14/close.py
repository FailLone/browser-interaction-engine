"""Freeze one settled run by hashing files only; no database constructors or audit copies."""
import json
import sys
from pathlib import Path
from prepare import m, context

assert sys.argv[1:]==['--closed']
c,frozen,working,prior=context()
launch=json.loads((m.HERE/'launch.json').read_text())
assert launch.get('finishedAt') and launch['directory']==str(working)
active=m.finished(working)
run=working/'runs'/active['runId']
summary=json.loads((run/'summary.json').read_text())
assert summary['runId']==active['runId'] and summary.get('finishedAt')
assert m.tree_hash(m.inventory(frozen))==prior['sourceInventorySha256'], 'Frozen baseline changed'
rows=m.inventory(working)
assert not any(row['path'].endswith(('-wal','-shm')) for row in rows), 'Unsettled SQLite sidecar'
record={'runId':active['runId'],'taskId':active['taskId'],'source':str(working),'runDirectory':str(run),
 'sourceCodeRevision':launch['sourceRevision'],'productCommit':c['productCommit'],
 'sourceInventorySha256':m.tree_hash(rows),'sourceFiles':len(rows),'sourceLogicalBytes':sum(r['bytes'] for r in rows),
 'sourceDatabase':next(r for r in rows if r['path']=='engine/engine.sqlite'),
 'pluginDatabase':next(r for r in rows if r['path']=='plugin/explorer.sqlite'),
 'summarySha256':m.digest(run/'summary.json'),'run12FrozenBytesUnchanged':True,
 'processExited':True,'runControlFinished':True,'noDatabaseOpened':True,
 'retention':'Raw output remains once in v7. Frozen input remains unchanged. No constructor-based supplemental audit or second window.'}
m.write_once(m.HERE/'closed-evidence.json',record)
print(json.dumps(record))
