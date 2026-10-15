import json
from pathlib import Path

root = Path(__file__).resolve().parent
data = json.loads((root / 'acceptance.json').read_text())
observations = {o['id']: o for o in data['observations']}
attempts = sorted(data['attempts'], key=lambda a: a['startedAt'])
assert len(attempts) == 5
assert all(a['status'] == 'succeeded' and a['beforeId'] in observations and a['afterId'] in observations for a in attempts)
assert [a['action']['label'] for a in attempts] == ['Close', 'BTC', '1INCH', 'Close', 'Return to observed page']
a_url = 'https://www.okx.com/convert/btc-to-usd'
b_url = 'https://www.okx.com/convert/1inch-to-usd'
assert observations[attempts[2]['beforeId']]['url'] == a_url
assert observations[attempts[2]['afterId']]['url'] == b_url
assert observations[attempts[4]['beforeId']]['url'] == b_url
assert observations[attempts[4]['afterId']]['url'] == a_url
assert observations[attempts[2]['beforeId']]['instanceScope'] != observations[attempts[2]['afterId']]['instanceScope']
assert not observations[attempts[3]['afterId']]['boundaries']
b_actions = [a for a in attempts if observations[a['beforeId']]['url'] == b_url]
assert [a['action']['kind'] for a in b_actions] == ['click', 'history']
assert attempts[-1]['purpose'] == 'recovery'
assert len(data['reviews']) == 4 and all(r['status'] == 'invalidated' for r in data['reviews'])
assert all(r['source'] == 'gpt-5.6-sol/low' for r in data['reviews'])
decision = json.loads((root / 'upstream-command-04.json').read_text())
assert decision['revision'] == 2 and decision['decision']['mode'] == 'sample'
assert len(decision['decision']['memberKeys']) == 1
group = next(g for g in data['groups'] if g['id'] == decision['groupId'])
assert any(d['decision'] == decision['decision'] for d in group['decisions'])
assert any(g['kind'] == 'page' and any(d['decision']['mode'] == 'skip' for d in g['decisions']) for g in data['groups'])
assert any(e['type'] == 'exploration.page_returned' and e['data']['stateRestored'] is False for e in data['events'])
assert data['audit']['counts']['succeeded'] == 5 and data['audit']['discoveryComplete'] is False
assert data['audit']['counts']['blocked'] > 0 and data['audit']['counts']['pending'] > 0
print('Verified sampled A → B → A flow, durable review invalidation, and remaining gaps.')
