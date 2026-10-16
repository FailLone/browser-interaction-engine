"""Summarize independently executed protocol JSON; never infer coverage from queue state."""
from pathlib import Path
from collections import defaultdict
from statistics import median
import hashlib
import json
import sys

root = Path(sys.argv[1]).resolve()
read = lambda name: json.loads((root / name).read_text())
groups = lambda rows: {key: [r for r in rows if r['scenario'] == key] for key in dict.fromkeys(r['scenario'] for r in rows)}
before = read('source-before.json')
after = read('source-after.json')
summary = {'revision': read('setup.json')['revision'], 'sourceUnchanged': before == after,
           'totalTrials': 0, 'sameRecoveryApi': 'reachExplorationTarget (--variant refactor on both sources)',
           'conditions': {}, 'continuation': {}, 'inputIdentity': {}, 'recovery': {}}
conditions = read('conditions.json')['results']
continuation = read('continuation.json')['runs']
inputs = read('input-identity.json')['results']
recoveries = [r for i in range(1, 6) for r in read(f'recovery-refactor-r{i}.json')['runs']]
summary['totalTrials'] = sum(map(len, [conditions, continuation, inputs, recoveries]))
for name, rows in groups(conditions).items():
    r = {'trials': len(rows), 'allDeclaredBranchesExecuted': sum(not x['missingBranches'] for x in rows),
         'missingBranches': [x['missingBranches'] for x in rows], 'errors': sum(len(x['errors']) for x in rows),
         'falseCoverageClaims': sum(x['metrics']['falseCoverageChecks'] for x in rows),
         'observedStateCounts': [x['metrics']['observedStateCount'] for x in rows],
         'metricsSum': {k: sum(x['metrics'][k] for x in rows) for k in ['actualActions', 'successfulActions', 'recoveryActions', 'oracleClicks', 'newDistinctBranches', 'duplicateOracleClicks', 'jevCalls', 'llmCalls']},
         'medianMs': median(x['metrics']['wallTimeMs'] for x in rows), 'maxMs': max(x['metrics']['wallTimeMs'] for x in rows)}
    if name.startswith('price-'):
        for label, field in [('tickPlanGrowth', 'planRows'), ('tickPendingGrowth', 'pendingPlanRows')]:
            r[label] = [x['phaseRecord'][-1][field] - next(p for p in x['phaseRecord'] if p['label'] == 'after-initial')[field] for x in rows]
        r['tickRetryKeyCounts'] = [x['metrics']['priceTickRetryKeyCount'] for x in rows]
    summary['conditions'][name] = r
for name, rows in groups(continuation).items():
    r = {'trials': len(rows), 'valid': sum(x['valid'] for x in rows), 'errors': sum(len(x['errors']) for x in rows),
         'missingBranches': [x['oracle']['missing'] for x in rows],
         'lostPending': sum(len(x['oracle']['lostPending']) for x in rows),
         'incorrectlySettled': sum(len(x['oracle']['incorrectlySettled']) for x in rows),
         'metricsSum': {k: sum(x['metrics'][k] for x in rows) for k in ['incorrectCompletion', 'successfulExplorationAfterInjectedUnknown', 'duplicateLeafExecutions', 'necessaryReentries', 'unnecessaryReentries', 'repeatedNoProgressRecoveries', 'jev', 'llm']},
         'medianMs': median(x['metrics']['elapsedMs'] for x in rows), 'maxMs': max(x['metrics']['elapsedMs'] for x in rows)}
    if name == 'unknown_recovery_restart':
        phases = [next(p for p in x['phases'] if p['phase'] == 'after_restart') for x in rows]
        r['unknownRetained'] = sum(x['metrics']['unknownRetained'] for x in rows)
        r['afterRestart'] = {'newSessions': sum(p['newSessions'] for p in phases),
                             'attempts': sum(sum(a['phase'] == 'after_restart' for a in x['attempts']) for x in rows),
                             'recoveries': sum(sum(a['phase'] == 'after_restart' for a in x['recoveries']) for x in rows),
                             'jev': sum(p['modelRequests']['jev'] for p in phases), 'llm': sum(p['modelRequests']['llm'] for p in phases),
                             'observeCalls': 'not measured by this protocol'}
    summary['continuation'][name] = r
summary['inputIdentity'] = {'trials': len(inputs), 'errors': sum(len(x['errors']) for x in inputs),
                            'checks': sum(len(x['checks']) for x in inputs),
                            'correctCorrespondences': sum(sum(c['expected'] == c['actual'] for c in x['checks']) for x in inputs),
                            'successfulActualInputs': sum(sum(a['status'] == 'succeeded' for a in x['attempts']) for x in inputs)}
for name, rows in groups(recoveries).items():
    summary['recovery'][name] = {'trials': len(rows), 'setupErrors': [x['setupError'] for x in rows if x.get('setupError')],
                                'positiveStatus': sum(x.get('reportedArrival', False) for x in rows),
                                'physicalArrival': sum(x.get('oracle', {}).get('physicalArrival', False) for x in rows),
                                'guardedBranchYield': sum(x.get('guardedBranchYield', False) for x in rows),
                                'falseArrivalClaims': sum(x.get('falseArrivalClaim', False) for x in rows),
                                'recoveryAttempts': sum(len(x.get('recoveryAttempts', [])) for x in rows),
                                'unknownBlocked': sum(x.get('unknown', {}).get('guardedDispatchBlocked', False) for x in rows),
                                'medianMs': median(x['durationMs'] for x in rows), 'maxMs': max(x['durationMs'] for x in rows)}
summary['limits'] = ['Independent local fixtures, no real-site exhaustiveness claim.',
                     'No storage byte/CPU measurements in these four protocols.',
                     'Small n=5 per scenario; concurrent engineering may affect timings.',
                     'Unknown observe-call counts are not measured in this protocol.',
                     'All reported coverage comes from explicit fixture event oracles and guarded SDK dispatch.']
(root / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
files = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob('*')) if p.is_file() and p.name != 'files.json'}
(root / 'files.json').write_text(json.dumps(files, indent=2) + '\n')
print(json.dumps(summary, indent=2))
