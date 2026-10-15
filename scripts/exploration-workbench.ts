import { BrowserEngine, type ActionCandidate, type Control, type Observation, type ActionAttempt, type ReachResult } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// Generic local workbench: site knowledge lives only in sourced review records.
// Usage: pnpm exec tsx --conditions=development scripts/exploration-workbench.ts URL OUTPUT_DIRECTORY [OPTIONS_JSON]
const [url, output = 'work/exploration-workbench', optionsPath] = process.argv.slice(2);
if (!url || !/^https?:\/\//.test(url)) throw new Error('Supply an HTTP(S) URL and optional output directory');
const directory = resolve(output); mkdirSync(directory, { recursive: true });
const options = optionsPath ? JSON.parse(readFileSync(resolve(optionsPath), 'utf8')) : {};
type Review = { id: string; at: string; observationId: string; instanceScope: string; instanceId: string; binding: string; kind: string; risk: 'interface' | 'unknown'; replayable: boolean; reason: string; evidence: string[]; samples?: string[]; exitBoundary?: string };
const reviews: Review[] = [];
const binding = (c: Control) => JSON.stringify([c.stableKey, c.role, c.label || c.name, c.region, c.form, c.constraints.type]);
const match = (c: Control, o: Observation, kind: string) => reviews.findLast(r => r.instanceScope === o.instanceScope && r.instanceId === c.instanceId && r.binding === binding(c) && r.kind === kind);
function reviewEvidence(review: Review, c: Control, o: Observation) {
  const evidence = [{ source: 'reviewer', rule: 'sourced-control-review/v1', facts: { reviewId: review.id, reason: review.reason, evidence: review.evidence } }] as NonNullable<ActionCandidate['basis']>['evidence'];
  if (review.exitBoundary && o.boundaries?.at(-1)?.key === review.exitBoundary) evidence.push({ source: 'reviewer', rule: 'declared-boundary-exit/v1', facts: {
    reviewId: review.id, boundaryKey: review.exitBoundary, observationId: o.id, localId: c.localId, evidence: [`Reviewed in observation ${review.observationId}`, ...review.evidence],
  } });
  return evidence;
}
const engine = new BrowserEngine({ persistence: new SqliteStore(directory), hooks: {
  samples: (c, { observation: o }) => match(c, o, 'fill')?.samples,
  actions: (actions, { observation: o, session }) => {
    const result = actions.map(a => {
      const c = o.controls.find(c => c.localId === a.localId); const review = c && match(c, o, a.kind);
      const href = a.basis?.evidence.map(e => e.facts.href).find(h => typeof h === 'string') as string | undefined;
      if (review && a.risk !== 'submission') return { ...a, excluded: false, exclusionReason: undefined, risk: review.risk,
        replayable: review.replayable, source: 'external-review', basis: { status: 'supported' as const, evidence: [...a.basis?.evidence || [], ...reviewEvidence(review, c!, o)] } };
      const reason = href && !href.startsWith('#') ? 'navigation_requires_review' : a.risk !== 'interface' ? 'operation_requires_review' : undefined;
      return reason ? { ...a, excluded: true, exclusionReason: reason } : a;
    });
    for (const c of o.controls.filter(c => c.visible)) for (const review of reviews.filter(r => r.instanceId === c.instanceId && r.instanceScope === o.instanceScope && r.binding === binding(c)).reverse()) {
      if (result.some(a => a.localId === c.localId && a.kind === review.kind)) continue;
      const a: ActionCandidate = { id: randomUUID(), sessionId: session.id, observationId: o.id, stateId: o.stateId, controlId: c.identityId, localId: c.localId, kind: review.kind, label: c.name || `Unnamed ${c.role}`, value: review.samples?.[0],
        risk: review.risk, replayable: review.replayable, source: 'external-review', excluded: false, sampleValidity: 'shape_only',
        preconditions: { context: o.context, visible: c.visible, enabled: c.enabled, identityResolved: !c.hypothesisId },
        basis: { status: 'supported', evidence: reviewEvidence(review, c, o) } };
      result.push(a);
    }
    return result;
  },
} });
const session = await engine.createSession({ headless: true, maxActions: 10000, maxDepth: 100, maxDurationMs: 86400000,
  actionTimeoutMs: 15000, settleMs: 300, observeTimeoutMs: 10000,
  evidenceRetention: { mode: 'persistent', ttlMs: 0, maxBytes: 20 * 1024 ** 3, maxObservations: 100000 }, ...options, url });
const sid = session.id;
function state() {
  const o = engine.observation(sid);
  return { session: engine.session(sid), observation: o, actions: engine.actions(sid), reviews };
}
function summary() {
  const r = engine.report(sid); const frontier = engine.getFrontier(sid); const attempts = engine.list<ActionAttempt>(sid, 'attempt'); const recoveries = engine.list<ReachResult>(sid, 'reach');
  const counts = (rows: {status:string}[]) => rows.reduce((out,r)=>{out[r.status]=(out[r.status]||0)+1;return out},{} as Record<string,number>);
  return { session: r.session, controls: r.controlCoverage, frontierCounts: counts(frontier), frontier,
    attempts: attempts.map(a=>({id:a.id,label:a.action.label,kind:a.action.kind,status:a.status,reason:a.reason,purpose:a.purpose,beforeId:a.beforeId,afterId:a.afterId})), recoveries };
}
const snapshot = () => { writeFileSync(resolve(directory,'state.json'),JSON.stringify(state(),null,2)); writeFileSync(resolve(directory,'summary.json'),JSON.stringify(summary(),null,2)); };
engine.events.on('event', e => {
  if (['action.completed','exploration.paused','exploration.finished','exploration.recovery_shared','hook.error'].includes(e.type)) {
    const s=engine.session(sid); const a=engine.list<ActionAttempt>(sid,'attempt').at(-1);
    const line=JSON.stringify({at:e.at,type:e.type,count:s.actionCount,stop:s.stopReason,last:a&&{label:a.action.label,kind:a.action.kind,status:a.status,reason:a.reason}});
    console.log(line); appendFileSync(resolve(directory,'progress.jsonl'),line+'\n');
  }
});
const server = createServer(async (req,res)=> {
  try {
    const body = await new Promise<string>((resolve,reject)=>{let text='';req.on('data',chunk=>{text+=chunk;if(text.length>1000000)req.destroy(new Error('Request too large'));});req.on('end',()=>resolve(text));req.on('error',reject);});
    const data = body ? JSON.parse(body) : {};
    let result: unknown;
    if(req.method==='GET' && req.url==='/state') result=state();
    else if(req.method==='GET' && req.url==='/summary') result=summary();
    else if(req.method==='GET' && req.url==='/report') result=engine.report(sid);
    else if(req.method==='GET' && req.url==='/hypotheses') result=engine.list(sid,'hypothesis');
    else if(req.method==='GET' && req.url==='/region-review') result=engine.regionReviewMaterial(sid);
    else if(req.method==='GET' && req.url==='/exploration-review') result=engine.explorationReviewMaterial(sid);
    else if(req.method==='GET' && req.url==='/groups') result=engine.list(sid,'exploration-group');
    else if(req.method==='GET' && req.url?.startsWith('/purpose-material?')) result=engine.purposeReviewMaterial(sid,new URL(req.url,'http://localhost').searchParams.get('groupId') || '');
    else if(req.method==='GET' && req.url==='/purpose-reviews') result=engine.list(sid,'purpose-review');
    else if(req.method==='GET' && req.url==='/identities') result=engine.list(sid,'identity');
    else if(req.method==='GET' && req.url==='/screenshot') { const a=await engine.evidenceArtifact(sid,engine.observation(sid).id,'screenshot');res.writeHead(200,{'Content-Type':a.mediaType});res.end(a.data);return; }
    else if(req.method==='POST' && req.url==='/command') result=await engine.command(sid,data);
    else if(req.method==='POST' && req.url==='/review') {
      await engine.pause(sid); await engine.waitForIdle();
      const o=engine.observation(sid); if(data.observationId!==o.id)throw new Error('Review the latest observation');
      const proposed=data.reviews ?? [data];if(!Array.isArray(proposed)||!proposed.length)throw new Error('Supply one or more reviews');
      const accepted:Review[]=proposed.map(data=>{
        const c=o.controls.find(c=>c.localId===data.localId);if(!c)throw new Error('Control not present');
        if(!['click','fill','select','check','press','hover'].includes(data.kind)||!['interface','unknown'].includes(data.risk)||typeof data.reason!=='string'||!data.reason.trim()||!Array.isArray(data.evidence)||!data.evidence.length||data.evidence.some((e:unknown)=>typeof e!=='string'||!e.trim()))throw new Error('Review requires operation, risk, reason and evidence');
        if(data.exitBoundary!==undefined&&(typeof data.exitBoundary!=='string'||data.exitBoundary!==o.boundaries?.at(-1)?.key||data.kind!=='click'||data.risk!=='interface'))throw new Error('Boundary exit review must name the current active boundary and an interface click');
        if(data.samples!==undefined&&(!Array.isArray(data.samples)||data.samples.some((s:unknown)=>typeof s!=='string')))throw new Error('Samples must be strings');
        return {id:randomUUID(),at:new Date().toISOString(),observationId:o.id,instanceScope:o.instanceScope,instanceId:c.instanceId,binding:binding(c),kind:data.kind,risk:data.risk,replayable:data.replayable===true,reason:data.reason,evidence:data.evidence,samples:data.samples,exitBoundary:data.exitBoundary};
      });
      reviews.push(...accepted);appendFileSync(resolve(directory,'reviews.jsonl'),accepted.map(r=>JSON.stringify(r)+'\n').join(''));result=data.reviews ? accepted : accepted[0];
      await engine.observe(sid);
    } else if(req.method==='POST' && req.url==='/save') { snapshot();result={directory}; }
    else if(req.method==='POST' && req.url==='/close') {
      await engine.pause(sid);await engine.waitForIdle();snapshot();await engine.close();result={closed:true};server.close();
    } else {res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));
  } catch(error) {res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:String(error),code:(error as any).code,details:(error as any).details}));}
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
writeFileSync(resolve(directory,'connection.json'),JSON.stringify({address,sessionId:sid,url,pid:process.pid}));snapshot();console.log(JSON.stringify({ready:true,address,sessionId:sid,directory}));
