// One offline target query. No plugin start, driver, permissions or cursor edits.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserEngine, browserTargetConditions } from '@interaction/browser';
import { PlaywrightAdapter } from '@interaction/adapter-playwright';
import { SqliteStore } from '@interaction/storage-sqlite';
import { matches, scopeFor } from '../../../../../packages/explorer-plugin/src/policy.js';

const out = fileURLToPath(new URL('.', import.meta.url)), root = resolve(out, '../../../../..');
const source = join(root, '.data/okx-plugin-loop-20261018-v3/engine');
const auditPath = join(out, '../plugin-loop-3/audit.json');
const audit = JSON.parse(readFileSync(auditPath, 'utf8')), target = audit.targetAfter;
const sid = audit.durableReceipts.at(-1).sessionId, afterId = audit.durableReceipts.at(-1).afterId;
const hash = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
const sha = (p: string) => hash(readFileSync(p));
const files = ['engine.sqlite', 'engine.sqlite-wal', 'engine.sqlite-shm'].filter(n => existsSync(join(source, n)));
const hashes = () => Object.fromEntries(files.map(n => [n, sha(join(source, n))]));
if (existsSync(join(out, 'query-result.json')) || !existsSync(join(out, 'result.json')) || audit.ownedGroupRemaining.length || audit.sourceUnchanged !== true) throw Error('Invalid single-use frozen input');
const sourceBefore = hashes(), owned = mkdtempSync(join(tmpdir(), 'bie-loop3-target-')), directory = join(owned, 'engine');
mkdirSync(directory); writeFileSync(join(owned, 'owner.txt'), 'plugin-loop-target-review');
for (const name of files) copyFileSync(join(source, name), join(directory, name));
let store: SqliteStore | undefined, engine: BrowserEngine | undefined, driverCalls = 0, phase = 'constructor';
const writes: Record<string, number> = {}, record: any = {
  priorFailure:{path:join(out,'result.json'),sha256:sha(join(out,'result.json')),retryReason:'Constructor recovery conflicts with a blanket query-only guard; permit existing recovery only in the exclusive copy, then prohibit query writes.'},
  scriptSha256:sha(fileURLToPath(import.meta.url)),constructorWrites:[],
  source, sourceBefore, audit: { path: auditPath, sha256: sha(auditPath) }, sourceInventorySha256: audit.sourceFullInventorySha256,
  temporaryDirectory: owned, target: { itemId: target.id, occurrenceId: audit.targetOccurrence, scope: target.scope },
  limits: 'Only Trade-after and final observations, the original target reference, current facts and directly related review/identity/group records. No historical availability reconstruction.',
};
const createDriver = PlaywrightAdapter.prototype.createDriver;
PlaywrightAdapter.prototype.createDriver = () => { driverCalls++; throw Error('OFFLINE_DRIVER_FORBIDDEN'); };
try {
  store = new SqliteStore(directory);
  for (const method of ['put', 'event', 'recordRequest'] as const) {
    const original=(store as any)[method].bind(store);
    (store as any)[method]=(...args:any[])=>{
      const key=`${phase}.${method}`;writes[key]=(writes[key]||0)+1;
      if(phase!=='constructor')throw Error(`OFFLINE_WRITE_FORBIDDEN:${method}`);
      const before=method==='put'?store!.get<any>(args[0],args[1].id):undefined;
      const value=original(...args);
      record.constructorWrites.push(method==='put'?{method,kind:args[0],id:args[1].id,
        beforeSha256:hash(JSON.stringify(before??null)),afterSha256:hash(JSON.stringify(args[1])),
        changedFields:Object.keys({...before,...args[1]}).filter(k=>JSON.stringify(before?.[k])!==JSON.stringify(args[1][k])).map(k=>({key:k,before:before?.[k],after:args[1][k]}))}:{method,sessionId:args[0],type:args[1]});
      return value;
    };
  }
  const total = () => (store!.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n, initialChanges = total();
  engine = new BrowserEngine({ persistence: store });
  record.constructorSqlChanges=total()-initialChanges;phase='query';store.db.pragma('query_only=ON');const queryChanges=total();
  const current = engine.observation(sid), snap = engine.explorationSnapshot(sid, current.id, { includeHistoryAudit: false });
  const observations = [engine.observation(sid, afterId), current];
  record.observations = observations.map(o => {
    const controls = o.controls.filter(c => c.name === target.scope.label || c.label === target.scope.label);
    const ids = new Set(controls.map(c => c.localId)), actions = engine!.actions(sid, o.id).filter(a => ids.has(a.localId || ''));
    return { id: o.id, logicalSha256: hash(JSON.stringify(o)), url: o.url, instanceScope: o.instanceScope, stable: o.stable,
      gaps: o.gaps, targetControls: controls.map(c => ({ localId:c.localId, instanceId:c.instanceId, identityId:c.identityId,
        hypothesisId:c.hypothesisId, identityScope:c.identityScope, region:c.region, visible:c.visible, enabled:c.enabled,
        actionable:c.actionable, readiness:c.readiness, selector:c.selector, actionBasis:c.actionBasis })),
      actions: actions.map(a => { const actual = scopeFor(a,o); return { id:a.id, kind:a.kind, label:a.label, value:a.value,
        source:a.source, risk:a.risk, replayable:a.replayable, basis:a.basis, excluded:a.excluded, exclusionReason:a.exclusionReason,
        preconditions:a.preconditions, target:a.target, literalOriginalScopeMatches:matches(target.scope,a,o),
        scopeDifferences:Object.entries(target.scope).filter(([key,value])=>JSON.stringify((actual as any)[key])!==JSON.stringify(value)).map(([key,value])=>({key,expectedSha256:hash(JSON.stringify(value)),actualSha256:hash(JSON.stringify((actual as any)[key]??null))})),
        portableTargetConditions:browserTargetConditions(a,o) || null,
        currentAvailability:o.id===current.id?snap.availability.actions.find(row=>row.actionId===a.id):null }; }),
      historicalAvailabilityNotQueried:o.id!==current.id,
      candidateRegions:(o.regionCandidates||[]).filter(r=>r.controlIds.some(id=>ids.has(id))).map(r=>({id:r.id,label:r.label,controlIds:r.controlIds.filter(id=>ids.has(id))})),
    };
  });
  const ids = new Set(record.observations[1].targetControls.map((c:any)=>c.localId));
  const actions = snap.actions.filter(a=>ids.has(a.localId));
  record.current = { id:current.id, session: {status:engine.session(sid).status,dirty:engine.session(sid).dirty},
    obligations:Object.fromEntries(['regions','classifications','operations'].map(key=>[key,(snap.obligations as any)[key].filter((id:string)=>ids.has(id))])),
    targetFacts:snap.facts.filter(f=>('localId' in f && ids.has(f.localId)) || ('actionId' in f && actions.some(a=>a.id===f.actionId))),
    hypotheses:snap.hypotheses.filter(h=>ids.has(h.localId)),
    classifications:snap.classifications.controls.filter(c=>ids.has(c.control.localId)).map(c=>({localId:c.control.localId,needsClassification:c.needsClassification,classifications:c.classifications})),
    operationReviews:snap.operations.controls.filter(c=>ids.has(c.control.localId)).map(c=>({localId:c.control.localId,reviews:c.reviews})),
    regionReview:{id:snap.regions.review?.id,observationId:snap.regions.review?.observationId,status:snap.regions.review?.status,
      targetRegions:snap.regions.review?.regions.filter(r=>r.controlIds.some(id=>ids.has(id))).map(r=>({key:r.key,label:r.label,status:r.status,reviewId:r.reviewId,controlIds:r.controlIds.filter(id=>ids.has(id))})),
      unassignedTargetIds:snap.regions.unassignedControlIds.filter(id=>ids.has(id)),
      faqRegions:snap.regions.review?.regions.filter(r=>/FAQ|frequently|How much|What is|How to/i.test(r.label)).map(r=>({key:r.key,label:r.label,status:r.status,containsTarget:r.controlIds.some(id=>ids.has(id))}))},
    relevantGroups:snap.groups.filter(g=>g.members.some(m=>actions.some(a=>a.id===m.actionId))).map(g=>({id:g.id,label:g.label,status:g.status,conditions:g.conditions,decision:g.decision,
      targetMembers:g.members.filter(m=>actions.some(a=>a.id===m.actionId))})),
    targetCorrespondences:engine.explorationTargetCorrespondences(sid,{observationId:current.id,requests:actions.filter(a=>a.kind==='click').map(a=>({actionId:a.id,source:audit.guardedReentry[0].data.source}))}),
  };
  record.querySqlChanges=total()-queryChanges;
} catch (error) { record.error=String(error); process.exitCode=1; }
finally {
  if(engine)await engine.close();else store?.close();
  PlaywrightAdapter.prototype.createDriver=createDriver;
  record.driverCalls=driverCalls;record.writeAttempts=writes;record.sourceAfter=hashes();record.sourceUnchanged=JSON.stringify(sourceBefore)===JSON.stringify(record.sourceAfter);
  if(readFileSync(join(owned,'owner.txt'),'utf8')!=='plugin-loop-target-review')throw Error('Ownership lost');
  rmSync(owned,{recursive:true});record.temporaryCopyRemoved=!existsSync(owned);
  writeFileSync(join(out,'query-result.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
}
console.log(JSON.stringify({output:join(out,'query-result.json'),error:record.error,sourceUnchanged:record.sourceUnchanged,driverCalls,writes}));
