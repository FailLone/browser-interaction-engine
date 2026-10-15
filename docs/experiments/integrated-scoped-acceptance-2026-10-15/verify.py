"""Check persisted acceptance extracts without browser access or new decisions."""
import collections
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def read(name):
    return json.loads((ROOT / name).read_text())


attempts = read('attempts.json')
summary = read('summary.json')
scope = read('scope-audit.json')
options = read('finite-options.json')
freeze = read('freeze-audit.json')
by_id = {attempt['id']: attempt for attempt in attempts}

assert len(attempts) == len(by_id) == summary['executeRequests'] == 49
assert all(a['status'] == 'succeeded' and a['beforeId'] and a['afterId'] for a in attempts)
assert len(options) == len({o['label'] for o in options}) == 17
for option in options:
    attempt = by_id[option['attemptId']]
    assert attempt['target']['role'] == 'option'
    assert option['valueMatches']['value'] == option['label'] == attempt['action']['label']
    assert option['beforeId'] == attempt['beforeId']
    assert option['afterId'] == attempt['afterId']
    assert any(c['localId'] == option['valueMatches']['localId'] and c['value'] == option['label']
               for c in attempt['afterFields'])


def values(attempt, key, names):
    return {c['name']: c['value'] for c in attempt[key] if c['name'] in names}


reset = attempts[43]
assert reset['action']['label'] == 'Reset'
assert values(reset, 'beforeFields', ['Min', 'Max']) == {'Min': '1', 'Max': '1000'}
assert sum(bool(c['value']) for c in reset['beforeFields']) == 4
assert all(c['value'] == '' for c in reset['afterFields'])
apply, reenter, close = attempts[46:49]
assert apply['action']['label'] == 'Apply' and apply['beforeModalKeys'] and not apply['afterModalKeys']
assert reenter['action']['label'] == 'Filters' and reenter['afterModalKeys']
assert values(reenter, 'afterFields', ['Min', 'Max']) == {'Min': '1', 'Max': '1000'}
assert close['action']['label'].lower() == 'close' and close['beforeModalKeys'] and not close['afterModalKeys']
assert sum(a['action']['kind'] == 'scroll' for a in attempts) == 5

assert dict(collections.Counter(c['disposition'] for c in scope['cases'])) == summary['historicalScopeCases']
for case in scope['cases']:
    if case['disposition'] == 'covered_equivalent':
        ref = case['equivalentTo']
        attempt = by_id[ref['attemptId']]
        assert attempt['status'] == 'succeeded'
        assert (ref['beforeId'], ref['afterId']) == (attempt['beforeId'], attempt['afterId'])
        assert ref['identityId'] == attempt['action']['controlId']
        assert case['kind'] == attempt['action']['kind']
assert len(scope['unconfirmedControls']) == summary['inScopeUnconfirmedControlGroups'] == 14
assert collections.Counter(h['status'] for h in scope['hypotheses']) == {'resolved': 2, 'pending': 22}
assert len(scope['latestModal']['controls']) == 20
assert collections.Counter(c['frontierStatus'] for c in scope['latestModal']['frontierCases']) == {
    'executed': 1, 'superseded': 1, 'deferred': 4, 'blocked': 2}
assert scope['latestModal']['observationId'] == reenter['afterId']
assert summary['verdict'] == 'strict_acceptance_not_established'
assert summary['classifyControlsCommands'] == 0
assert summary['wallClockMs'] == 776974 and summary['engineElapsedMs'] == 399797
assert not summary['tableWideBusinessFilteringVerified']
assert freeze['actualHead'] == freeze['expectedHead'] == summary['frozenCommit']
assert freeze['trackedStatus'] == '' and freeze['trackedFilesChecked'] == 514 and not freeze['hashMismatches']
print('Verified: 49 successful attempts, 17 option effects, reset/reentry/close; strict scope remains incomplete.')
