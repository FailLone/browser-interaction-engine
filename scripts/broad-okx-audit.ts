/** Additional frozen broad-scope checks. Original strict auditors are unchanged. */
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {BrowserEngine,type ActionAttempt} from '@interaction/browser';
import {SqliteStore} from '@interaction/storage-sqlite';
const dir=process.argv[2],read=(name:string)=>JSON.parse(readFileSync(join(dir,name),'utf8'));
const original=read('audit.json'),protocol=read('protocol.json'),budget=read('budget.json');
const rows=readFileSync(join(dir,'timeline.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
const engine=new BrowserEngine({persistence:new SqliteStore(join(dir,'engine'))});
const task=read('task-final.json'),attempts:ActionAttempt[]=task.rounds.flatMap((r:any)=>engine.list<ActionAttempt>(r.sessionId,'attempt'));
const path=(url:string)=>{const u=new URL(url);return u.origin+u.pathname.replace(/\/$/,'');};
const signature=(c:any)=>JSON.stringify([c.tag,c.role,c.text,c.href]);
const pair=(actionId:string)=>({before:rows.find(r=>r.type==='dom.before'&&r.data.actionId===actionId)?.data.inventory,after:rows.find(r=>r.type==='browser.executed'&&r.data.actionId===actionId)?.data.inventory});
const branches=new Map<string,unknown>();
for(const a of attempts.filter(a=>a.status==='succeeded'&&a.purpose!=='recovery'&&a.action.kind!=='history'&&a.action.boundary?.intent!=='exit')){
 const {before,after}=pair(a.action.id);if(!before||!after)continue;
 const o=engine.observation(a.sessionId,a.beforeId),c=o.controls.find(c=>c.localId===a.action.localId),href=c?.reviewBinding?.attributes.href;
 if(href&&new URL(href,before.url).href===after.url&&path(before.url)!==path(after.url)){
  const key=`navigation:${path(after.url)}`;if(!branches.has(key))branches.set(key,{key,kind:'navigation',attemptId:a.id,from:before.url,to:after.url,label:a.action.label});
 }else if(before.url===after.url&&c){
  const beforeKeys=new Set(before.controls.map(signature)),added=after.controls.filter((c:any)=>!beforeKeys.has(signature(c))&&['A','BUTTON','SUMMARY','SELECT'].includes(c.tag));
  if(added.length){const key=JSON.stringify(['reveal',path(before.url),c.landmark||c.region,c.selector,a.action.kind]);if(!branches.has(key))branches.set(key,{key,kind:'reveal',attemptId:a.id,label:a.action.label,added});}
 }
}
const chains=original.chains.map((chain:any)=>{
 const child=attempts.find(a=>a.id===chain.childAttemptId),source=chain.binding?.available?chain.binding.binding.source:undefined;
 const sourceObservation=source&&engine.observation(source.sessionId,source.observationId),sourceAction=source&&engine.actions(source.sessionId,source.observationId).find(a=>a.id===source.actionId),sourceControl=sourceObservation?.controls.find((c:any)=>c.localId===sourceAction?.localId);
 const region=sourceControl?JSON.stringify([path(sourceObservation!.url),sourceControl.landmark||sourceControl.region||'document']):undefined;
 // A native navigation retains the original independent DOM URL check.
 // In-place alternatives require an unambiguous ID-bound independently sampled
 // target and an observable state change; a changing label alone is insufficient.
 let independentUI=false,uiEvidence:unknown;
 if(child&&!chain.checks.independentNavigation){
  const {before,after}=pair(child.action.id),o=engine.observation(child.sessionId,child.beforeId),c=o.controls.find(c=>c.localId===child.action.localId),id=c?.selector?.startsWith('#')?c.selector.slice(1):undefined;
  if(before&&after&&before.url===after.url&&id){
   const b=before.controls.filter((v:any)=>v.id===id),a=after.controls.filter((v:any)=>v.id===id);
   if(b.length===1&&a.length===1){const changed=['expanded','selected','checked','disabled'].filter(k=>b[0][k]!==a[0][k]&&a[0][k]!==undefined);independentUI=changed.length>0;uiEvidence={id,changed,before:b[0],after:a[0]};}
  }
 }
 const checks={...chain.checks,independentNavigation:undefined,independentOutcome:chain.checks.independentNavigation||independentUI};
 delete checks.independentNavigation;
 return {...chain,region,checks,uiEvidence,accepted:!!region&&Object.values(checks).every(Boolean)};
});
const acceptedChains=chains.filter((c:any)=>c.accepted),distinctItems=new Set(acceptedChains.map((c:any)=>c.itemId)),regions=new Set(acceptedChains.map((c:any)=>c.region));
const checks={budget:Date.now()<=budget.deadline&&budget.actions<=protocol.actions,branches:branches.size>=protocol.acceptance.minBranches,originalStrictChains:distinctItems.size>=protocol.acceptance.minOriginalStrictChains,chainRegions:regions.size>=protocol.acceptance.minChainRegions};
const result={accepted:Object.values(checks).every(Boolean),checks,reason:Object.values(checks).every(Boolean)?'broad_original_continuation_verified':'broad_coverage_incomplete',branchCount:branches.size,branches:[...branches.values()],strictChains:distinctItems.size,chainRegions:regions.size,chains,originalAuditAccepted:original.accepted,originalAuditorUnchanged:true,coverage:original.coverage,calls:original.calls,taskStatus:original.taskStatus,taskReason:original.taskReason};
writeFileSync(join(dir,'broad-audit.json'),JSON.stringify(result,null,2));await engine.close();
console.log(JSON.stringify({accepted:result.accepted,checks,branches:branches.size,strictChains:distinctItems.size,chainRegions:regions.size}));
