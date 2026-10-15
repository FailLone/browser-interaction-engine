"""Verify the committed, finite-batch acceptance excerpt without contacting the website."""
import json
from pathlib import Path

p = Path(__file__).with_name('acceptance.json')
a = json.loads(p.read_text())
groups = {g['id']: g for g in a['groups']}
assert len(groups) == 193 and len(a['collections']) == 5
listed = [gid for c in a['collections'] for gid in c['groupIds']]
assert len(listed) == len(set(listed)) == len(groups) and set(listed) == set(groups)
assert all(g['status'] == 'pending' for g in groups.values())
assert len(a['overlaps']) == 188
assert all(set(o['groupIds']) <= set(groups) and len(o['groupIds']) > 1 and o['caseKeys'] for o in a['overlaps'])
assert len(a['decisions']) == len(groups)
for decided in a['decisions']:
    original = groups[decided['id']]
    assert decided['revision'] == original['revision'] + 1 and decided['status'] == 'decided'
    assert len(decided['decisions']) == 1 and decided['decisions'][0]['revision'] == original['revision']
    assert decided['decisions'][0]['decision']['mode'] == 'defer'
batches = [e for e in a['events'] if e['type'] == 'exploration.groups_decided']
assert len(batches) == 1 and set(batches[0]['data']['changedGroupIds']) == set(groups)
assert {r['groupId'] for r in batches[0]['data']['resolutions']} == set(groups)
assert a['individualDecisionEventCount'] == len(groups)
assert a['staleRejection']['failure']['code'] == 'STALE_GROUP_DECISION' and a['staleRejection']['unchanged']
assert a['actionCount'] == len(a['attempts']) == 1
assert a['attempts'][0]['label'] == 'Close' and a['attempts'][0]['status'] == 'succeeded'
print('Verified: 193 scopes, 5 source collections, 188 overlaps, one finite batch, stale rejection, one exit action.')
