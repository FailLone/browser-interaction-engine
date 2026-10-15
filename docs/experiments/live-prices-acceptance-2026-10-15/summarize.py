"""Summarize an exploration-workbench SQLite run without changing its ledger.
Usage: python3 summarize.py RUN_DIRECTORY OUTPUT_JSON
"""
from pathlib import Path
import collections
import json
import sqlite3
import sys

root, output = map(Path, sys.argv[1:])
con = sqlite3.connect(root.resolve().joinpath('engine.sqlite').as_uri() + '?mode=rw', uri=True)
# SQLite may need to initialize WAL sidecars; entity/event writes stay disabled.
con.execute('PRAGMA query_only=ON')
def entities(kind):
    return [json.loads(row[0]) for row in con.execute('SELECT json FROM entities WHERE kind=? ORDER BY rowid', (kind,))]
observations = entities('observation')
by_id = {o['id']: o for o in observations}
attempts = entities('attempt')
frontier = entities('frontier')
groups = entities('exploration-group')
def count(rows, key):
    return dict(collections.Counter(row.get(key, 'unspecified') for row in rows))
def observation(o):
    return {'id': o['id'], 'at': o.get('capturedAt'), 'cause': o.get('cause'), 'url': o['url'],
            'stable': o['stable'], 'fingerprint': o['fingerprint'], 'controls': len(o['controls']),
            'criticalGaps': [g for g in o['gaps'] if g.get('critical')],
            'gapCounts': count(o['gaps'], 'code'),
            'selectedTabs': [c['name'] for c in o['controls'] if c['role'] == 'tab' and c.get('selected')],
            'boundaries': o.get('boundaries', [])}
result = {
    'session': entities('session')[0],
    'observations': [observation(o) for o in observations],
    'attemptCounts': count(attempts, 'status'), 'attemptPurposes': count(attempts, 'purpose'),
    'attempts': [{'id': a['id'], 'label': a['action']['label'], 'kind': a['action']['kind'], 'value': a['action'].get('value'),
                  'purpose': a.get('purpose'), 'status': a['status'], 'reason': a.get('reason'), 'beforeId': a['beforeId'],
                  'afterId': a.get('afterId'), 'beforeUrl': by_id[a['beforeId']]['url'],
                  'afterUrl': by_id.get(a.get('afterId'), {}).get('url')} for a in attempts],
    'frontierCounts': count(frontier, 'status'),
    'unexecutedReasons': count([f for f in frontier if f['status'] not in ['executed', 'superseded']], 'reason'),
    'groups': [{k: g.get(k) for k in ['id', 'kind', 'label', 'conditions', 'status', 'decisions']} for g in groups],
    'pageReturns': [{'at': at, 'type': kind, 'data': json.loads(data)} for at, kind, data in con.execute(
        "SELECT at,type,json FROM events WHERE type IN ('exploration.page_returned','exploration.page_return_blocked','exploration.no_progress') ORDER BY sequence")],
    'recoveries': entities('reach'),
}
output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'output': str(output), 'observations': len(observations), 'attempts': result['attemptCounts'], 'frontier': result['frontierCounts']}, ensure_ascii=False))
