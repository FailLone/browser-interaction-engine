import json
from pathlib import Path

root = Path(__file__).resolve().parent
data = json.loads((root / 'acceptance.json').read_text())
observations = {o['id']: o for o in data['observations']}
attempts = sorted(data['attempts'], key=lambda a: a['startedAt'])
a_url = 'https://www.okx.com/convert/btc-to-usd'
b_url = 'https://www.okx.com/trade-spot/btc-usdt'
assert len(attempts) == 8 and all(a['status'] == 'succeeded' for a in attempts)
assert [a['action']['label'] for a in attempts[:3]] == ['Close', 'Trade', 'Open Spot sub-menu']
sample, close_b, back, close_a, continued = attempts[3:]
assert observations[sample['beforeId']]['url'] == a_url
assert observations[sample['afterId']]['url'].split('#')[0] == b_url
assert observations[sample['beforeId']]['documentId'] != observations[sample['afterId']]['documentId']

decision = json.loads((root / 'upstream-decision-06.json').read_text())['resolutions'][0]
assert decision['revision'] == 3 and decision['decision']['mode'] == 'sample'
assert len(decision['decision']['memberKeys']) == 1
group = next(g for g in data['groups'] if g['id'] == decision['groupId'])
assert any(d['decision'] == decision['decision'] for d in group['decisions'])
selected = next(m for m in group['members'] if m['key'] == decision['decision']['memberKeys'][0])
assert selected['localId'] == sample['action']['localId']
unselected = {m['localId'] for m in group['members']} - {selected['localId']}
assert len(unselected) == 5 and not any(a['action'].get('localId') in unselected for a in attempts)

b_attempts = [a for a in attempts if observations[a['beforeId']]['url'].split('#')[0] == b_url]
assert b_attempts == [close_b, back]
assert close_b['action']['label'] == 'Close' and close_b['action']['boundary']['intent'] == 'exit'
before_close = observations[close_b['beforeId']]
assert not before_close['stable'] and any(g['code'] == 'INTERACTION_STABLE' for g in before_close['gaps'])
assert not any(g.get('critical') for g in before_close['gaps'])
assert observations[close_b['afterId']]['boundaries'] == []
skip = json.loads((root / 'upstream-decision-07.json').read_text())['resolutions'][0]
page = next(g for g in data['groups'] if g['id'] == skip['groupId'])
assert page['kind'] == 'page' and skip['decision']['mode'] == 'skip'
assert any(d['decision'] == skip['decision'] for d in page['decisions'])

assert back['action']['kind'] == 'history' and back['purpose'] == 'recovery'
assert back['action']['source'] == 'browser-history-return' and not back['action']['replayable']
returned = observations[back['afterId']]
assert returned['url'] == a_url and returned['documentId'] != observations[sample['beforeId']]['documentId']
assert data['pageExploration']['lastReturn']['status'] == 'returned'
assert data['pageExploration']['lastReturn']['attemptId'] == back['id']
assert any(e['type'] == 'exploration.page_returned' and e['data']['stateRestored'] is False for e in data['events'])
assert close_a['action']['label'] == 'Close' and observations[close_a['beforeId']]['documentId'] == returned['documentId']
old_scope = observations[sample['beforeId']]['instanceScope']
assert all(r['status'] == 'invalidated' for r in data['reviews'] if r['conditions']['instanceScope'] == old_scope)

chart = json.loads((root / 'upstream-decision-10.json').read_text())['resolutions'][0]
assert chart['decision']['mode'] == 'sample' and len(chart['decision']['memberKeys']) == 1
assert continued['action']['label'] == '1h' and observations[continued['beforeId']]['url'] == a_url
after = observations[continued['afterId']]
assert after['url'] == a_url and not after['boundaries']
assert next(c for c in after['controls'] if c['name'] == '1h')['selected'] == ['1h']
assert next(c for c in after['controls'] if c['name'] == '24h')['selected'] == []
assert data['audit']['counts']['succeeded'] == 8 and data['audit']['discoveryComplete'] is False
assert data['audit']['counts']['blocked'] > 0 and data['audit']['counts']['pending'] > 0
assert json.loads((root / 'runtime-boundary.json').read_text())['sourceChangedAfterStart'] == []
print('Verified single Spot sample, dynamic B exit, native return, fresh A continuation, and retained coverage gaps.')
