"""Verify bounded region reuse evidence; optionally verify the original files."""
import argparse
import copy
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--raw-root', type=Path)
args = parser.parse_args()
e = json.loads(Path(__file__).with_name('okx-acceptance.json').read_text())
a, o, s = e['attempts'], e['observations'], e['stages']
root, destination = 'https://www.okx.com/convert/btc-to-usd', 'https://www.okx.com/markets/prices'
assert e['source'] == e['sourceEnd'] and len(e['source']['sha256']) == 223
assert e['closed']['closed'] is True
assert len(a) == 11 and all(x['status'] == 'succeeded' for x in a)
assert e['completion']['status'] == 'blocked' and e['completion']['exhaustive'] is False
assert not e['recoveries']
assert e['effectiveOptions']['regionExploration'] == e['effectiveOptions']['pageExploration'] == 'review'
assert len(e['regionReviews']) == len(e['controlReviews']) == 3
wide, narrow, reused = e['regionReviews']
assert wide['regions'][0]['status'] == narrow['regions'][0]['status'] == 'invalidated'
assert reused['status'] == reused['regions'][0]['status'] == 'active'
region = reused['regions'][0]
assert region['reusedFrom']['reviewId'] == narrow['id']
assert region['reusedFrom']['regionKey'] == narrow['regions'][0]['key']
assert region['reuseConditions'] == narrow['regions'][0]['reuseConditions']
assert len(region['controlIds']) == 1 and not region['pageTraversal']
assert reused['instanceScope'] != narrow['instanceScope']
assert region['controlIds'] != narrow['regions'][0]['controlIds']
assert len([x for x in e['events'] if x['type'] == 'region.review_reused']) == 1

# The broad source was NOT reused when an unselected member changed.
assert not s['after-first-dfs']['regionReuseCandidates']
before = next(c for c in s['page']['regionCandidates'] if c['label'] == 'Main menu')
after = next(c for c in s['returned']['regionCandidates'] if c['label'] == 'Main menu')
assert len(before['controlIds']) == len(after['controlIds']) == 24
b1, b2 = copy.deepcopy(before['reuseBinding']), copy.deepcopy(after['reuseBinding'])
assert b1 != b2
for b in (b1, b2):
    member = b['members'][5]['ancestry'][0]
    del member['selector'], member['attributes']['id'], member['attributes']['name']
assert b1 == b2, 'Expected only the recorded generated search attributes to differ'
assert e['upperDecisions']['upstream-05']['regionReuseAssessment']['accepted'] is False
assert len(s['after-second-dfs']['regionReuseCandidates']) == 1
candidate = s['after-second-dfs']['regionReuseCandidates'][0]
assert candidate['reviewId'] == narrow['id']
assert candidate['conditionKey'] == region['reusedFrom']['conditionKey']
assert len(candidate['conditions']['anchors'][0]['binding']['members']) == 9
assert candidate['controlIds'] == region['controlIds']

original, derived, last = e['controlReviews']
assert original['status'] == derived['status'] == 'invalidated' and last['status'] == 'active'
assert derived['reusedFrom']['reviewId'] == original['id']
assert last['reusedFrom']['reviewId'] == derived['id']
assert len({r['conditions']['instanceScope'] for r in e['controlReviews']}) == 3
assert all(not r['replayable'] for r in e['controlReviews'])
assert original['reuseConditions'] == derived['reuseConditions'] == last['reuseConditions']
markets = [x for x in a if x['action']['label'] == 'Markets']
assert len(markets) == 2 and all(x['purpose'] == 'exploration' for x in markets)
for x in markets:
    assert o[x['beforeId']]['url'] == root and o[x['afterId']]['url'] == destination
    assert o[x['beforeId']]['documentId'] != o[x['afterId']]['documentId']
    assert not x['action']['replayable']
assert any(b['rule'] == 'reused-control-review/v1' and b['facts']['reviewId'] == derived['id']
           for b in markets[1]['action']['basis']['evidence'])

for stage in ['region-reused', 'both-reused', 'final']:
    assert s[stage]['session']['actionCount'] == 11
    g = next(g for g in s[stage]['groups'] if g['kind'] == 'reviewed-region' and g['status'] != 'invalidated')
    assert g['status'] == 'pending' and not g['decisions']
    assert s[stage]['regionReview']['id'] == reused['id']
assert s['final']['session']['stopReason'] == 'REGION_REVIEW_REQUIRED'
assert s['final']['unassignedControlCount'] == 204
assert len(e['completion']['recordedActions']['pendingGroupIds']) == 16
assert not s['both-reused']['controlReview'][0]['actions'][0]['excluded']
assert e['commands']['dfs-depth-gate']['request'] == {'type': 'explore'}
assert o[s['final']['observationId']]['url'] == root and not o[s['final']['observationId']]['boundaries']

returns = [x for x in e['events'] if x['type'] == 'exploration.page_returned']
assert len(returns) == 2 and all(x['data']['stateRestored'] is False for x in returns)
for x in a:
    action, before, after = x['action'], o[x['beforeId']], o[x['afterId']]
    assert action['label'] in ['Markets', 'Close', 'Close overlay', 'Return to observed page']
    if before['url'] == destination:
        assert action['kind'] in ['click', 'press', 'history'] and action['label'] != 'Markets'
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
presses = [x for x in a if x['action']['kind'] == 'press']
assert [o[x['beforeId']]['url'] for x in presses] == [root, destination]
assert e['upperDecisions']['upstream-10']['correctionToUpstream09']
page = next(g for g in e['finalGroups'] if g['conditions']['url'] == destination)
assert page['decisions'][-1]['decision']['mode'] == 'skip'
assert not any(x['type'] in ['exploration.page_return_blocked', 'hook.error'] for x in e['events'])

if args.raw_root:
    for name, expected in e['rawSha256'].items():
        h = hashlib.sha256()
        with (args.raw_root / name).open('rb') as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b''):
                h.update(chunk)
        assert h.hexdigest() == expected, f'Raw file changed: {name}'
print('Verified two DFS returns, conservative wide-anchor rejection, explicit narrow-region reuse, independent depth gating, provenance, failed Escape effects, and remaining gaps.')
