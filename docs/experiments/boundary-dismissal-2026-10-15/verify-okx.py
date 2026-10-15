"""Verify the retained bounded evidence, optionally against both raw run directories."""
import argparse
import hashlib
import json
from pathlib import Path
parser = argparse.ArgumentParser()
parser.add_argument('--raw-root', type=Path)
args = parser.parse_args()
data = json.loads(Path(__file__).with_name('okx-acceptance.json').read_text())
failed, fixed = data['runs']
assert [failed['name'], fixed['name']] == ['run-08', 'run-09']
assert failed['source']['commit'].startswith('2f89818')
assert fixed['source']['commit'].startswith('ebc15f6')

def selected(o, name):
    return next(c['selected'] for c in o['controls'] if c['role'] == 'tab' and c['name'] == name)

def check_run(run):
    assert run['source'] == run['sourceEnd']
    assert run['options']['regionExploration'] == 'review'
    assert run['closed'] == {'closed': True}
    assert run['completion']['exhaustive'] is False
    stages, attempts = run['stages'], run['attempts']
    base = stages['approved']['observation']
    assert selected(base, '24h') == ['24h'] and selected(base, '1h') == []
    assert [a['action']['label'] for a in attempts[:3]] == ['Close', 'BTC', 'Search']
    assert all(a['status'] == 'succeeded' for a in attempts[:3])
    assert attempts[2]['action']['value'] == 'BTC'
    assert attempts[1]['action']['source'] == 'control-review'
    assert stages['expanded']['observation']['boundaries']
    assert stages['filtered']['observation']['boundaries']
    assert {'BTC', 'WBTC'} <= {c['name'] for c in stages['filtered']['observation']['controls'] if c['visible']}
    assert not stages['dismissed']['observation']['boundaries']
    assert selected(stages['dismissed']['observation'], '1h') == []
    assert selected(stages['dismissed']['observation'], '24h') == ['24h']
    for a in attempts:
        assert a['action']['kind'] in ['click', 'fill', 'dismiss']
        assert a['after']['url'] == data['url']
        assert a['after']['documentId'] == base['documentId']
        assert not a['after']['criticalGaps']
    amounts = {c['localId']: c['value'] for c in base['controls'] if c['role'] == 'textbox' and c['name'] == '0' and c['visible']}
    assert len(amounts) == 2
    for stage in ['expanded', 'filtered', 'exit-reviewed', 'dismissed', 'final']:
        o = stages[stage]['observation']
        assert {c['localId']: c['value'] for c in o['controls'] if c['localId'] in amounts} == amounts
        for original in stages['approved']['chartGroups']:
            current = next(g for g in stages[stage]['chartGroups'] if g['id'] == original['id'])
            assert current['decisions'] == original['decisions']
        chart = next(r for r in stages[stage]['regionReview']['regions'] if r['key'] == 'btc-usd-chart')
        assert chart['status'] == 'active'
        assert chart['reviewId'] == stages['approved']['regionReview']['id']
    assert len(run['exitReviews']) == 1
    review = run['exitReviews'][0]
    assert review['decision']['mode'] == 'attempt' and len(review['decision']['preserveControlIds']) == 4
    assert attempts[3]['action']['value'] == review['decision']['candidateId']
    assert attempts[3]['action']['replayable'] is False
    assert run['upperDecisions']['upstream-verification']
    assert not any(e['type'] == 'hook.error' for e in run['events'])
    if args.raw_root:
        for filename, expected in run['rawSha256'].items():
            h = hashlib.sha256()
            with (args.raw_root / run['name'] / filename).open('rb') as f:
                for chunk in iter(lambda: f.read(1024 * 1024), b''): h.update(chunk)
            assert h.hexdigest() == expected, (run['name'], filename)

check_run(failed)
assert len(failed['attempts']) == 4
assert failed['attempts'][3]['status'] == 'failed'
assert failed['results'][0]['status'] == 'unverified'
assert failed['stages']['final']['session']['stopReason'] == 'BOUNDARY_EXIT_UNVERIFIED'
assert failed['stages']['final']['session']['actionCount'] == 4
assert selected(failed['stages']['final']['observation'], '1h') == []

check_run(fixed)
assert len(fixed['attempts']) == 5 and all(a['status'] == 'succeeded' for a in fixed['attempts'])
result = fixed['results'][0]
assert result['status'] == 'verified' and result['closed'] and result['parentReady'] and result['preserved']
assert result['inputPhase'] == 'pointer-move' and result['closedAfterMove']
assert fixed['attempts'][4]['action']['label'] == '1h' and fixed['attempts'][4]['purpose'] == 'exploration'
assert selected(fixed['stages']['final']['observation'], '1h') == ['1h']
assert selected(fixed['stages']['final']['observation'], '24h') == []
assert fixed['stages']['final']['session']['actionCount'] == 5
assert fixed['stages']['final']['session']['stopReason'] == 'REGION_REVIEW_REQUIRED'
assert fixed['stages']['final']['unassignedControlCount'] == 199
assert not fixed['stages']['final']['observation']['boundaries']
print('Verified: prior guarded failure, reviewed pointer-departure exit without click, preserved amounts, unchanged chart approvals, and resumed 1h exploration. Entire page remains incomplete.')
