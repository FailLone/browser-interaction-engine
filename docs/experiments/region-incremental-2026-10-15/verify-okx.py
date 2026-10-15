"""Verify the bounded OKX evidence; optionally check the retained raw files."""
import argparse
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--raw', type=Path)
args = parser.parse_args()
a = json.loads(Path(__file__).with_name('okx-acceptance.json').read_text())
s = a['stages']
assert a['source'] == a['sourceEnd']
assert a['source']['commit'].startswith('3ff43af')
assert a['options']['regionExploration'] == 'review'
original_id = a['initialReview']['id']

def proof(stage):
    group = s[stage]['chartGroup']
    return {k: group[k] for k in ['id', 'revision', 'decisions', 'collection']}

for before, after, patch, added, removed in [
    ('paused-expanded', 'patched', a['patches'][0], 8, 1),
    ('filtered', 'repatched', a['patches'][1], 1, 6),
]:
    delta = s[before]['delta']
    assert delta['canUpdate'] and delta['unchangedRegionKeys'] == ['btc-usd-chart']
    assert len(delta['changedRegions']) == 1
    change = delta['changedRegions'][0]
    assert change['key'] == 'crypto-calculator' and change['baselineAvailable']
    assert len(change['addedControlIds']) == added
    assert len(change['removedControlIds']) == removed
    request = patch['request']['review']
    assert [r['key'] for r in request['regions']] == ['crypto-calculator']
    assert request['observationId'] == s[before]['observationId']
    assert request['update']['baseReviewId'] == s[before]['review']['id']
    assert patch['response']['baseReviewId'] == s[before]['review']['id']
    assert s[after]['review']['id'] == patch['response']['id']
    assert proof(before) == proof(after)
    assert s[before]['session']['actionCount'] == s[after]['session']['actionCount']
    fresh = s[after]['calculatorGroups']
    assert len(fresh) == 1 and fresh[0]['status'] == 'pending' and fresh[0]['decisions'] == []
    assert fresh[0]['id'] not in {g['id'] for g in s[before]['calculatorGroups']}

for stage in s.values():
    assert stage['url'] == a['url']
    chart = next(r for r in stage['review']['regions'] if r['key'] == 'btc-usd-chart')
    assert chart['status'] == 'active' and chart['reviewId'] == original_id
    assert stage['chartGroup']['decisions'] == s['approved']['chartGroup']['decisions']

assert any(f['reason'] == 'awaiting_exploration_decision' and not f['attempts']
           for f in s['patched']['searchFrontier'])
assert a['staleReplay']['request'] == a['patches'][0]['request']
assert a['staleReplay']['response']['code'] == 'STALE_REGION_REVIEW'
assert s['deferred'] == s['stale-rejected']
assert s['final']['calculatorGroups'][0]['decisions'][-1]['decision']['mode'] == 'defer'
assert s['final']['session']['actionCount'] == s['deferred']['session']['actionCount'] == 6
assert s['final']['session']['stopReason'] == 'ACTIVE_BOUNDARY_BLOCKED'
assert s['final']['boundaries'] and s['final']['unassignedControlCount'] == 193
assert s['final']['unassignedPageTraversal']

attempts = a['attempts']
assert len(attempts) == 6 and all(x['status'] == 'succeeded' for x in attempts)
assert [(x['action']['label'], x['action']['kind']) for x in attempts] == [
    ('Close', 'click'), ('BTC', 'click'), ('BTC', 'click'),
    ('Close overlay', 'press'), ('Search', 'fill'), ('Close overlay', 'press'),
]
assert not attempts[0]['after']['boundaries']
assert all(x['after']['url'] == a['url'] for x in attempts)
assert all(x['after']['boundaries'] for x in attempts[1:])
assert attempts[1]['action']['localId'] == attempts[2]['action']['localId']
assert attempts[4]['action']['value'] == 'BTC'
assert any(c.get('name') == 'Search' and c.get('value') == 'BTC' for c in s['final']['controls'])
assert {'BTC', 'WBTC'} <= {c.get('name') for c in s['final']['controls']}
assert not {'0G', '1INCH', '2Z', 'A', 'AAOI'} & {c.get('name') for c in s['final']['controls']}
fields = {c['localId']: c['value'] for c in s['approved']['controls'] if c['role'] == 'textbox'}
assert len(fields) == 2
assert all(c['value'] == fields[c['localId']] for c in s['final']['controls'] if c['localId'] in fields)
assert a['completion']['exhaustive'] is False and a['completion']['status'] == 'blocked'
assert a['closed'] == {'closed': True}
invalidations = [e['data'] for e in a['events'] if e['type'] == 'region.review_invalidated']
assert len(invalidations) == 2 and all(e['regionKeys'] == ['crypto-calculator'] for e in invalidations)
assert len([e for e in a['events'] if e['type'] == 'region.reviewed']) == 3
assert not any(e['type'] == 'hook.error' for e in a['events'])
assert a['independentReview']
if args.raw:
    for filename, expected in a['rawSha256'].items():
        assert hashlib.sha256((args.raw / filename).read_bytes()).hexdigest() == expected, filename
print('Verified: two local updates preserve chart proof, new scopes await decisions, BTC search runs, stale replay is atomic; exit remains blocked.')
