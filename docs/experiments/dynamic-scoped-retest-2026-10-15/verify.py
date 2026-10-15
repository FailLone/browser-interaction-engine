from pathlib import Path
from collections import Counter
import json

root = Path(__file__).parent
read = lambda name: json.loads((root / name).read_text())
actions = read('execution-audit.json')
assert len(actions) == 40
attempts = [a for a in actions if a['attemptId']]
assert len(attempts) == len({a['attemptId'] for a in attempts}) == 32
assert all(a['attemptStatus'] == 'succeeded' and a['beforeId'] and a['afterId'] for a in attempts)
assert Counter(a['error'] for a in actions if not a['attemptId']) == {
    'STALE_OBSERVATION': 3, 'ACTION_BLOCKED': 1, 'OBSERVATION_NO_PROGRESS': 1,
    'ACTION_EXCLUDED': 1, 'NOT_FOUND': 2,
}
freeze = read('freeze-audit.json')
assert freeze['actualHead'] == freeze['expectedHead']
assert not freeze['missing'] and not freeze['mismatches'] and not freeze['gitStatus']
observations = read('reentry-diff.json')
assert len(observations) >= 3
assert len({o['parts']['scope']['hash'] for o in observations}) == 1
assert len({o['parts']['regions']['hash'] for o in observations}) > 1
assert any('recordKey' in d['path'] for o in observations for d in o['parts']['regions']['diff'])
popup = read('popup-scroll-audit.json')
assert any(b['code'] == 'outside_active_boundary' for a in popup['currentScrollActions'] for b in a['blockers'])
assert popup['incomingRelations'][0]['ownsViewport'] is True
print('Verified actual attempts, pre-dispatch errors, freeze and independent defect evidence; scoped result remains incomplete.')
