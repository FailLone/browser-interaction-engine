"""Check the saved navigation evidence; optionally verify the original run files."""
import argparse
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--raw-root', type=Path)
args = parser.parse_args()
evidence = json.loads(Path(__file__).with_name('okx-acceptance.json').read_text())
root_url = 'https://www.okx.com/convert/btc-to-usd'
observations = evidence['observations']
attempts = evidence['attempts']
assert len(attempts) == 14
assert evidence['source'] == evidence['sourceEnd'], 'Product source changed during the run'
assert evidence['closed']['closed'] is True
assert evidence['completion']['exhaustive'] is False
assert evidence['completion']['status'] == 'blocked'
assert all(a['status'] == 'succeeded' for a in attempts)
assert not evidence['recoveries'], 'Unexpected historical checkpoint recovery'

cases = [
    ('More about USD to BTC', '/convert/usd-to-btc', 'conversion-approved', 'conversion-return'),
    ('About us', '/about', 'footer-approved', 'footer-return'),
    ('Markets', '/markets/prices', 'markets-approved', 'markets-return'),
]
returns = [e for e in evidence['events'] if e['type'] == 'exploration.page_returned']
assert len(returns) == len(cases)
assert not any(e['type'] in ['exploration.page_return_blocked', 'hook.error'] for e in evidence['events'])
assert all(e['data']['stateRestored'] is False for e in returns)
assert evidence['options']['regionExploration'] == 'review'
assert evidence['stages']['initial']['session']['actionCount'] == 0

for label, path, approved, returned in cases:
    destination = 'https://www.okx.com' + path
    hits = [a for a in attempts if a['action']['label'] == label]
    assert len(hits) == 1, f'{label}: expected one sample'
    action = hits[0]
    assert action['purpose'] == 'exploration', 'Explicit execute is not a DFS sample'
    assert action['action']['risk'] == 'interface'
    assert any(e['rule'] == 'reviewed-control/v1' for e in action['action']['basis']['evidence'])
    before, after = observations[action['beforeId']], observations[action['afterId']]
    assert before['url'] == root_url and after['url'] == destination
    assert before['documentId'] != after['documentId']

    gates = evidence['stages'][approved]['groups']
    sample_gates = []
    for group in gates:
        current = [m for m in group['members'] if m.get('localId') == action['action']['localId'] and not m.get('excluded')]
        if not current or group['status'] == 'invalidated':
            continue
        decision = group['decisions'][-1]['decision']
        assert decision['mode'] == 'sample'
        assert len(decision['memberKeys']) == 1
        assert decision['memberKeys'][0] in [m['key'] for m in current]
        sample_gates.append(group['kind'])
    assert 'reviewed-region' in sample_gates
    if label == 'About us':
        assert 'similar-list' in sample_gates

    destination_attempts = [a for a in attempts if observations[a['beforeId']]['url'] == destination]
    assert len(destination_attempts) == 2, f'{label}: unexpected operation on B'
    close, back = destination_attempts
    assert close['action']['kind'] == 'click' and close['action']['label'] == 'Close'
    assert close['action']['boundary']['intent'] == 'exit'
    assert observations[close['beforeId']]['boundaries']
    assert not observations[close['afterId']]['boundaries']
    assert back['action']['kind'] == 'history' and back['purpose'] == 'recovery'
    assert back['action']['source'] == 'browser-history-return'
    facts = next(e['facts'] for e in back['action']['basis']['evidence'] if e['rule'] == 'browser-history-return/v1')
    assert facts['method'] == 'GET' and facts['fromUrl'] == destination and facts['toUrl'] == root_url
    live = observations[back['beforeId']]['navigation']
    assert live['browserSessionId'] == facts['browserSessionId']
    assert any(e['id'] == facts['toEntryId'] and e['url'] == root_url and e['method'] == 'GET' for e in live['entries'])
    assert observations[back['afterId']]['url'] == root_url
    assert any(e['data']['attemptId'] == back['id'] for e in returns)
    final = observations[evidence['stages'][returned]['observationId']]
    assert final['url'] == root_url and final['documentId'] != before['documentId']
    assert not final['boundaries']
    groups = [g for g in evidence['finalGroups'] if g['conditions'].get('url') == destination]
    assert len(groups) == 1 and groups[0]['decisions'][-1]['decision']['mode'] == 'skip'
    assert groups[0]['memberCount'] > 0, 'Skip must preserve untested members'

assert not any(a['action']['label'] == 'Trade' for a in attempts)
assert not any(a['action']['kind'] in ['fill', 'scroll', 'select', 'hover'] for a in attempts)
presses = [a for a in attempts if a['action']['kind'] == 'press']
assert len(presses) == 1
assert observations[presses[0]['beforeId']]['boundaries'] and observations[presses[0]['afterId']]['boundaries'], 'Do not count dispatched Escape as a verified exit'
assert all(r['status'] == 'invalidated' for r in evidence['controlReviews']), 'Old document reviews must not be revived'
assert evidence['stages']['final']['unassignedControlCount'] > 0
assert evidence['stages']['final']['unassignedPageTraversal'] is True

if args.raw_root:
    for name, expected in evidence['rawSha256'].items():
        digest = hashlib.sha256()
        with (args.raw_root / name).open('rb') as raw:
            for chunk in iter(lambda: raw.read(1024 * 1024), b''):
                digest.update(chunk)
        assert digest.hexdigest() == expected, f'Raw evidence changed: {name}'
print('Verified three DFS navigation samples, only necessary exits on B, native GET-history returns, fresh-document review invalidation, and explicit remaining gaps.')
