// Frozen chronological inputs, disposable database copy, real origin receipts
// only. Counterfactual sampling is not browser execution or verified coverage.
import {mkdirSync,copyFileSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
import {SqliteStore} from '@interaction/storage-sqlite';
import {browserTraversalFragments} from '../../../packages/adapter-playwright/src/fragment-projection.ts';
import {browserFragmentObservedEffect,browserFragmentEffectComparison} from '../../../packages/adapter-playwright/src/fragment-outcome.ts';
import {fragmentFixture} from '../../../tests/fragment-storage-helpers.ts';
import {preferFragmentCandidate} from '../../../packages/explorer-plugin/src/fragment-traversal.ts';
const input=resolve(process.argv[2]),output=resolve(process.argv[3]);mkdirSync(output,{recursive:false});mkdirSync(join(output,'copy'));
copyFileSync(join(input,'engine/engine.sqlite'),join(output,'copy/engine.sqlite'));
const oldSource=execFileSync('git',['show','682838f:packages/adapter-playwright/src/fragment-projection.ts'],{encoding:'utf8'})
 .replaceAll("'./fragment-conditions.js'",JSON.stringify(pathToFileURL(resolve('packages/adapter-playwright/src/fragment-conditions.ts')).href))
 .replaceAll("'./types.js'",JSON.stringify(pathToFileURL(resolve('packages/adapter-playwright/src/types.ts')).href));
writeFileSync(join(output,'projection-v3.ts'),oldSource);
const old=(await import(pathToFileURL(join(output,'projection-v3.ts')).href)).browserTraversalFragments;
const ledger=JSON.parse(readFileSync(join(input,'fragment-audit.json'))),actualOrigins=new Map(ledger.events.map(e=>[e.id,e]));
const timeline=readFileSync(join(input,'timeline.jsonl'),'utf8').trim().split('\n').map(JSON.parse),store=new SqliteStore(join(output,'copy'));
const includeCurrentEffects=process.argv.includes('--current-effects');
const fixtures=Array.from({length:includeCurrentEffects?3:2},()=>fragmentFixture()),models=fixtures.map((fixture,i)=>({fixture,project:i?browserTraversalFragments:old,currentEffects:i===2,fronts:new Map(),origins:[],stages:{},rows:[],originChecks:[]}));
const sourceCache=new Map(),source=id=>{if(sourceCache.has(id))return sourceCache.get(id);const o=store.require('observation',id),actions=store.listByObservation('action',o.sessionId,id),value={o,actions};sourceCache.set(id,value);if(sourceCache.size>2)sourceCache.delete(sourceCache.keys().next().value);return value;};
function register(m,id){
 if(m.fronts.has(id))return m.fronts.get(id);
 const {o,actions}=source(id),diagnostics=new Map(),projections=m.project(o,actions,ledger.authority,diagnostics),byAction=new Map();
 m.fixture.session.authority(ledger.authority);
 for(const p of projections){const record=m.fixture.session.register(o.url,p,{sessionId:o.sessionId,observationId:o.id,regionId:p.regionId},p.parentRegionId);
  p.candidates.forEach((c,i)=>byAction.set(c.actionId,{fragmentId:record.fragment.id,candidateId:record.candidates[i].id,regionId:p.regionId,projection:p,candidate:c}));}
 m.fixture.writer.flush();const front={observationId:id,byAction,diagnostics};m.fronts.set(id,front);return front;
}
try{
 for(const row of timeline){if(row.type!=='plugin.event')continue;const e=row.data,d=e.data;
  if(e.type==='fragment.frontier')for(const m of models)register(m,d.observationId);
  if(e.type==='fragment.access_recorded'){
   const saved=actualOrigins.get(d.attemptId);if(!saved)throw Error('MISSING_ACTUAL_ORIGIN');
   const attempt=store.require('attempt',d.attemptId);if(attempt.status!=='succeeded'||attempt.beforeId!==saved.observationId||attempt.afterId!==saved.afterId)throw Error('ACTUAL_RECEIPT_MISMATCH');
   for(const m of models){const ref=register(m,attempt.beforeId).byAction.get(attempt.action.id);if(!ref)continue;
    // The first two variants isolate mapping with byte-exact frozen effects.
    // The optional third uses the current effect projection over these same
    // actual receipt-bound observations, without adding any later sources.
    const material=m.currentEffects?browserFragmentObservedEffect(source(attempt.beforeId).o,source(attempt.afterId).o,{regionId:ref.regionId,localId:attempt.action.localId})?.material:saved.effect,event={id:attempt.id,fragmentId:ref.fragmentId,candidateId:ref.candidateId,sessionId:attempt.sessionId,observationId:attempt.beforeId,afterId:attempt.afterId,actionId:attempt.action.id,...material?{effect:m.fixture.session.material('effect',material)}:{}};
    m.fixture.session.put('events',event);m.fixture.writer.flush();m.origins.push({...ref,event,label:attempt.action.label,effect:material});
    const peers=m.origins.filter(x=>x.projection.structure===ref.projection.structure&&x.projection.owner===ref.projection.owner&&x.candidate.path===ref.candidate.path&&x.candidate.operation===ref.candidate.operation&&x.candidate.guard===ref.candidate.guard);
    m.originChecks.push({sequence:e.sequence,attemptId:attempt.id,label:attempt.action.label,sourceIds:peers.map(x=>x.event.id),contexts:new Set(peers.map(x=>x.candidate.context)).size,
     effectVariants:new Set(peers.filter(x=>x.effect).map(x=>browserFragmentEffectComparison(x.effect))).size,missingEffects:peers.filter(x=>!x.effect).length,sampling:m.fixture.session.sampling(ref.candidateId)});
   }
  }
  if(e.type!=='fragment.candidates_ranked')continue;
  for(const m of models){const front=register(m,d.observationId),items=[];
   for(const c of d.current){const ref=front.byAction.get(c.actionId);let stage,decision,origins=[],potential=[];
    if(!ref)stage='unmapped:'+front.diagnostics.get(c.actionId);
    else{
     potential=m.origins.filter(x=>x.projection.structure===ref.projection.structure&&x.candidate.path===ref.candidate.path&&x.candidate.operation===ref.candidate.operation);
     origins=potential.filter(x=>x.projection.owner===ref.projection.owner&&x.candidate.guard===ref.candidate.guard);
     decision=m.fixture.session.sampling(ref.candidateId);
     stage=origins.length?decision.status:!potential.length?'no_actual_local_origin':!potential.some(x=>x.projection.owner===ref.projection.owner)?'owner_mismatch':'guard_mismatch';
    }
    m.stages[stage]=(m.stages[stage]||0)+1;
    items.push({...c,stage,sampling:decision?.status,sourceCount:origins.length,contexts:new Set(origins.map(x=>x.candidate.context)).size,
     originIds:origins.map(x=>x.event.id),potentialOriginIds:potential.map(x=>x.event.id),untriedAfter:decision?decision.sourceCount===0:c.untried});
   }
   const choices=items.filter(c=>c.untriedAfter&&c.deferredReason!=='exact_current_url'),best=preferFragmentCandidate(m.fixture.session,front,choices);
   m.rows.push({sequence:e.sequence,observationId:d.observationId,originalReason:d.reason,originalSelectedItemId:d.selectedItemId,omitted:d.omitted,items,bestOnLoggedOrder:best?.itemId});
  }
 }
 const changes=models[0].rows.flatMap((a,i)=>{const b=models[1].rows[i];return a.items.flatMap((x,j)=>{const y=b.items[j];return x.stage===y.stage&&x.untriedAfter===y.untriedAfter?[]:[{sequence:a.sequence,observationId:a.observationId,label:x.label,actionId:x.actionId,before:x,after:y}];});});
 const currentEffectChanges=includeCurrentEffects?models[1].rows.flatMap((a,i)=>{const b=models[2].rows[i];return a.items.flatMap((x,j)=>{const y=b.items[j];return x.stage===y.stage&&x.untriedAfter===y.untriedAfter?[]:[{sequence:a.sequence,label:x.label,before:x,after:y}];});}):[];
 const result={input,revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceSHA256:createHash('sha256').update(readFileSync(join(input,'fragment-audit.json'))).digest('hex'),models:models.map((m,i)=>({name:['frozen-v3','local-id-binding','local-id-binding-current-effects'][i],firstBlockDistribution:m.stages,rows:m.rows,originChecks:m.originChecks})),changes,currentEffectChanges,
  permittedChanges:changes.filter(c=>c.before.untriedAfter!==c.after.untriedAfter),
  limitations:['Only original logged eligible candidates are counted; omitted candidates are reported.','Origin availability follows the actual access-recorded chronology. No extra real sources or inherited origins are invented.','Effects stay frozen and byte-exact in the first two mapping-only variants. The optional third projects current effects from the same actual observations.','A direct receipt takes precedence in sampling status, so originChecks separately report conflicting effect variants.','bestOnLoggedOrder uses the logged candidate order, not a reconstruction of pre-ranking tie order. It is not a guaranteed next browser dispatch.','No actual new browser commands, strict reentry, execution permission or coverage are claimed.']};
 writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({distributions:result.models.map(m=>({name:m.name,stages:m.firstBlockDistribution})),changes:changes.map(c=>({sequence:c.sequence,label:c.label,before:c.before.stage,after:c.after.stage,sources:c.after.originIds})),permittedChanges:result.permittedChanges.length,currentEffectChanges:currentEffectChanges.length,originChecks:result.models.at(-1).originChecks}));
}finally{store.close();fixtures.forEach(f=>f.close());}
