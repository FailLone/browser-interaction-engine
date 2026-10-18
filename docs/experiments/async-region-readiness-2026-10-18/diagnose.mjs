import {SqliteStore} from '@interaction/storage-sqlite';
import {readFileSync,writeFileSync,copyFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const input=resolve(process.argv[2]),out=resolve(process.argv[3]);mkdirSync(out,{recursive:false});mkdirSync(join(out,'copy'));copyFileSync(join(input,'engine/engine.sqlite'),join(out,'copy/engine.sqlite'));
const raw=readFileSync(join(input,'fragment-audit.json')),audit=JSON.parse(raw),timeline=readFileSync(join(input,'timeline.jsonl'),'utf8').trim().split('\n').map(JSON.parse),store=new SqliteStore(join(out,'copy'));
try{
const sid=audit.events[0].sessionId,observations=store.list('observation',sid).sort((a,b)=>a.capturedAt.localeCompare(b.capturedAt)),attempts=store.list('attempt',sid).sort((a,b)=>a.startedAt.localeCompare(b.startedAt));
const origins=['1ee5755e-8033-4bb4-8d42-b3bf2edd8ed9','61c642fe-93b8-473d-8aba-97cb34f49307'];
const pairs=origins.map(id=>{
 const a=attempts.find(a=>a.id===id),after=store.require('observation',a.afterId),before=store.require('observation',a.beforeId),event=audit.events.find(e=>e.id===id),effect=JSON.parse(event.effect),root=effect.evidence.afterRoot;
 return {attempt:a,root,local:effect.comparison.local,beforeTarget:before.controls.find(c=>c.localId===a.action.localId),afterTarget:after.controls.find(c=>c.localId===a.action.localId),capture:timeline.filter(e=>e.type.startsWith('capture.')&&e.data.observationId===after.id)};
});
const region=pairs[0].root.rootInstanceId||pairs[0].root.nodes[0].instanceId;
const snapshots=observations.map(o=>{const pair=pairs.find(p=>p.afterTarget?.domAncestry?.documentId===o.documentId), rootId=pair?.root.nodes[0].instanceId; const target=o.controls.find(c=>c.localId===pair?.attempt.action.localId); const nodes=o.controls.flatMap(c=>c.classificationBinding?.nodes||[]).filter(n=>n.instanceId===rootId||pair?.root.nodes.some(x=>x.instanceId===n.instanceId));const nodeIds=new Set(o.controls.filter(c=>c.instanceId===rootId||c.domAncestry?.instanceIds.includes(rootId)).map(c=>c.instanceId));
 const local=o.controls.filter(c=>nodeIds.has(c.instanceId));const acts=store.listByObservation('action',sid,o.id);
 return {id:o.id,at:o.capturedAt,url:o.url,stable:o.stable,gaps:o.gaps,controls:o.controls.length,visible:o.controls.filter(c=>c.visible).length,target:target&&{id:target.localId,visible:target.visible,readiness:target.readiness,text:target.classificationBinding?.text,nodes:nodes.length,attributes:target.reviewBinding?.attributes},local:local.map(c=>({id:c.localId,name:c.name,visible:c.visible,readiness:c.readiness,href:c.reviewBinding?.attributes.href})),localActions:acts.filter(a=>nodeIds.has(a.localId)).map(a=>({id:a.id,kind:a.kind,label:a.label,localId:a.localId})),capture:timeline.filter(e=>e.type==='capture.end'&&e.data.observationId===o.id).map(e=>e.data)};
});
const steps=timeline.filter(e=>['browser.dispatch','browser.executed','capture.start','capture.end'].includes(e.type)||e.type==='plugin.event'&&['action.selected','action.scheduled','frontier.ranked','branch.children_retained','discovery.completed','action.completed'].includes(e.data.type)).map(e=>e.type==='browser.executed'?{at:e.at,type:e.type,data:{actionId:e.data.actionId,controls:e.data.inventory.controls.filter(c=>c.href&&c.href.includes('trade-spot')).map(c=>({text:c.text,href:c.href}))}}:e);
const result={input,auditSHA256:createHash('sha256').update(raw).digest('hex'),pairs,snapshots,attempts:attempts.map(a=>({id:a.id,action:a.action,beforeId:a.beforeId,afterId:a.afterId,startedAt:a.startedAt,finishedAt:a.finishedAt,status:a.status})),steps};writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({pairs:pairs.map(p=>({attempt:p.attempt.id,before:p.attempt.beforeId,after:p.attempt.afterId,localNodes:p.local.tree.length,rootKeys:Object.keys(p.root),text:p.local.text,capture:p.capture})),snapshots:snapshots.map(s=>({id:s.id,at:s.at,stable:s.stable,gaps:s.gaps.map(g=>g.code),nodes:s.target?.nodes,text:s.target?.text?.slice(0,180),local:s.local.length,visible:s.local.filter(c=>c.visible).length,actions:s.localActions.length,capture:s.capture}))},null,2));
}finally{store.close();}
