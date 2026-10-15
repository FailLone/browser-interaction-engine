import json
from pathlib import Path

root = Path(__file__).resolve().parent
data = json.loads((root / 'acceptance.json').read_text())
observations = {o['id']: o for o in data['observations']}
attempts = sorted(data['attempts'], key=lambda a: a['startedAt'])
assert len(attempts) == 4 and all(a['status'] == 'succeeded' for a in attempts)
assert [a['action']['label'] for a in attempts[:3]] == ['Close', 'Trade', 'Open Spot sub-menu']
chosen = attempts[-1]
a_url = 'https://www.okx.com/convert/btc-to-usd'
b_url = 'https://www.okx.com/trade-spot/btc-usdt'
assert observations[chosen['beforeId']]['url'] == a_url
assert observations[chosen['afterId']]['url'].split('#')[0] == b_url
assert observations[chosen['beforeId']]['documentId'] != observations[chosen['afterId']]['documentId']
assert not any(observations[a['beforeId']]['url'].split('#')[0] == b_url for a in attempts)
decision = json.loads((root / 'upstream-decision-06.json').read_text())
resolution = decision['resolutions'][0]
assert resolution['revision'] == 3 and resolution['decision']['mode'] == 'sample'
assert len(resolution['decision']['memberKeys']) == 1
sample_key = resolution['decision']['memberKeys'][0]
group = next(g for g in data['groups'] if g['id'] == resolution['groupId'])
assert any(d['decision'] == resolution['decision'] for d in group['decisions'])
member = next(m for m in group['members'] if m['key'] == sample_key)
assert member['localId'] == chosen['action']['localId']
assert len({m['localId'] for m in group['members']}) == 6
unselected = {m['localId'] for m in group['members']} - {member['localId']}
assert len(unselected) == 5 and not any(a['action'].get('localId') in unselected for a in attempts)
assert any(g['kind'] == 'page' and any(d['decision']['mode'] == 'skip' for d in g['decisions']) for g in data['groups'])
assert len(data['reviewErrors']) == 2 and all(e['code'] == 'STALE_CONTROL_REVIEW' for e in data['reviewErrors'])
assert len(data['reviews']) == 4 and all(r['status'] == 'invalidated' for r in data['reviews'])
assert data['audit']['counts']['succeeded'] == 4 and data['audit']['discoveryComplete'] is False
assert data['audit']['counts']['blocked'] > 0 and data['audit']['counts']['pending'] > 0
print('Verified six-row recognition, one actual sample, no destination operations, and unresolved return/coverage gaps.')
