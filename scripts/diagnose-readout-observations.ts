import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {BrowserEngine,type Observation} from '@interaction/browser';
import {SqliteStore} from '@interaction/storage-sqlite';
import {canonical} from '@interaction/core';
import {interactionProjection} from '../packages/adapter-playwright/src/exploration.js';
// Reproduce the collector's passive member-name projection on retained raw evidence.
const regionInteractionBinding=(o:Observation)=>{const passive=new Set(o.controls.filter(c=>c.nativeReadOnly&&c.readOnly&&c.actions.every(k=>k==='fill')).map(c=>c.localId));return canonical(o.regionCandidates?.map(c=>{const b=c.binding as any;return [c.id,{...b,members:b.members?.map((m:any)=>{if(!passive.has(m.id))return m;const {name,...rest}=m;return rest;})}];}));};
const dir=resolve(process.argv[2]);const task=JSON.parse(readFileSync(join(dir,'task-restart.json'),'utf8'));
const engine=new BrowserEngine({persistence:new SqliteStore(join(dir,'engine'))});
try{
 const rows=engine.list<Observation>(task.rounds.at(-1).sessionId,'observation').filter(o=>o.controls.some(c=>c.nativeReadOnly&&c.readOnly));
 let evidence:unknown;
 for(let i=1;i<rows.length;i++){
  const a=rows[i-1],b=rows[i];const raw=(o:Observation)=>canonical(o.regionCandidates?.map(c=>[c.id,c.binding]));
  if(raw(a)===raw(b)||interactionProjection(a)!==interactionProjection(b)||regionInteractionBinding(a)!==regionInteractionBinding(b))continue;
  const before=a.controls.filter(c=>c.nativeReadOnly&&c.readOnly),after=b.controls.filter(c=>c.nativeReadOnly&&c.readOnly);
  if(!before.some(c=>after.some(d=>d.instanceId===c.instanceId&&d.name!==c.name)))continue;
  evidence={sessionId:a.sessionId,beforeId:a.id,afterId:b.id,rawRegionBindingEqual:false,interactiveProjectionEqual:true,normalizedRegionBindingEqual:true,beforeReadouts:before.map(c=>({instanceId:c.instanceId,name:c.name,value:c.value})),afterReadouts:after.map(c=>({instanceId:c.instanceId,name:c.name,value:c.value})),rawObservationsUnchanged:true};break;
 }
 assert.ok(evidence,'Saved observations must reproduce the passive-label mismatch');
 const output=process.argv[3];if(output)writeFileSync(resolve(output),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
}finally{await engine.close();}
