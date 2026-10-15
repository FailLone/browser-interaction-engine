import json
from pathlib import Path

p = Path(__file__).parent
d = json.loads((p / 'acceptance.json').read_text())
before, after = d['before'], d['after']
assert before['url'] == after['url'] == 'https://www.okx.com/convert/btc-to-usd'
assert before['instanceScope'] == after['instanceScope']
assert before['observationId'] != after['observationId']
assert before['actionCount'] == after['actionCount'] == 1
assert after['boundaries'] == []
assert d['sourceFilesUnchanged'] and d['sourceObservationUnchanged']
assert len(d['attempts']) == 1
assert d['attempts'][0]['status'] == 'succeeded'
assert d['attempts'][0]['action']['label'] == 'Close'
assert [r['classification'] for r in d['classifications']] == ['container', 'container', 'probe_required', 'interaction', 'unresolved']
assert all(r['status'] == 'active' and r['source'] == 'gpt-5.6-sol/low' for r in d['classifications'])
assert d['beforeCoverage']['counts']['unconfirmed'] == 35
assert d['afterCoverage']['counts']['unconfirmed'] == 33
assert d['afterCoverage']['counts']['containers'] == 2
assert d['beforeCoverage']['counts']['covered'] == d['afterCoverage']['counts']['covered'] == 1
for r in d['classifications']:
    def operations(state):
        return [(a['kind'], a.get('value'), a.get('basis', {}).get('status'), a.get('excluded'), a.get('exclusionReason')) for a in state['actions'] if a.get('localId') == r['localId']]
    assert operations(before) == operations(after)
    if r['classification'] != 'container':
        continue
    assert operations(after) == []
    target = next(c for c in after['controls'] if c['localId'] == r['localId'])
    assert target['actions'] == [] and not target['classificationBinding']['truncated']
    child_ids = [n['instanceId'] for n in target['classificationBinding']['nodes'] if n['instanceId'] != target['instanceId']]
    assert len(child_ids) == 1
    child = next(c for c in after['controls'] if c['instanceId'] == child_ids[0])
    assert child['actionBasis']['click']['status'] == 'supported'
    candidate = next(a for a in after['actions'] if a['localId'] == child['localId'] and a['kind'] == 'click')
    assert candidate['excluded'] and candidate['exclusionReason'] == 'navigation_requires_review'
    assert not any(a['action'].get('localId') == child['localId'] for a in d['attempts'])
retired = [c for c in d['actionAudit']['cases'] if c['disposition'] == 'retired']
assert len(retired) == 2 and all(c['reason'] == 'boundary_already_exited' for c in retired)
assert d['actionAudit']['counts']['blocked'] > 0 and d['actionAudit']['counts']['awaiting_decision'] > 0
assert d['gapCounts']['after'] >= d['gapCounts']['before'] > 0
assert d['completionStatus'] == 'blocked' and d['exhaustive'] is False
print('Verified sourced classifications, preserved child operations, no classification-triggered actions, immutable source evidence and retained gaps.')
