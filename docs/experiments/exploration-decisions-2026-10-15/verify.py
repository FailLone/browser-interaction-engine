"""Verify the committed extracts; this does not rerun the live website."""
import json
from pathlib import Path

root = Path(__file__).parent
before = json.loads((root / 'before-fix.json').read_text())
after = json.loads((root / 'after-fix.json').read_text())
phase = lambda run, name: next(p for p in run['phases'] if p['name'] == name)

waiting = phase(before, '03-chart-waiting')
assert waiting['session']['stopReason'] == 'EXPLORATION_DECISION_REQUIRED'
assert waiting['session']['actionCount'] == 6  # Close + five chart tabs.
assert next(g for g in waiting['groups'] if g['kind'] == 'branch' and g['label'] == '2Y')['status'] == 'pending'
for name in ['04-chart-deferred', '05-chart-defer-stopped', '06-chart-approved']:
    assert phase(before, name)['session']['actionCount'] == 6
assert phase(before, '05-chart-defer-stopped')['session']['stopReason'] == 'EXPLORATION_DEFERRED'
assert phase(before, '07-chart-complete')['session']['actionCount'] == 7
chart = [a for a in before['attempts'] if a['action']['label'] in ['1h', '24h', '1W', '1M', '1Y', '2Y']]
assert [a['action']['label'] for a in chart] == ['1h', '24h', '1W', '1M', '1Y', '2Y']
assert all(a['after']['selectedTabs'] == [a['action']['label']] for a in chart)
fills = [a for a in before['attempts'] if a['action']['kind'] == 'fill']
assert len(fills) == 1 and fills[0]['action']['value'] == '0.01'
assert [c['value'] for c in fills[0]['after']['amounts']] == ['0.01', '807.828']
assert fills[0]['after']['amounts'][0]['identityId'] != fills[0]['after']['amounts'][1]['identityId']
omitted = [f for f in phase(before, '09-input-complete')['selectedFrontier'] if f['action'].get('value') == '100']
assert omitted and all(f['status'] == 'deferred' and f['coverage']['executionStatus'] == 'not_attempted' for f in omitted)
skipped = [f for f in waiting['selectedFrontier'] if f['action']['label'] == 'Trade']
assert any(f['status'] == 'skipped' for f in skipped)
assert all(f['coverage']['executionStatus'] == 'not_attempted' for f in skipped)

for run, defer_name, sample_name in [
    (before, '13-list-deferred-exited', '14-list-sample-approved'),
    (after, '05-list-deferred-exited', '06-list-sample-approved'),
]:
    deferred, approved = phase(run, defer_name), phase(run, sample_name)
    assert deferred['session']['stopReason'] == 'EXPLORATION_DEFERRED'
    assert not deferred['observation']['boundaries']
    assert deferred['session']['actionCount'] == approved['session']['actionCount']
    group = next(g for g in deferred['groups'] if g['kind'] == 'similar-list')
    region = next(g for g in deferred['groups'] if g['kind'] == 'region' and g['label'] == 'listbox')
    assert group['decisions'][-1]['decision']['mode'] == 'defer'
    assert region['decisions'][-1]['decision']['mode'] == 'all'
    assert any(f['action']['label'] == '2Z' and f['status'] == 'deferred' for f in deferred['selectedFrontier'])
    assert any(a['purpose'] == 'recovery' and a['action']['label'] == 'BTC' for a in run['attempts'])
    choices = [a for a in run['attempts'] if a['action']['label'] in ['0G', '1INCH', '2Z', 'A', 'AAOI']]
    assert len(choices) == 1 and choices[0]['action']['label'] == '2Z'
    assert choices[0]['after']['url'].endswith('/convert/2z-to-usd')
    assert choices[0]['before']['instanceScope'] != choices[0]['after']['instanceScope']
    assert run['purposeReviews'][0]['status'] == 'invalidated'
    assert any(e['type'] == 'exploration.group_invalidated' for e in run['events'])
    assert all(a['status'] == 'succeeded' for a in run['attempts'])
    escape = next(a for a in run['attempts'] if a['action']['kind'] == 'press')
    assert escape['after']['boundaries']  # Dispatch success did not prove exit.
    assert not any(a['action']['label'] in ['Log in', 'Sign up', 'Convert BTC to USD', 'Trade'] for a in run['attempts'])

assert len(before['attempts']) == 16
assert any(a['action']['kind'] == 'history' for a in before['attempts'])
assert len(before['recoveries']) == 1 and before['recoveries'][0]['status'] == 'UNREACHABLE'
assert len(after['attempts']) == 7 and not after['recoveries']
assert not any(a['action']['kind'] == 'history' for a in after['attempts'])
assert after['finalObservation']['url'].endswith('/convert/2z-to-usd')
assert phase(after, '07-navigation-paused')['session']['stopReason'] == 'EXPLORATION_DECISION_REQUIRED'
retired = [f for f in after['finalFrontier'] if f.get('reason') == 'boundary_document_changed']
assert retired and all(f['status'] == 'superseded' and not f['attempts'] and f['coverage']['executionStatus'] == 'not_attempted' for f in retired)
print('Recorded real-page scope decisions and navigation-exit regression: PASS')
