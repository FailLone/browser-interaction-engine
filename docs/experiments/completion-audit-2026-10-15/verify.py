import json
from pathlib import Path

root = Path(__file__).resolve().parent
report = json.loads((root / 'okx-completion.json').read_text())
audit = report['audit']
original = json.loads((root.parent / 'exit-freshness-2026-10-15' / 'acceptance.json').read_text())
assert report['actionCount'] == len(original['attempts']) == 8
assert audit['recordedActions']['counts'] == original['audit']['counts']
assert audit['status'] == 'blocked' and audit['exhaustive'] is False
assert len(audit['unconfirmedControls']) == audit['controls']['unconfirmed'] == 174
assert audit['controls']['covered'] == 7
assert len(audit['scopes']) == 2
entry = next(s for s in audit['scopes'] if s['url'].endswith('/convert/btc-to-usd'))
destination = next(s for s in audit['scopes'] if '/trade-spot/' in s['url'])
assert len(entry['observationIds']) == 13 and len(entry['unconfirmedControlIds']) == 54
assert len(destination['observationIds']) == 4 and len(destination['unconfirmedControlIds']) == 127
page = next(g for g in original['groups'] if g['kind'] == 'page')
policy = next(g for g in destination['pageDecisions'] if g['id'] == page['id'])
assert policy['decisions'] == page['decisions']
assert policy['decisions'][-1]['decision']['mode'] == 'skip'
assert policy['decisions'][-1]['decision']['source'] == 'gpt-5.6-sol/low'
assert len({i for s in audit['scopes'] for i in s['unconfirmedControlIds']}) == 174
assert len([g for g in audit['gaps'] if not g['diagnostic']]) == 65
known = {o['id'] for o in original['observations']}
assert all(set(g['observationIds']) <= known for g in audit['gaps'])
assert all(set(g['criticalObservationIds']) <= set(g['observationIds']) for g in audit['gaps'])
assert any(g['code'] == 'UNSUPPORTED_CANVAS' for g in audit['gaps'])
assert any(g['origin'] == 'evidence' for g in audit['gaps'])
print('Verified unchanged action evidence, unknown controls outside the frontier, per-scope discovery limitations, and no exhaustive claim.')
