"""Verify the finite region-review evidence excerpt without contacting the website."""
import json
from pathlib import Path

a = json.loads(Path(__file__).with_name('acceptance.json').read_text())
assert a['candidateCount'] == len(a['candidates']) == 61
assert a['controllableCount'] == 203
assert a['options']['regionExploration'] == 'review' and a['options']['decisionScopes'] == []
regions = a['reviewResult']['regions']
assert a['reviewResult']['status'] == a['reviewAfter']['status'] == 'active'
assert [(r['key'], len(r['controlIds']), r['status']) for r in regions] == [('chart', 6, 'active'), ('calculator', 4, 'active')]
assert set(regions[0]['controlIds']).isdisjoint(regions[1]['controlIds'])
groups = {g['label']: g for g in a['scopeMaterial']['groups']}
assert len(groups) == 2 and all(g['status'] == 'pending' for g in groups.values())
assert all(g['kind'] == 'reviewed-region' for g in groups.values())
decisions = {g['label']: g['decisions'][-1]['decision'] for g in a['decisions']}
chart = groups['Chart intervals']
assert decisions['Chart intervals']['mode'] == 'sample'
assert decisions['Chart intervals']['memberKeys'] == [m['key'] for m in chart['members'] if m['label'] == '1W']
assert decisions['Calculator']['mode'] == 'defer'
assert a['sessionAfter']['status'] == 'paused' and a['sessionAfter']['stopReason'] == 'REGION_REVIEW_REQUIRED'
assert a['sessionAfter']['actionCount'] == len(a['attempts']) == 2
assert [(x['label'], x['status'], x['purpose']) for x in a['attempts']] == [('Close', 'succeeded', 'external'), ('1W', 'succeeded', 'exploration')]
before = {c['localId']: c for c in a['before']['controls']}
after = {c['localId']: c for c in a['after']['controls']}
assert a['before']['url'] == a['after']['url'] == a['url']
assert a['before']['instanceScope'] == a['after']['instanceScope']
assert next(c for c in after.values() if c['name'] == '1W')['selected'] == ['1W']
assert [before[i]['value'] for i in regions[1]['controlIds'] if before[i]['role'] == 'textbox'] == ['1', '81,038.4']
assert all(after[i]['value'] == before[i]['value'] for i in regions[1]['controlIds'] if before[i]['role'] == 'textbox')
assert len(a['unassignedControlIds']) == 193 and a['unassignedPageTraversal']
events = a['events']
assert len([e for e in events if e['type'] == 'region.reviewed']) == 1
assert not any(e['type'] in ['region.review_invalidated', 'hook.error'] for e in events)
assert len([e for e in events if e['type'] == 'exploration.groups_decided']) == 1
assert len([e for e in events if e['type'] == 'exploration.group_decided']) == 2
assert a['sourceSha256'] and a['rawSha256']
print('Verified: 61 candidates, two confirmed regions, one 1W sample, calculator unchanged, remaining work pending.')
