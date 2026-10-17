#!/usr/bin/env python3
"""Offline summary of the four 80-trial protocols. No engine/DB/browser imports.

Rebuilds the original summary schema; compares aggregate and explicit per-trial
behavior, retaining observed oracles and guarded dispatch rather than claiming
real-site exhaustiveness. All raw input files remain authoritative evidence.
"""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import re
import statistics
import sys

SCENARIOS = {
    'conditions': ['public-form-cycle', 'shared-id-rebuild', 'price-known', 'price-unknown', 'nonlocal-dependency'],
    'continuation': ['cold_nested_restart', 'failed_recovery_restart', 'unknown_recovery_restart'],
    'inputIdentity': ['distinct-names', 'same-name-named-owners'],
    'recovery': ['nested_static', 'modal_reentry_changed_quote', 'ready_target_ticking_quote', 'nested_changed_quote', 'local_inverse_diverges', 'unknown_outcome_injected'],
}
LIMITS = [
    'Independent local fixtures, no real-site exhaustiveness claim.',
    'No storage byte/CPU measurements in these four protocols.',
    'Small n=5 per scenario; concurrent engineering may affect timings.',
    'Unknown observe-call counts are not measured in this protocol.',
    'All reported coverage comes from explicit fixture event oracles and guarded SDK dispatch.',
]
SCRIPT_NAMES = {
    'conditions': 'scripts/verify-exploration-conditions.ts',
    'continuation': 'scripts/verify-exploration-continuation.ts',
    'inputIdentity': 'scripts/verify-exploration-input-identity.ts',
    'recovery': 'scripts/verify-exploration-recovery.ts',
}
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', re.I)
def read(p): return json.loads(p.read_text())
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def serial(x): return json.dumps(x, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
def pick(x, keys): return {k: x[k] for k in keys if k in x}
def plain(x):
    if isinstance(x, str): return UUID.sub('<id>', re.sub(r'http://127\.0\.0\.1:\d+', 'http://127.0.0.1:<port>', x))
    if isinstance(x, list): return [plain(y) for y in x]
    if isinstance(x, dict): return {k: plain(v) for k,v in x.items()}
    return x
def timing(rows, key):
    vs=[key(r) for r in rows if key(r) is not None]
    return {'medianMs': statistics.median(vs) if vs else None, 'maxMs': max(vs) if vs else None}
def after(row): return next(p for p in row['phases'] if p['phase']=='after_restart')
def before(row): return next(p for p in row['phases'] if p['phase']=='before_restart')
def sums(rows, keys): return {k: sum(int(r['metrics'][k]) for r in rows) for k in keys}
def attempt_view(rows): return [pick(r, ['label','kind','purpose','status','phase','source','replayable','owner']) for r in rows]
def outcome_view(r):
    return plain({**pick(r, ['status','reason','checkpointVerified','currentExecution','executionAuthorized']),
        'checks': r.get('checks', []),
        'strategies': r.get('diagnostics', {}).get('strategies', []),
        'matches': [pick(m, ['equivalent','reason','identityAuthorized','replayAuthorized','currentExecution','policy']) for m in r.get('matches', [])]})
def phase_view(p):
    plan=collections.Counter(serial(pick(x, ['kind','label','status','required','reason'])) for x in p['plan'])
    return {
        **pick(p, ['phase','status','reason','covered','missing','rounds','newSessions','modelRequests']),
        'usage': pick(p['usage'], ['rounds','actions','modelRequests']),
        'planRowsByState': [{'state':json.loads(k),'count':v} for k,v in sorted(plan.items())],
        'unknownAttempts': attempt_view(p['unknownAttempts']),
        'unverifiedRecoveryCount': len(p.get('unverifiedRecoveries', [])),
    }
def behavior(kind, r):
    if kind=='conditions':
        return {
            **pick(r, ['method','expectedBranches','observedBranches','missingBranches','taskStatus','taskReason','errors','modelCalls']),
            'oracle': [pick(e,['branch','sequence']) for e in r['oracle']],
            'metrics': {k:v for k,v in r['metrics'].items() if k!='wallTimeMs'},
            'attempts': attempt_view(r['attempts']),
            'phases': [{**pick(p,['label','currentBranch','oracle','falseCoverage','planRows','pendingPlanRows','attemptCount']),
                'operationKeyCount': len(set(p['operationKeys'])),
                'coverageClaims': [pick(c,['completed']) for c in p['coverageClaims']]} for p in r['phaseRecord']],
        }
    if kind=='continuation':
        return {
            **pick(r,['valid','errors']),
            'oracle': {**pick(r['oracle'], ['mustExecute','covered','missing','newAfterRestart','leafCounts']),
                'lostPending': len(r['oracle']['lostPending']), 'incorrectlySettled':len(r['oracle']['incorrectlySettled']),
                'priorPendingLabels': sorted(x.get('label','') for x in r['oracle']['priorPending'])},
            'oracleEvents': [pick(e,['label','phase','sequence','purpose']) for e in r['oracleEvents']],
            'metrics': {k:v for k,v in r['metrics'].items() if k not in ['elapsedMs','recoveryElapsedMs']},
            'restart': {k:v for k,v in r['restart'].items() if k not in ['priorDocument','nextDocument']},
            'phases': [phase_view(p) for p in r['phases']],
            'attempts': attempt_view(r['attempts']), 'modelCalls':r['modelCalls'],
            'recoveries': [{**pick(x,['api','phase','oracleCovered','actualBrowserRecovery','fault','status','reason']),
                'attemptCount':len(x['attemptIds']), 'result':outcome_view(x.get('result',{}))} for x in r['recoveries']],
            'injectedUnknownCount':len(r['injectedUnknownIds']),
            'injectedUnknownIdsRetained':set(r['injectedUnknownIds']).issubset({a['id'] for a in after(r)['unknownAttempts']}),
        }
    if kind=='inputIdentity':
        return {
            'events':r['events'], 'errors':r['errors'], 'attempts':attempt_view(r['attempts']),
            'checks': [{**pick(c,['phase','expected','actual','reason','sourceValue','targetValue','oracle']),
                'proof':pick(c.get('proof',{}), ['equivalent','reason','identityAuthorized','replayAuthorized','currentExecution','policy'])} for c in r['checks']],
        }
    if 'setupError' in r: return {'setupError':plain(r['setupError'])}
    return plain({
        **pick(r,['reportedArrival','falseArrivalClaim','physicalArrivalWithoutPositiveStatus','guardedBranchYield','oracleBranchYield',
            'entryReopenAttempts','environmentResetAttempts','documentRequestsDuringRecovery','documentChanged','measurementOnlyBrowserActions','targetError','recoveryError']),
        'result':outcome_view(r.get('result',{})),
        'oracle':{k:v for k,v in r['oracle'].items() if k not in ['url','quote']},
        'unknown':{**{k:v for k,v in r['unknown'].items() if k not in ['attemptId','unresolvedAfterRecovery']},
            'unresolvedAfterRecoveryCount':len(r['unknown']['unresolvedAfterRecovery']),
            'injectedIdRetained':not r['unknown'].get('injected') or r['unknown']['attemptId'] in r['unknown']['unresolvedAfterRecovery']},
        'recoveryAttempts':attempt_view(r['recoveryAttempts']), 'setupAttempts':attempt_view(r['setupAttempts']),
        'targetExecution':pick(r.get('targetExecution',{}),['status']),
        'hostAvailability':{**pick(r.get('hostAvailability',{}),['executable']),
            'blockers':[pick(b,['code','reason']) for b in r.get('hostAvailability',{}).get('blockers',[])]},
    })

def build(directory):
    names=['conditions.json','continuation.json','input-identity.json']+[f'recovery-refactor-r{i}.json' for i in range(1,6)]
    raw={name:read(directory/name) for name in names}
    docs={'conditions':[raw[names[0]]], 'continuation':[raw[names[1]]], 'inputIdentity':[raw[names[2]]], 'recovery':[raw[n] for n in names[3:]]}
    rows={'conditions':docs['conditions'][0]['results'], 'continuation':docs['continuation'][0]['runs'],
          'inputIdentity':docs['inputIdentity'][0]['results'], 'recovery':[r for d in docs['recovery'] for r in d['runs']]}
    source_before_manifest=read(directory/'source-before.json'); source_after_manifest=read(directory/'source-after.json')
    source_before=source_before_manifest.get('files',source_before_manifest)
    source_after=source_after_manifest.get('files',source_after_manifest)
    revision=docs['conditions'][0]['sourceRevision']
    summary={'revision':revision,'sourceUnchanged':source_before_manifest==source_after_manifest,'totalTrials':sum(map(len,rows.values())),
             'sameRecoveryApi':'reachExplorationTarget (--variant refactor on both sources)',
             'conditions':{},'continuation':{},'inputIdentity':{},'recovery':{},'limits':LIMITS}
    checks=[]
    def check(name,passed,detail=None):
        item={'name':name,'passed':bool(passed)}
        if detail is not None: item['detail']=detail
        checks.append(item)
    check('sourceUnchanged', source_before_manifest==source_after_manifest)
    check('totalTrials=80',summary['totalTrials']==80)
    check('continuationComplete',docs['continuation'][0]['complete'] is True)
    check('priceTicks=100',docs['conditions'][0]['protocol']['ticks']==100)
    check('allRecoveryVariantRefactor',all(d['variant']=='refactor' for d in docs['recovery']))
    if (directory/'commands.json').exists():
        commands=read(directory/'commands.json')
        check('eightCommandsExitZero',len(commands)==8 and all(c['exitCode']==0 for c in commands))
    if (directory/'execution.json').exists():
        execution=read(directory/'execution.json')
        check('executionComplete',execution.get('allExitZero') is True and execution.get('sourceUnchanged') is True)
    fixture_hashes={}; script_hashes={}; trial_behavior={}
    contracts={
        'conditions':pick(docs['conditions'][0], ['node','protocol']),
        'continuation':pick(docs['continuation'][0], ['node','repeats','methodology']),
        'inputIdentity':pick(docs['inputIdentity'][0], ['node','method']),
        'recovery':{'nodes':sorted({d['node'] for d in docs['recovery']}),
            'variants':sorted({d['variant'] for d in docs['recovery']}),
            'budgets':[json.loads(x) for x in sorted({serial(r.get('budget')) for r in rows['recovery']})]},
    }
    for kind,rr in rows.items():
        check(f'{kind}.scenarioSet',set(r['scenario'] for r in rr)==set(SCENARIOS[kind]))
        script_hashes[kind]=sorted({d['scriptSha256'] for d in docs[kind]})
        check(f'{kind}.scriptHashMatchesManifest',script_hashes[kind]==[source_before[SCRIPT_NAMES[kind]]])
        for index,d in enumerate(docs[kind]):
            declared=d.get('sourceRevision', d.get('revision', d.get('declaredEngineRevision')))
            check(f'{kind}.{index}.revision',bool(declared and (declared.startswith(revision) or revision.startswith(declared))))
            hashes=d.get('sourceHashes',d.get('engineSourceHashes',{}))
            if kind=='continuation': hashes={'packages/explorer-plugin/src/runtime.ts':d['runtimeSha256']}
            check(f'{kind}.{index}.sourceHashesMatchManifest',all(source_before.get(k)==v for k,v in hashes.items()))
        fixture_hashes[kind]={}; trial_behavior[kind]={}
        for scenario in SCENARIOS[kind]:
            group=sorted([r for r in rr if r['scenario']==scenario],key=lambda r:r.get('run',r.get('iteration',r.get('replicate'))))
            run_numbers=[r.get('run',r.get('iteration',r.get('replicate'))) for r in group]
            check(f'{kind}.{scenario}.fiveUniqueRuns',run_numbers==[1,2,3,4,5])
            fixture_hashes[kind][scenario]=sorted({r['fixtureSha256'] for r in group})
            check(f'{kind}.{scenario}.oneFixtureHash',len(fixture_hashes[kind][scenario])==1)
            trial_behavior[kind][scenario]=[plain(behavior(kind,r)) for r in group]
            if kind=='conditions':
                entry={'trials':len(group),'allDeclaredBranchesExecuted':sum(not r['missingBranches'] for r in group),
                    'missingBranches':[r['missingBranches'] for r in group], 'errors':sum(len(r['errors']) for r in group),
                    'falseCoverageClaims':sum(r['metrics']['falseCoverageChecks'] for r in group),
                    'observedStateCounts':[r['metrics']['observedStateCount'] for r in group],
                    'metricsSum':sums(group,['actualActions','successfulActions','recoveryActions','oracleClicks','newDistinctBranches','duplicateOracleClicks','jevCalls','llmCalls']),
                    **timing(group,lambda r:r['metrics']['wallTimeMs'])}
                if scenario.startswith('price-'):
                    initial=[next(p for p in r['phaseRecord'] if p['label']=='after-initial') for r in group]
                    entry.update(tickPlanGrowth=[r['phaseRecord'][-1]['planRows']-p['planRows'] for r,p in zip(group,initial)],
                        tickPendingGrowth=[r['phaseRecord'][-1]['pendingPlanRows']-p['pendingPlanRows'] for r,p in zip(group,initial)],
                        tickRetryKeyCounts=[r['metrics']['priceTickRetryKeyCount'] for r in group])
                summary[kind][scenario]=entry
                for i,r in enumerate(group,1):
                    key=f'{kind}.{scenario}.{i}'
                    observed={e['branch'] for e in r['oracle']}
                    check(key+'.oracleConsistent',observed==set(r['observedBranches']) and set(r['missingBranches'])==set(r['expectedBranches'])-observed and len(r['oracle'])==r['metrics']['oracleClicks'])
                    check(key+'.attemptCountsConsistent',len(r['attempts'])==r['metrics']['actualActions'] and sum(a['status']=='succeeded' for a in r['attempts'])==r['metrics']['successfulActions'])
                    check(key+'.stateKeyCountsConsistent',len({x['stateId'] for x in r['keyRows']})==r['metrics']['observedStateCount'] and len({x['key'] for x in r['keyRows']})==r['metrics']['retryKeyCount'])
                    check(key+'.branchOracleComplete',not r['missingBranches'] and not r['errors'] and r['metrics']['falseCoverageChecks']==0)
                    if scenario.startswith('price-'):
                        phases=[p for p in r['phaseRecord'] if p['label'].startswith('price-tick-')]
                        p=next(p for p in r['phaseRecord'] if p['label']=='after-initial')
                        check(key+'.all100Ticks', [x['label'] for x in phases]==[f'price-tick-{j}' for j in range(1,101)])
                        check(key+'.all100TicksNoGrowth',all(x['planRows']==p['planRows'] and x['pendingPlanRows']==p['pendingPlanRows'] for x in phases))
            elif kind=='continuation':
                entry={'trials':len(group),'valid':sum(r['valid'] for r in group),'errors':sum(len(r['errors']) for r in group),
                    'missingBranches':[r['oracle']['missing'] for r in group], 'lostPending':sum(len(r['oracle']['lostPending']) for r in group),
                    'incorrectlySettled':sum(len(r['oracle']['incorrectlySettled']) for r in group),
                    'metricsSum':sums(group,['incorrectCompletion','successfulExplorationAfterInjectedUnknown','duplicateLeafExecutions','necessaryReentries','unnecessaryReentries','repeatedNoProgressRecoveries','jev','llm']),
                    **timing(group,lambda r:r['metrics']['elapsedMs'])}
                if scenario=='unknown_recovery_restart':
                    entry['unknownRetained']=sum(r['metrics']['unknownRetained'] for r in group)
                    entry['afterRestart']={'newSessions':sum(after(r)['newSessions'] for r in group),
                        'attempts':sum(sum(a['phase']=='after_restart' for a in r['attempts']) for r in group),
                        'recoveries':sum(sum(a['phase']=='after_restart' for a in r['recoveries']) for r in group),
                        'jev':sum(after(r)['modelRequests']['jev'] for r in group), 'llm':sum(after(r)['modelRequests']['llm'] for r in group),
                        'observeCalls':'not measured by this protocol'}
                summary[kind][scenario]=entry
                for i,r in enumerate(group,1):
                    key=f'{kind}.{scenario}.{i}'
                    check(key+'.validNoLostPending',r['valid'] and not r['errors'] and not r['oracle']['lostPending'] and not r['oracle']['incorrectlySettled'])
                    check(key+'.modelCallsConsistent',all(sum(m['actor']==a for m in r['modelCalls'])==r['metrics'][a] for a in ['jev','llm']))
                    if scenario=='unknown_recovery_restart':
                        b,a=before(r),after(r)
                        check(key+'.unknownIdsPreserved',bool(r['injectedUnknownIds']) and set(r['injectedUnknownIds']).issubset({x['id'] for x in a['unknownAttempts']}) and a['unknownAttempts']==b['unknownAttempts'])
                        check(key+'.blockedNoPostRestartDispatch',a['status']=='blocked' and a['reason']=='UNKNOWN_DISPATCH_REQUIRES_REVIEW' and a['newSessions']==0 and a['modelRequests']=={'jev':0,'llm':0} and not any(x['phase']=='after_restart' for x in r['attempts']+r['recoveries']) and not r['metrics']['successfulExplorationAfterInjectedUnknown'])
                    if scenario=='cold_nested_restart':
                        check(key+'.nestedReentryWithoutDuplicateLeaf',not r['oracle']['missing'] and r['metrics']['necessaryReentries']>0 and r['metrics']['duplicateLeafExecutions']==0 and r['metrics']['unnecessaryReentries']==0)
            elif kind=='inputIdentity':
                for i,r in enumerate(group,1):
                    key=f'{kind}.{scenario}.{i}'
                    check(key+'.fourCorrectCorrespondences',len(r['checks'])==4 and all(c['actual']==c['expected'] for c in r['checks']))
                    check(key+'.sameInputValue',all(c['sourceValue']=='sample' and c['targetValue']=='sample' for c in r['checks']))
                    check(key+'.actualABCInputs',r['events']==[{'branch':b,'value':'sample'} for b in ['A','B','C']] and all(a['status']=='succeeded' for a in r['attempts']) and len(r['attempts'])==3 and not r['errors'])
            else:
                summary[kind][scenario]={'trials':len(group), 'setupErrors':[r['setupError'] for r in group if r.get('setupError')],
                    'positiveStatus':sum(bool(r.get('reportedArrival')) for r in group),
                    'physicalArrival':sum(bool(r.get('oracle',{}).get('physicalArrival')) for r in group),
                    'guardedBranchYield':sum(bool(r.get('guardedBranchYield')) for r in group),
                    'falseArrivalClaims':sum(bool(r.get('falseArrivalClaim')) for r in group),
                    'recoveryAttempts':sum(len(r.get('recoveryAttempts',[])) for r in group),
                    'unknownBlocked':sum(bool(r.get('unknown',{}).get('guardedDispatchBlocked')) for r in group),
                    **timing(group,lambda r:r.get('durationMs'))}
                for i,r in enumerate(group,1):
                    key=f'{kind}.{scenario}.{i}'
                    check(key+'.noSetupFailure',not r.get('setupError'))
                    if r.get('setupError'): continue
                    check(key+'.falseArrivalConsistent',r['falseArrivalClaim']==(r['reportedArrival'] and not r['oracle']['physicalArrival']) and not r['falseArrivalClaim'])
                    if scenario=='unknown_outcome_injected':
                        u=r['unknown']; check(key+'.unknownGuardPreserved',u['injected'] and u['attemptId'] in u['unresolvedAfterRecovery'] and u['originalStatusAfterMeasurement']=='unknown' and u['guardedDispatchBlocked'] and not r['reportedArrival'] and not r['guardedBranchYield'])
                    elif scenario=='local_inverse_diverges': check(key+'.divergenceNotSuccess',not r['reportedArrival'] and not r['guardedBranchYield'])
                    else: check(key+'.guardedPhysicalSuccess',r['reportedArrival'] and r['oracle']['physicalArrival'] and r['guardedBranchYield'])
    inputs=rows['inputIdentity']
    summary['inputIdentity']={'trials':len(inputs),'errors':sum(len(r['errors']) for r in inputs),'checks':sum(len(r['checks']) for r in inputs),
        'correctCorrespondences':sum(sum(c['expected']==c['actual'] for c in r['checks']) for r in inputs),
        'successfulActualInputs':sum(sum(a['status']=='succeeded' for a in r['attempts']) for r in inputs)}
    validation={'inputDirectory':str(directory.resolve()), 'revision':revision, 'allPassed':all(c['passed'] for c in checks),
        'checks':checks,'fixtureHashes':fixture_hashes,'scriptHashes':script_hashes,'measurementContracts':contracts,'sourceFileCount':len(source_before),
        'rawFileHashes':{n:sha(directory/n) for n in names+['source-before.json','source-after.json','commands.json','execution.json'] if (directory/n).exists()}}
    return summary,trial_behavior,validation

def differences(a,b,path=''):
    if isinstance(a,dict) and isinstance(b,dict):
        out=[]
        for k in sorted(set(a)|set(b)):
            p=f'{path}.{k}' if path else k
            if k not in a or k not in b: out.append({'path':p,'baseline':a.get(k),'current':b.get(k),'missingIn':'baseline' if k not in a else 'current'})
            else: out.extend(differences(a[k],b[k],p))
        return out
    if isinstance(a,list) and isinstance(b,list):
        if len(a)!=len(b):return [{'path':path,'baseline':a,'current':b}]
        return [d for i,(x,y) in enumerate(zip(a,b)) for d in differences(x,y,f'{path}[{i}]')]
    return [] if a==b else [{'path':path,'baseline':a,'current':b}]
def aggregate_behavior(s):
    if isinstance(s,dict): return {k:aggregate_behavior(v) for k,v in s.items() if k not in ['revision','sourceUnchanged','medianMs','maxMs']}
    if isinstance(s,list): return [aggregate_behavior(v) for v in s]
    return s
def distribution(rows):
    counts=collections.Counter(map(serial,rows))
    return [{'behavior':json.loads(k),'trials':v} for k,v in sorted(counts.items())]
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-dir',type=Path,required=True)
    parser.add_argument('--baseline-dir',type=Path,required=True)
    parser.add_argument('--output-dir',type=Path,required=True)
    args=parser.parse_args()
    baseline,bb,bv=build(args.baseline_dir)
    current,cb,cv=build(args.input_dir)
    old=read(args.baseline_dir/'summary.json')
    reproduced=differences(old,baseline)
    aggregate_diff=differences(aggregate_behavior(baseline),aggregate_behavior(current))
    detailed={}
    for kind in SCENARIOS:
        detailed[kind]={}
        for scenario in SCENARIOS[kind]:
            x,y=distribution(bb[kind][scenario]),distribution(cb[kind][scenario])
            ds=differences(x,y)
            detailed[kind][scenario]={'equal':not ds,'baselineDistinctBehaviors':len(x),'currentDistinctBehaviors':len(y),'differences':ds}
    provenance={'scriptHashesEqual':bv['scriptHashes']==cv['scriptHashes'],'fixtureHashesEqual':bv['fixtureHashes']==cv['fixtureHashes'],
        'measurementContractsEqual':bv['measurementContracts']==cv['measurementContracts']}
    comparison={'baselineRevision':baseline['revision'],'currentRevision':current['revision'],
        'baselineSummaryReproduced':not reproduced,'baselineSummaryReconstructionDifferences':reproduced,
        'aggregateBehaviorEqual':not aggregate_diff,'aggregateBehaviorDifferences':aggregate_diff,
        'perScenarioBehaviorEqual':all(x['equal'] for group in detailed.values() for x in group.values()),
        'perScenario':detailed,'provenance':provenance,
        'comparisonScope':{'aggregate':'Original summary fields, excluding revision, sourceUnchanged, medianMs and maxMs.',
            'detailed':'Explicit behavior projections, compared as per-scenario trial multisets; iteration order has no semantic role.',
            'excluded':'Timestamps/durations, random IDs, ephemeral local URL ports, opaque identity/retry hashes, passive quote values, full proof text, raw plans and events. Raw JSON remains authoritative; retained plan state counts and unknown-ID equality checks preserve multiplicity and cross-restart identity.',
            'retained':'Oracle events, actual A/B/C input values, correspondence expectations/results, status/reasons, action purposes, unknown preservation/guards, necessary reentries, round/action/model budgets, all 100 price tick row counts.',
            'performance':'Timings are retained in summary for provenance only; these trials do not establish storage or real-site performance.'}}
    all_valid=bv['allPassed'] and cv['allPassed'] and not reproduced and all(provenance.values())
    report={'allIntegrityChecksPassed':all_valid,'summarizerSha256':sha(Path(__file__)), 'baseline':bv,'current':cv}
    args.output_dir.mkdir(parents=True,exist_ok=True)
    for name,value in [('summary.json',current),('comparison.json',comparison),('validation.json',report),('behavior.json',cb)]:
        (args.output_dir/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'outputDirectory':str(args.output_dir.resolve()),'allIntegrityChecksPassed':all_valid,
        'baselineSummaryReproduced':not reproduced,'aggregateBehaviorEqual':not aggregate_diff,
        'perScenarioBehaviorEqual':comparison['perScenarioBehaviorEqual'],'failedChecks':[{'side':side,**c} for side,v in [('baseline',bv),('current',cv)] for c in v['checks'] if not c['passed']],
        'aggregateBehaviorDifferences':aggregate_diff,'baselineSummaryReconstructionDifferences':reproduced},ensure_ascii=False,indent=2))
    return 0 if all_valid else 2
if __name__=='__main__': sys.exit(main())
