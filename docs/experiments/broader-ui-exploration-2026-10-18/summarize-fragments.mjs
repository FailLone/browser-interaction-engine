/** Offline only: read closed exported JSON, never evidence databases. */
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
const reports=[];
for(const arg of process.argv.slice(2)){
 const dir=resolve(arg),task=JSON.parse(readFileSync(join(dir,'task-final.json'),'utf8')),root=task.fragmentTraversal,ledger=root?.storageVersion===2?JSON.parse(readFileSync(join(dir,'fragment-audit.json'),'utf8')):root;
 const rows=readFileSync(join(dir,'timeline.jsonl'),'utf8').trim().split('\n').map(JSON.parse),events=rows.filter(r=>r.type==='plugin.event').map(r=>r.data);
 const fronts=events.filter(e=>e.type==='fragment.frontier').map(e=>e.data),prunes=fronts.flatMap(f=>f.pruned||[]),access=events.filter(e=>e.type==='fragment.access_recorded').map(e=>e.data);
 const candidates=new Map((ledger?.fragments||[]).flatMap(f=>f.candidates).map(c=>[c.id,c]));
 const explored=c=>c&&Object.values(c.access).some(ids=>ids.length);
 const pending=task.plan.filter(i=>i.required&&!['succeeded','superseded','excluded'].includes(i.status));
 const projected=pending.filter(i=>{const ref=ledger?.obligations[i.id];return ref?.candidateIds.length&&ref.candidateIds.every(id=>explored(candidates.get(id)));});
 const receipts=new Map(events.filter(e=>e.type==='action.verified').map(e=>[e.data.attemptId,e.data]));
 const stats=values=>{const sorted=[...values].sort((a,b)=>a-b);return {calls:sorted.length,totalMs:sorted.reduce((a,b)=>a+b,0),p50Ms:sorted[Math.floor(sorted.length*.5)]??null,p95Ms:sorted[Math.floor(sorted.length*.95)]??null,maxMs:sorted.at(-1)??null};};
 const report={run:dir,policy:ledger?.policy||null,fragmentCount:ledger?.fragments.length||0,mappingCount:ledger?.mappings.length||0,
  actualAccessEvents:ledger?.events.length||0,accessWithoutLoggedSucceededReceipt:(ledger?.events||[]).filter(e=>receipts.get(e.id)?.status!=='succeeded').map(e=>e.id),
  uniqueProjectedPrunedCandidates:new Set(prunes.map(p=>p.candidateId)).size,uniquePropagatedPrunedCandidates:new Set(prunes.filter(p=>(typeof p.access.direct==='boolean'?!p.access.direct:!p.access.direct.length)&&(p.originCount??p.originAttemptIds?.length)).map(p=>p.candidateId)).size,
  observationsWithPruning:fronts.filter(f=>f.pruned.length).length,registration:stats(fronts.map(f=>f.elapsedMs)),accessRecording:stats(access.map(e=>e.elapsedMs||0)),
  cumulativeMappedActionObservations:fronts.reduce((n,f)=>n+f.candidates,0),cumulativeUnmappedActionObservations:fronts.reduce((n,f)=>n+f.unmapped,0),
  rootBytes:root?Buffer.byteLength(JSON.stringify(root)):0,auditLedgerBytes:ledger?Buffer.byteLength(JSON.stringify(ledger)):0,ledgerBytes:ledger?Buffer.byteLength(JSON.stringify(ledger)):0,bounded:!!ledger?.bounded,pending:pending.length,projectedPrunedPending:projected.length,
  requiredRestoreDispatches:events.filter(e=>e.type==='action.scheduled'&&e.data.purpose==='prerequisite').length,
  limitations:['Projection counts include observations and are not dispatches avoided or verified coverage.','Unmapped actions remain in the same strategy; unknown duties remain pending.','Timing categories can overlap, especially access recording and registration.','No browser or original-DB mutation is performed by this report.']};
 writeFileSync(join(dir,'fragment-summary.json'),JSON.stringify(report,null,2));reports.push(report);
}
console.log(JSON.stringify(reports,null,2));
