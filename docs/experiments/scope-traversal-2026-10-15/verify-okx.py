"""Verify the bounded scope expansion and before/after page traversal evidence."""
import argparse
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--raw-root', type=Path)
args = parser.parse_args()
data = json.loads(Path(__file__).with_name('okx-acceptance.json').read_text())
expanded, fixed = data['runs']
assert [expanded['name'], fixed['name']] == ['run-10', 'run-11']
assert expanded['source']['commit'].startswith('0079309')
assert fixed['source']['commit'].startswith('447f99a')

def stage(run, name):
    return run['observations'][run['stages'][name]['observationId']]

def control(o, suffix):
    return next(c for c in o['controls'] if c['localId'].endswith(':' + suffix))

def scrolls(run):
    return [a for a in run['attempts'] if a['action']['kind'] == 'scroll']

def positions(run):
    steps = scrolls(run)
    return [run['observations'][steps[0]['beforeId']]['scroll']['y']] + [run['observations'][a['afterId']]['scroll']['y'] for a in steps]

for run in data['runs']:
    assert run['source'] == run['sourceEnd']
    assert run['closed'] == {'closed': True}
    assert run['completion']['exhaustive'] is False
    assert run['stages']['final']['session']['actionCount'] == len(run['attempts'])
    assert run['stages']['final']['session']['stopReason'] == 'REGION_REVIEW_REQUIRED'
    assert run['stages']['final']['unassignedControlCount'] > 0
    assert not run['stages']['final']['unassignedPageTraversal']
    assert run['recoveries'] == []
    assert run['upperDecisions']['upstream-verification']
    assert not any(e['type'] == 'hook.error' for e in run['events'])
    for a in run['attempts']:
        assert a['status'] == 'succeeded'
        after = run['observations'][a['afterId']]
        assert after['url'] == data['url']
        assert after['documentId'] == stage(run, 'page')['documentId']
        assert not after['criticalGaps']
    traversal = next(r for r in run['stages']['traversal-approved']['regionReview']['regions'] if r['key'] == 'entry-page-traversal')
    assert traversal['controlIds'] == [] and traversal['pageTraversal'] and traversal['status'] == 'active'
    traversal_group = next(g for g in run['stages']['traversal-approved']['groups'] if not g['members'] and g['traversalKeys'])
    assert traversal_group['decisions'][-1]['decision']['mode'] == 'all'
    assert all(a['purpose'] == 'exploration' and not a['action'].get('localId') for a in scrolls(run))
    if args.raw_root:
        for filename, expected in run['rawSha256'].items():
            digest = hashlib.sha256()
            with (args.raw_root / run['name'] / filename).open('rb') as f:
                for chunk in iter(lambda: f.read(1024 * 1024), b''): digest.update(chunk)
            assert digest.hexdigest() == expected, (run['name'], filename)

assert len(expanded['attempts']) == 13
assert [a['action']['label'] for a in expanded['attempts'][:3]] == ['Close', 'BTC', 'Attempt reviewed outside exit']
assert expanded['boundaryExitResults'][0]['status'] == 'verified'
assert expanded['boundaryExitResults'][0]['preserved']
assert expanded['attempts'][3]['action']['value'] == '2'
assert expanded['attempts'][4]['action']['label'] == '1h'
assert expanded['attempts'][5]['action']['label'] == "What is today's exchange rate for 1 BTC to USD?"
assert all(a['purpose'] == 'exploration' for a in expanded['attempts'][3:])
sample = stage(expanded, 'samples-complete')
assert control(sample, '1765')['value'] == '2' and control(sample, '1769')['value'] == '162,089.2'
assert control(sample, '1751')['selected'] == ['1h'] and control(sample, '1752')['selected'] == []
assert control(sample, '299')['expanded'] is True
assert expanded['stages']['patched']['unassignedControlCount'] == 183
for original in expanded['stages']['approved']['groups']:
    if not any(m['label'] == '1h' for m in original['members']): continue
    for name in ['patched', 'samples-complete', 'final']:
        current = next(g for g in expanded['stages'][name]['groups'] if g['id'] == original['id'])
        assert current['decisions'] == original['decisions']
assert expanded['stages']['samples-complete']['regionReview'] == expanded['stages']['traversal-reviewed']['regionReview']
assert stage(expanded, 'samples-complete')['id'] == stage(expanded, 'traversal-reviewed')['id']
assert positions(expanded) == [3569, 4244, 4919, 5594, 6269, 6879, 6204, 6879]
assert any(f['reason'] == 'traversal_position_changed' for f in expanded['finalFrontier'])

assert [a['action']['label'] for a in fixed['attempts'][:2]] == ['Close', "What is today's exchange rate for 1 BTC to USD?"]
assert len(fixed['attempts']) == 29 and len(scrolls(fixed)) == 27
assert all(a['action']['kind'] == 'scroll' for a in fixed['attempts'][2:])
for original in fixed['stages']['faq-approved']['groups']:
    current = next(g for g in fixed['stages']['final']['groups'] if g['id'] == original['id'])
    assert current['decisions'] == original['decisions']
assert stage(fixed, 'traversal-approved')['scroll']['y'] == 3569
ys = positions(fixed)
max_y = stage(fixed, 'traversal-approved')['scroll']['maxY']
assert 0 in ys and max_y in ys
assert len(fixed['attempts']) < fixed['options']['maxActions']
observed = [fixed['observations'][a['afterId']] for a in scrolls(fixed)]
assert all(o['scroll']['maxY'] == max_y for o in observed)
unique = sorted(set(ys))
assert all(b - a <= min(o['viewport']['height'] for o in observed) for a, b in zip(unique, unique[1:]))
assert not stage(fixed, 'final')['boundaries']
print('Verified: calculator patch, retained chart decision, amount/FAQ samples, guarded malformed request, and repaired traversal reaching both ends with overlapping viewport intervals. Functional page coverage remains incomplete.')
