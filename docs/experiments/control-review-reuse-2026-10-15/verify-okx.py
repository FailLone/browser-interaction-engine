"""Verify bounded ordinary-purpose reuse evidence; optionally verify original files."""
import argparse
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--raw-root', type=Path)
args = parser.parse_args()
e = json.loads(Path(__file__).with_name('okx-acceptance.json').read_text())
a, o, stages = e['attempts'], e['observations'], e['stages']
root = 'https://www.okx.com/convert/btc-to-usd'
destination = 'https://www.okx.com/markets/prices'
assert e['source'] == e['sourceEnd'], 'Product source changed during run'
assert e['closed']['closed'] is True
assert len(a) == 11 and all(x['status'] == 'succeeded' for x in a)
assert e['completion']['status'] == 'blocked' and e['completion']['exhaustive'] is False
assert not e['recoveries'], 'Unexpected historical checkpoint recovery'
assert e['options']['regionExploration'] == 'review'
assert len(e['controlReviews']) == 3
original, derived, last = e['controlReviews']
assert original['status'] == derived['status'] == 'invalidated'
assert last['status'] == 'active'
assert not original.get('reusedFrom')
assert derived['reusedFrom']['reviewId'] == original['id']
assert last['reusedFrom']['reviewId'] == derived['id']
assert len({r['conditions']['instanceScope'] for r in [original, derived, last]}) == 3
assert len({r['localId'] for r in [original, derived, last]}) == 3
assert all(r['reuse'] == original['reuse'] and not r['replayable'] for r in [original, derived, last])
assert original['reuseConditions'] == derived['reuseConditions'] == last['reuseConditions']
assert len([x for x in e['events'] if x['type'] == 'control.review_reused']) == 2

markets = [x for x in a if x['action']['label'] == 'Markets']
assert len(markets) == 2
assert [x['purpose'] for x in markets] == ['exploration', 'external']
for x in markets:
    assert o[x['beforeId']]['url'] == root and o[x['afterId']]['url'] == destination
    assert o[x['beforeId']]['documentId'] != o[x['afterId']]['documentId']
    assert not x['action']['replayable']
assert any(b['rule'] == 'reused-control-review/v1' and b['facts']['reviewId'] == derived['id']
           for b in markets[1]['action']['basis']['evidence'])
# Preserve the incorrect manual-execute rejection expectation and actual dispatch.
assert e['commands']['reuse-depth-denied']['request']['type'] == 'execute'
assert e['commands']['reuse-depth-denied']['responseSummary']['status'] == 'succeeded'
assert e['upperDecisions']['upstream-07']['audit']['upstream06Expectation'] == 'incorrect'
assert 'reused-region' not in e['commands'], 'Stale follow-up region must not have been submitted'

for stage in ['returned', 'returned-second']:
    m = stages[stage]['controlReview']
    assert len(m) == 1 and m[0]['reuseCandidates']
    assert all(x['review']['status'] == 'invalidated' for x in m[0]['reuseCandidates'])
    assert m[0]['actions'][0]['exclusionReason'] == 'navigation_requires_review'
for stage in ['reused', 'chain-reused', 'final']:
    assert stages[stage]['regionReview']['status'] == 'invalidated'
    assert stages[stage]['unassignedControlCount'] > 0
    assert not any(g['kind'] == 'reviewed-region' and g['status'] != 'invalidated' for g in stages[stage]['groups'])
assert stages['returned']['session']['actionCount'] == stages['reused']['session']['actionCount'] == 6
assert stages['returned-second']['session']['actionCount'] == stages['chain-reused']['session']['actionCount'] == stages['final']['session']['actionCount'] == 11
assert stages['final']['session']['stopReason'] == 'REGION_REVIEW_REQUIRED'
assert e['commands']['dfs-gate']['request']['type'] == 'explore'
assert o[stages['chain-reused']['observationId']]['documentId'] == o[stages['final']['observationId']]['documentId']
assert o[stages['final']['observationId']]['url'] == root
assert not o[stages['final']['observationId']]['boundaries']

returns = [x for x in e['events'] if x['type'] == 'exploration.page_returned']
assert len(returns) == 2 and all(x['data']['stateRestored'] is False for x in returns)
for x in a:
    action = x['action']
    before, after = o[x['beforeId']], o[x['afterId']]
    assert action['label'] in ['Markets', 'Close', 'Close overlay', 'Return to observed page']
    if before['url'] == destination:
        assert action['kind'] in ['click', 'press', 'history']
        assert action['label'] != 'Markets', 'B must not receive business exploration'
    if action['label'] == 'Close':
        assert before['boundaries'] and not after['boundaries']
    if action['kind'] == 'press':
        assert action['value'] == 'Escape'
        assert before['boundaries'] and after['boundaries'], 'Dispatched Escape did not close the dialog'
    if action['kind'] == 'history':
        assert x['purpose'] == 'recovery'
        assert before['url'] == destination and after['url'] == root
        facts = next(b['facts'] for b in action['basis']['evidence'] if b['rule'] == 'browser-history-return/v1')
        assert facts['method'] == 'GET' and facts['fromUrl'] == destination and facts['toUrl'] == root
        assert before['navigation']['browserSessionId'] == facts['browserSessionId']
        assert any(entry['id'] == facts['toEntryId'] and entry['url'] == root and entry['method'] == 'GET' for entry in before['navigation']['entries'])
        assert any(event['data']['attemptId'] == x['id'] for event in returns)
assert len([x for x in a if x['action']['kind'] == 'press']) == 2
assert len([x for x in a if x['action']['kind'] == 'history']) == 2
page = next(g for g in e['finalGroups'] if g['conditions']['url'] == destination)
assert page['decisions'][-1]['decision']['mode'] == 'skip' and page['memberCount'] > 0
assert not any(x['type'] in ['exploration.page_return_blocked', 'hook.error'] for x in e['events'])

if args.raw_root:
    for name, expected in e['rawSha256'].items():
        h = hashlib.sha256()
        with (args.raw_root / name).open('rb') as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b''):
                h.update(chunk)
        assert h.hexdigest() == expected, f'Raw file changed: {name}'
print('Verified explicit reuse provenance, actual reused-purpose dispatch, two native returns, DFS region gating, preserved manual-execute expectation error, and remaining gaps.')
