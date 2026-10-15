"""Verify explicit depth reuse and bounded DFS resumption; optionally hash raw files."""
import argparse
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--raw-root', type=Path)
args = parser.parse_args()
e = json.loads(Path(__file__).with_name('okx-acceptance.json').read_text())
a, o, s = e['attempts'], e['observations'], e['stages']
root, destination = 'https://www.okx.com/convert/btc-to-usd', 'https://www.okx.com/markets/prices'
assert e['source'] == e['sourceEnd'] and len(e['source']['sha256']) == 284
assert e['source']['commit'].startswith('2768807') and e['closed']['closed'] is True
assert len(a) == 11 and all(x['status'] == 'succeeded' for x in a)
assert e['completion']['status'] == 'blocked' and e['completion']['exhaustive'] is False
assert e['effectiveOptions']['regionExploration'] == e['effectiveOptions']['pageExploration'] == 'review'
assert not e['recoveries']
assert len(e['depthReviews']) == len(e['depthApplications']) == 1
source, applied = e['depthReviews'][0], e['depthApplications'][0]
assert source['decision']['mode'] == 'sample' and applied['reviewId'] == source['id']
assert applied['groupId'] != source['groupId']
assert source['conditions'] == applied['conditions']
assert len(source['conditions']['region']['anchors'][0]['binding']['members']) == 9
assert len(e['regionReviews']) == len(e['controlReviews']) == 2
original_region, reused_region = e['regionReviews']
assert reused_region['regions'][0]['reusedFrom']['reviewId'] == original_region['id'] == source['regionReviewId']
assert reused_region['regions'][0]['reuseConditions'] == original_region['regions'][0]['reuseConditions']
assert len(reused_region['regions'][0]['controlIds']) == 1
original_purpose, reused_purpose = e['controlReviews']
assert reused_purpose['reusedFrom']['reviewId'] == original_purpose['id']
assert reused_purpose['reuseConditions'] == original_purpose['reuseConditions']
assert all(not r['replayable'] for r in e['controlReviews'])

def current_group(stage):
    return next(g for g in s[stage]['groups'] if g['id'] == applied['groupId'])

# Independent region/purpose acceptance cannot silently inherit depth or execution.
for stage in ['region-reused', 'purpose-reused', 'pending-depth']:
    assert s[stage]['session']['actionCount'] == 6
    assert current_group(stage)['status'] == 'pending' and not current_group(stage)['decisions']
assert not s['region-reused']['depthReuse']['candidates']
assert len(s['purpose-reused']['depthReuse']['candidates']) == 1
assert s['pending-depth']['session']['stopReason'] == 'REGION_REVIEW_REQUIRED'
refresh = e['gateRefresh']
assert refresh['conditionsEqual'] and not refresh['oldAcceptCommandSubmitted']
assert refresh['actionCountBefore'] == refresh['actionCountAfter'] == 6
assert refresh['oldObservationId'] != refresh['currentObservationId']
assert refresh['oldConditionKey'] != refresh['currentConditionKey']
candidate = s['pending-depth']['depthReuse']['candidates'][0]
assert candidate['conditionKey'] == applied['conditionKey'] == refresh['currentConditionKey']
assert candidate['conditions'] == s['purpose-reused']['depthReuse']['candidates'][0]['conditions']
assert len(candidate['mapping']) == 1
mapping = candidate['mapping'][0]
assert mapping['selected'] and mapping['label'] == 'Markets' and mapping['kind'] == 'click'
assert mapping['previousActionId'] != mapping['actionId']
assert mapping['previousMemberKey'] != mapping['memberKey']
assert source['decision']['memberKeys'] == [mapping['previousMemberKey']]
assert candidate['decision']['memberKeys'] == [mapping['memberKey']]
assert applied['members'] == [{'signature': mapping['signature'], 'actionId': mapping['actionId']}]
accepted = current_group('depth-reused')['decisions'][-1]
assert accepted['decision']['mode'] == 'sample' and accepted['decision']['memberKeys'] == [mapping['memberKey']]
assert accepted['reusedFrom'] == {'reviewId': source['id'], 'conditionKey': candidate['conditionKey']}
assert s['depth-reused']['session']['actionCount'] == 6
assert s['depth-reused']['regionReview']['status'] == 'active'
assert not s['depth-reused']['controlReview'][0]['actions'][0]['excluded']
assert e['commands']['reuse-depth']['request']['review']['observationId'] == refresh['currentObservationId']
assert e['commands']['dfs-second']['request'] == {'type': 'explore'}
assert len([v for v in e['events'] if v['type'] == 'exploration.decision_reused']) == 1
assert 'upstream-04' in e['upperDecisions'] and 'upstream-05' in e['upperDecisions']
assert 'upstream-08' in e['upperDecisions'] and 'upstream-09' in e['upperDecisions']

markets = [x for x in a if x['action']['label'] == 'Markets']
assert len(markets) == 2 and all(x['purpose'] == 'exploration' for x in markets)
for x in markets:
    assert o[x['beforeId']]['url'] == root and o[x['afterId']]['url'] == destination
    assert o[x['beforeId']]['documentId'] != o[x['afterId']]['documentId']
    assert not x['action']['replayable']
assert markets[1]['startedAt'] > applied['at']
assert any(b['rule'] == 'reused-control-review/v1' and b['facts']['reviewId'] == reused_purpose['id'] for b in markets[1]['action']['basis']['evidence'])
returns = [x for x in e['events'] if x['type'] == 'exploration.page_returned']
assert len(returns) == 2 and all(x['data']['stateRestored'] is False for x in returns)
for x in a:
    action, before, after = x['action'], o[x['beforeId']], o[x['afterId']]
    assert action['label'] in ['Markets', 'Close', 'Close overlay', 'Return to observed page']
    if before['url'] == destination:
        assert action['label'] != 'Markets' and action['kind'] in ['click', 'press', 'history']
    if action['label'] == 'Close':
        assert before['boundaries'] and not after['boundaries']
    if action['kind'] == 'press':
        assert action['value'] == 'Escape' and before['boundaries'] and after['boundaries']
    if action['kind'] == 'history':
        assert x['purpose'] == 'recovery' and before['url'] == destination and after['url'] == root
        facts = next(b['facts'] for b in action['basis']['evidence'] if b['rule'] == 'browser-history-return/v1')
        assert facts['method'] == 'GET' and facts['fromUrl'] == destination and facts['toUrl'] == root
        assert before['navigation']['browserSessionId'] == facts['browserSessionId']
        assert any(entry['id'] == facts['toEntryId'] and entry['url'] == root and entry['method'] == 'GET' for entry in before['navigation']['entries'])
        assert any(event['data']['attemptId'] == x['id'] for event in returns)
assert [o[x['beforeId']]['url'] for x in a if x['action']['kind'] == 'press'] == [root, destination]
assert s['final']['session']['actionCount'] == 11 and s['final']['session']['stopReason'] == 'REGION_REVIEW_REQUIRED'
assert o[s['final']['observationId']]['url'] == root and not o[s['final']['observationId']]['boundaries']
assert s['final']['unassignedControlCount'] == 205
assert len(e['completion']['recordedActions']['pendingGroupIds']) == 15
assert next(g for g in e['finalGroups'] if g['conditions']['url'] == destination)['decisions'][-1]['decision']['mode'] == 'skip'
assert not any(x['type'] in ['exploration.page_return_blocked', 'hook.error'] for x in e['events'])

if args.raw_root:
    for name, expected in e['rawSha256'].items():
        h = hashlib.sha256()
        with (args.raw_root / name).open('rb') as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b''):
                h.update(chunk)
        assert h.hexdigest() == expected, f'Raw file changed: {name}'
print('Verified explicit current depth mapping, zero-action pending gate, two bounded DFS returns, failed Escape effects, source freeze, closed session, and remaining gaps.')
