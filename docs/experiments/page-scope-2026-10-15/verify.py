"""Verify the saved acceptance extract without accessing the live website."""
import json
from pathlib import Path
p = json.loads((Path(__file__).parent / 'acceptance.json').read_text())
before, returned, deferred = p['phases']
a = 'https://www.okx.com/convert/btc-to-usd'
b = 'https://www.okx.com/convert/usd-to-btc'
assert before['session']['options']['pageExploration'] == 'review'
assert before['session']['actionCount'] == 1
assert returned['session']['actionCount'] == deferred['session']['actionCount'] == 5
assert returned['session']['stopReason'] == 'PAGE_DECISION_REQUIRED'
assert returned['observation']['url'] == a and not returned['observation']['boundaries']
g = returned['pageGroups'][0]
assert g['conditions'] == {'url': b} and g['status'] == 'pending' and g['binding'] == 'context'
assert g['memberCount'] == 537 and not g['decisions']
assert deferred['pageGroups'][0]['id'] == g['id']
assert deferred['pageGroups'][0]['decisions'][-1]['decision']['mode'] == 'defer'
assert [x['action']['label'] for x in p['attempts']] == ['Close', 'More about USD to BTC', 'Close', 'Return to observed page', 'Close']
assert all(x['status'] == 'succeeded' for x in p['attempts'])
at_b = [x for x in p['attempts'] if x['before']['url'] == b]
assert [x['action']['label'] for x in at_b] == ['Close', 'Return to observed page']
assert at_b[0]['action']['boundary']['intent'] == 'exit'
assert at_b[1]['after']['url'] == a and at_b[1]['purpose'] == 'recovery'
assert not p['recoveries']
assert len(returned['destinationFrontier']) == 205
assert all(x['coverage']['executionStatus'] == 'not_attempted' and not x['attempts'] for x in returned['destinationFrontier'])
e = [e for e in p['events'] if e['type'] == 'exploration.page_returned']
assert len(e) == 1 and e[0]['data']['stateRestored'] is False
assert returned['pageExploration']['lastReturn']['attemptId'] == at_b[1]['id']
assert not any(e['type'] == 'exploration.page_return_blocked' for e in p['events'])
print('Verified: destination gated, native return to entry, no destination business action, asynchronous defer without execution.')
