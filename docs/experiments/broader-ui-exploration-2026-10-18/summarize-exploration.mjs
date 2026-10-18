/** Offline supplemental diagnostics. Reads JSON only; never opens evidence DBs
 * or changes the frozen acceptance result. Run: node this-file.mjs RUN_DIR ... */
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
const read=(dir,file)=>JSON.parse(readFileSync(join(dir,file),'utf8'));
const position=url=>{try{const u=new URL(url);u.hash='';return u.href;}catch{return url;}};
const reports=[];
for(const arg of process.argv.slice(2)){
 const dir=resolve(arg),rows=readFileSync(join(dir,'timeline.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 const events=rows.filter(row=>row.type==='plugin.event').map(row=>row.data);
 const receipts=new Map(events.filter(e=>e.type==='action.verified').map(e=>[e.data.actionId,e.data]));
 const inventory=(type,id)=>rows.find(row=>row.type===type&&row.data.actionId===id)?.data.inventory;
 const result=read(dir,'result.json'),dispatches=rows.filter(row=>row.type==='browser.dispatch'),samples=new Map(),positions=new Set(),transitions=[],sampleRepeats=[],sameURLClicks=[],noImmediateExpansion=[];
 const initial=rows.find(row=>row.type==='dom.initial')?.data;if(initial)positions.add(position(initial.url));
 for(const {data:{action:a,control:c},at} of dispatches){
  const before=inventory('dom.before',a.id),after=inventory('browser.executed',a.id),receipt=receipts.get(a.id);
  if(!before||!after)continue;
  const old=new Set(before.controls.flatMap(c=>c.href?[new URL(c.href,before.url).href]:[])),added=[...new Set(after.controls.flatMap(c=>c.href?[new URL(c.href,after.url).href]:[]))].filter(href=>!old.has(href));
  const target=c?.reviewBinding?.attributes.href&&new URL(c.reviewBinding.attributes.href,before.url).href;
  const selected=events.find(e=>e.type==='action.selected'&&e.data.actionId===a.id)?.data;
  const record={actionId:a.id,kind:a.kind,label:a.label,from:before.url,to:after.url,receiptStatus:receipt?.status||'not_logged',at,addedHrefs:added.length};
  if(a.kind==='click'&&target===before.url)sameURLClicks.push(record);
  if(receipt?.status==='succeeded'&&a.kind==='click'&&target&&position(target)===position(after.url)&&position(before.url)!==position(after.url)){
   transitions.push({...record,requested:target,newObservedPosition:!positions.has(position(after.url))});positions.add(position(after.url));
  }
  if(['hover','focus'].includes(a.kind)&&before.url===after.url&&!added.length)noImmediateExpansion.push(record);
  const scope=selected?.scope;
  if(scope?.targetBinding){
   const key=JSON.stringify([new URL(before.url).origin,scope.targetBinding,scope.kind,scope.label,scope.value,scope.region,scope.landmark]);
   if(samples.has(key))sampleRepeats.push({...record,priorActionId:samples.get(key),necessaryReentry:selected.reentry===true});
   if(receipt?.status==='succeeded')samples.set(key,a.id);
  }
 }
 reports.push({dir,acceptanceUnchanged:true,legacy:{accepted:result.accepted,branchCount:result.branchCount,strictChains:result.strictChains,chainRegions:result.chainRegions},elapsedMs:result.elapsedMs,commands:result.actions,
  diagnostics:{nativeTransitions:transitions,distinctObservedNativePositions:positions.size,bindingSampleRepeats:sampleRepeats,exactCurrentURLClicks:sameURLClicks,hoverOrFocusWithNoImmediateNewHref:noImmediateExpansion,recoverySelections:events.filter(e=>e.type==='recovery.selected').length},
  limitations:['Supplemental observations are not a replacement acceptance criterion or source-child coverage proof.','Fragment-insensitive positions describe native origin/path/query changes only; DOM states and target identities remain separate.','Matching captured bindings are sampling hints, not proof that two actions have identical behavior.','Immediate independent DOM sampling can miss delayed effects; no new href does not prove an action had no effect.']});
}

console.log(JSON.stringify(reports,null,2));
