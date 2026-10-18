import {mkdirSync,copyFileSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {SqliteStore} from '@interaction/storage-sqlite';
import {browserTraversalFragments} from '@interaction/browser';
const input=resolve(process.argv[2]),output=resolve(process.argv[3]);
mkdirSync(output,{recursive:false});mkdirSync(join(output,'copy'));
copyFileSync(join(input,'engine/engine.sqlite'),join(output,'copy/engine.sqlite'));
const store=new SqliteStore(join(output,'copy'));
try{
 const ledger=JSON.parse(readFileSync(join(input,'fragment-audit.json'))),timeline=readFileSync(join(input,'timeline.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 const captures=new Map(timeline.filter(r=>r.type==='capture.end').map(r=>[r.data.observationId,r.at]));
 const fragments=new Map(ledger.fragments.map(f=>[f.id,f])),candidates=new Map(ledger.fragments.flatMap(f=>f.candidates.map(c=>[c.id,{f,c}]))),results=[];
 for(const row of timeline.filter(r=>r.type==='plugin.event'&&r.data.type==='fragment.candidates_ranked')){
  const event=row.data.data;if(!event.current.some(c=>c.locality>0)||event.current[0].locality>0)continue;
  const o=store.require('observation',event.observationId),actions=store.listByObservation('action',o.sessionId,o.id);
  const byAction=new Map();
  for(const projection of browserTraversalFragments(o,actions,ledger.authority)){
   const matches=ledger.fragments.filter(f=>f.url===o.url&&f.revision===projection.revision&&f.structure===projection.structure&&f.owner===projection.owner);
   if(matches.length!==1)throw Error('PROJECTION_NOT_UNIQUE');const f=matches[0];
   projection.candidates.forEach((c,i)=>byAction.set(c.actionId,{f,c:f.candidates[i]}));
  }
  const choices=event.current.slice(0,8).map(choice=>{
   const target=byAction.get(choice.actionId);if(!target)return {...choice,rawPeers:0,sameContextPeers:0,projection:'unmapped'};
   const pairs=ledger.mappings.filter(m=>m.sourceFragmentId===target.f.id&&!m.revoked&&captures.get(fragments.get(m.targetFragmentId).source.observationId)<=row.at);
   const raw=new Set(pairs.map(m=>m.targetFragmentId)),same=new Set(pairs.filter(m=>{
    const a=candidates.get(m.sourceCandidateId).c,b=candidates.get(m.targetCandidateId).c;return a.context!==undefined&&a.context===b.context;
   }).map(m=>m.targetFragmentId));
   return {...choice,fragmentId:target.f.id,rawPeers:raw.size,sameContextPeers:same.size};
  });
  results.push({seconds:(row.at-timeline[0].at)/1000,observationId:o.id,selectedItemId:event.selectedItemId,choices});
 }
 const result={input,results,limitations:['Read-only reconstruction from a closed-copy database and frozen audit.','Historical membership is bounded by first captured source time; exact registration timing is not reconstructed.','This compares raw local peers with same-context peers only; it does not predict validated cross-context sampling or claim a strict chain.']};
 writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(results.map(r=>({seconds:r.seconds,choices:r.choices.map(c=>({label:c.label,kind:c.kind,locality:c.locality,rawPeers:c.rawPeers,sameContextPeers:c.sameContextPeers}))}))));
}finally{store.close();}
