"""Offline verification of archived acceptance claims; never opens a live DB."""
from pathlib import Path
import json,tarfile,hashlib
root=Path(__file__).resolve().parents[1]/'docs/experiments/finite-coverage-loop-2026-10-18'
read=lambda p:json.loads(p.read_text())
a=root/'evidence/run-5';b=root/'evidence/run-6-confirmation'
assert read(a/'source.json')==read(b/'source.json')
assert (a/'source.diff').read_bytes()==(b/'source.diff').read_bytes()==b''
checks=[]
for folder in [a,b]:
 r=read(folder/'result.json');audit=read(folder/'audit.json');protocol=read(folder/'protocol.json');ledger=read(folder/'coverage-ledger.json')
 assert r['passed'] and audit['passed'] and r['status']=='completed'
 assert protocol['wallMs']==240000 and protocol['actions']==80 and len(protocol['branches'])==23
 assert r['elapsedMs']<=240000 and r['actions']<=80 and not r['timedOut']
 assert not r['protocolMissing'] and not r['remaining'] and not r['duplicateCompletedConditionAttempts']
 assert r['completedBeforeRestartPreserved'] and r['restart']['occurred'] and len(set(r['restart']['processes']))==2 and r['restart']['continuedOriginalPendingItemIds']
 assert any(c['passed'] and all(c['checks'].values()) for c in r['reentryChains'])
 assert ledger['finite']['verified']==ledger['finite']['total']==37 and not ledger['finite']['remaining']
 assert not ledger['conditionCombinations']['exhaustive'] and ledger['unknownDependencies']['status']=='unproved'
 with tarfile.open(folder/'persistence.tar.gz') as t:assert 'explorer.sqlite' in t.getnames() and 'task-id' in t.getnames()
 checks.append({'run':folder.name,'passed':True,'elapsedMs':r['elapsedMs'],'actions':r['actions'],'strictChains':[c['itemId'] for c in r['reentryChains'] if c['passed']]})
regression=read(root/'broad-regression-summary.json');assert regression['preexistingFailuresMatchExactly'] and not regression['introducedFailures']
okx=read(root/'evidence/okx-1/result.json');assert not okx['accepted'] and okx['elapsedMs']<=240000 and okx['actions']<=80
assert read(root/'FINAL.json')['okx']['accepted'] is False
print(json.dumps({'archiveChecks':checks,'frozenSourcesEqual':True,'baselineFailuresPreserved':45,'okx':'evaluated_without_verified_reentry'},indent=2))
