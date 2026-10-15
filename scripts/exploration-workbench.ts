import { BrowserEngine, type ControlReviewRecord, type ActionAttempt, type ReachResult } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Generic local workbench: site knowledge lives only in sourced review records.
// Usage: pnpm exec tsx --conditions=development scripts/exploration-workbench.ts URL OUTPUT_DIRECTORY [OPTIONS_JSON]
const [url, output = 'work/exploration-workbench', optionsPath] = process.argv.slice(2);
if (!url || !/^https?:\/\//.test(url)) throw new Error('Supply an HTTP(S) URL and optional output directory');
const directory = resolve(output); mkdirSync(directory, { recursive: true });
const options = optionsPath ? JSON.parse(readFileSync(resolve(optionsPath), 'utf8')) : {};
// The engine owns the durable judgments; this workbench only supplies a caller policy.
const engine = new BrowserEngine({ persistence: new SqliteStore(directory), hooks: {
  actions: actions => actions.map(a => {
    if (a.basis?.evidence.some(e => e.rule === 'reviewed-control/v1')) return a;
    const href = a.basis?.evidence.map(e => e.facts.href).find(h => typeof h === 'string') as string | undefined;
    const reason = href && !href.startsWith('#') ? 'navigation_requires_review' : a.risk !== 'interface' ? 'operation_requires_review' : undefined;
    return reason ? { ...a, excluded: true, exclusionReason: reason } : a;
  }),
} });
const session = await engine.createSession({ headless: true, maxActions: 10000, maxDepth: 100, maxDurationMs: 86400000,
  actionTimeoutMs: 15000, settleMs: 300, observeTimeoutMs: 10000,
  evidenceRetention: { mode: 'persistent', ttlMs: 0, maxBytes: 20 * 1024 ** 3, maxObservations: 100000 }, ...options, url });
const sid = session.id;
function state() {
  const o = engine.observation(sid);
  return { session: engine.session(sid), observation: o, actions: engine.actions(sid), reviews: engine.list<ControlReviewRecord>(sid,'control-review'), classifications: engine.list(sid,'control-classification') };
}
function summary() {
  const r = engine.report(sid); const frontier = engine.getFrontier(sid); const attempts = engine.list<ActionAttempt>(sid, 'attempt'); const recoveries = engine.list<ReachResult>(sid, 'reach');
  const counts = (rows: {status:string}[]) => rows.reduce((out,r)=>{out[r.status]=(out[r.status]||0)+1;return out},{} as Record<string,number>);
  return { session: r.session, explorationAudit:r.explorationAudit, completionAudit:r.completionAudit, controls: r.controlCoverage, frontierCounts: counts(frontier), frontier,
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
    else if(req.method==='GET' && req.url==='/control-review') result=engine.controlReviewMaterial(sid);
    else if(req.method==='GET' && req.url==='/discovery-scan') result=engine.discoveryScanMaterial(sid);
    else if(req.method==='GET' && req.url==='/control-classification') result=engine.controlClassificationMaterial(sid);
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
      const accepted=await engine.reviewControls(sid,{observationId:data.observationId,source:data.source || 'workbench-caller',
        reviews:(data.reviews ?? [data]).map(({localId,kind,risk,replayable,reason,evidence,samples,exitBoundary}: any)=>({localId,kind,risk,replayable,reason,evidence,samples,exitBoundary}))});
      appendFileSync(resolve(directory,'reviews.jsonl'),accepted.map(r=>JSON.stringify(r)+'\n').join(''));
      result=data.reviews ? accepted : accepted[0];
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
