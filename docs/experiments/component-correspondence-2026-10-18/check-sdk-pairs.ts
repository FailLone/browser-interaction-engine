import {readFileSync,writeFileSync} from 'node:fs';
import {SqliteStore} from '@interaction/storage-sqlite';
import {InteractionEngine} from '@interaction/core';
import {PlaywrightAdapter} from '@interaction/adapter-playwright';
const [copy,input,output]=process.argv.slice(2),store=new SqliteStore(copy),adapter=new PlaywrightAdapter();
const engine=new InteractionEngine({persistence:store,adapter});
const base=adapter.componentCorrespondence;
const data=JSON.parse(readFileSync(input,'utf8'));
const pairs=[];
for(const p of data.pairs.filter((p:any)=>['same','uncertain'].includes(p.status))){
 const input={observationId:p.observationId,actionId:p.actionId,source:{...p.source,actionId:p.sourceActionId}};
 // Offline direct reader: avoids pretending a historical frame is the live cursor.
 // Only compares retained observations; no arrival/dispatch/receipt is written.
 adapter.componentCorrespondence=undefined as any;
 const before=(engine as any).correspondenceReader()(p.source.sessionId,input);
 adapter.componentCorrespondence=base;
 const after=(engine as any).correspondenceReader()(p.source.sessionId,input);
 pairs.push({...p,baseline:{equivalent:before.equivalent,reason:before.reason},enhanced:{equivalent:after.equivalent,reason:after.reason}});
}
const remaining=pairs.filter(p=>p.status==='uncertain'&&!p.baseline.equivalent),changed=pairs.filter(p=>p.enhanced.equivalent!==p.baseline.equivalent);
writeFileSync(output,JSON.stringify({pairs,changed,uniqueQuestions:[...new Set(remaining.map(p=>p.materialKey))].length,remaining,paidRequests:0},null,2));
console.log({pairs:pairs.length,changed:changed.length,uniqueQuestions:[...new Set(remaining.map(p=>p.materialKey))].length,changes:changed.map(p=>({label:p.label,sequence:p.sequence,reason:p.baseline.reason})).slice(0,15)});store.close();
