import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { decodeStoredEntity } from '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/storage-sqlite/src/entity-codec.ts';
import { browserReviewBranchConditions } from '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/branch-conditions.ts';
import { browserControlReviewTargetCorrespondence } from '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/review-target.ts';
import { classificationCorrespondenceConditions } from '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/classification-correspondence.ts';
import { canonical } from '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/core/src/index.ts';
import { formBinding } from '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/adapter-playwright/src/util.ts';
const root='/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine';
const path=root+'/.data/okx-storage-acceptance-20261017-v8/engine/engine.sqlite';
const db=new DatabaseSync(path,{readOnly:true});const counts={entities:0,objects:0,packs:0};
const digest=(b:any)=>createHash('sha256').update(b).digest('hex');
const resolve=(ids:readonly number[],sid:string)=>{
 const objects=db.prepare('SELECT * FROM observation_objects WHERE session_id=? AND id IN (SELECT value FROM json_each(?))').all(sid,JSON.stringify(ids));
 const packs=db.prepare('SELECT * FROM observation_packs WHERE session_id=? AND id IN (SELECT value FROM json_each(?))').all(sid,JSON.stringify([...new Set(objects.map((o:any)=>o.pack_id))]));counts.objects+=objects.length;counts.packs+=packs.length;
 const map=new Map(packs.map((p:any)=>{const data=p.codec==='gzip'?gunzipSync(p.data,{maxOutputLength:p.bytes}):p.data;if(data.length!==p.bytes||digest(data)!==Buffer.from(p.sha256).toString('hex'))throw Error('bad pack');return [p.id,data]}));
 return new Map(objects.map((o:any)=>{const part=map.get(o.pack_id)!.subarray(o.byte_offset,o.byte_offset+o.bytes);if(part.length!==o.bytes||digest(part)!==Buffer.from(o.sha256).toString('hex'))throw Error('bad object');return[o.id,part]}));
};
const load=(id:string)=>{const row=db.prepare('SELECT kind,id,session_id,json,compressed_json FROM entities WHERE id=? AND kind=?').get(id,'observation');counts.entities++;return decodeStoredEntity<any>(row as any,resolve as any)};
const source=load('d7da102e-f331-47c6-bec5-96a33ce9cb20'),current=load('da11249a-1e18-41cc-b9ff-f1d2d6ca6323');
const target=(o:any)=>o.controls.find((c:any)=>c.stableKey==='testid:okd-dialog-window');
function inspect(o:any){
 const t=target(o), selections=new Map((o.components||[]).flatMap((c:any)=>c.members.filter((m:any)=>typeof m.selected==='boolean').map((m:any)=>[m.localId,m.selected])));
 const modes:any[]=[];const seen=new Map();
 for(const c of o.controls){let reason:string|undefined;const state:any={};
 if(c.checked!=null)state.checked=c.checked;else if(['checkbox','radio','switch'].includes(c.role))reason='checked_state_missing';
 if(c.pressed!=null)state.pressed=c.pressed;if(c.expanded!=null)state.expanded=c.expanded;
 if(c.tag==='select')state.selected=[...c.selected].sort();else if(['tab','option','treeitem'].includes(c.role)){if(c.selected.length)state.selected=true;else if(selections.has(c.localId))state.selected=selections.get(c.localId);else if(['tab','option'].includes(c.role))reason??='selected_state_missing';}
 if(!reason&&!Object.keys(state).length)continue;
 if(c.readiness?.status==='unstable')reason??='unstable_selector';
 const key=canonical({tag:c.tag,role:c.role,name:c.label||c.name,type:c.constraints.type,anchor:c.structuralItem?{record:c.structuralItem.recordKey,template:c.structuralItem.template,slot:c.structuralItem.slot}:c.stableKey,scope:c.identityContext?.scope,binding:c.identityContext?.binding,form:formBinding(c)});
 if(c.identityScope==='instance'||c.hypothesisId||c.structuralItem&&!c.structuralItem.recordKey)reason??='unportable_selector_binding';
 if(seen.has(key))reason??='duplicate_selector_binding';seen.set(key,c.localId);
 modes.push({localId:c.localId,tag:c.tag,role:c.role,name:c.name,label:c.label,stableKey:c.stableKey,visible:c.visible,identityScope:c.identityScope,hypothesisId:c.hypothesisId,readiness:c.readiness,state,reason,key});
 }
 const bounds=(o.boundaries||[]).map((b:any)=>({key:b.key,name:b.name,region:b.region,overlayFound:!!o.overlays?.some((v:any)=>v.key===b.key)}));
 return {id:o.id,ruleVersion:o.ruleVersion,controls:o.controls.length,stable:o.stable,criticalGaps:o.gaps.filter((g:any)=>g.critical),context:o.context,targetLocalId:t.localId,classificationAvailable:!!classificationCorrespondenceConditions(t,o),branchAvailable:!!browserReviewBranchConditions(t,o),boundaries:bounds,selectorCount:modes.length,firstRejection:modes.find(m=>m.reason),rejections:modes.filter(m=>m.reason),modes};
}
const result={database:path,readOnly:true,observations:[inspect(source),inspect(current)],proof:browserControlReviewTargetCorrespondence(target(source),source,target(current),current),rowsRead:counts};
db.close();writeFileSync('/tmp/okx15-diagnosis.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,observations:result.observations.map(({modes,...v})=>v)},null,2));
