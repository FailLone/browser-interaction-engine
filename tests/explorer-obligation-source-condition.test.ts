import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserEngine, type ActionCandidate, type Observation } from '@interaction/browser';
import { browserOperationKey } from '../packages/adapter-playwright/src/exploration.js';
import { SqliteStore } from '@interaction/storage-sqlite';
import { ExplorerPlugin, ExplorerStore, type PlanItem, type Round, type Scope } from '@interaction/explorer-plugin';
import { POLICY_VERSION } from '../packages/explorer-plugin/src/decision-policy.js';
import { scopeFor } from '../packages/explorer-plugin/src/policy.js';
import { fakeProviders } from './explorer-plugin-helpers.js';
import { pageOf } from './helpers.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const oracle: string[] = [], directory = mkdtempSync(join(tmpdir(), 'bie-obligation-scheduler-'));
  let initialMode = 'A';
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/oracle?')) {
      oracle.push(new URL(req.url, 'http://fixture').searchParams.get('event')!); res.writeHead(204); res.end(); return;
    }
    res.setHeader('Content-Type', 'text/html');
    const body = req.url === '/away' ? '<p>Away</p>'
      : `<form id="settings"><select id="mode" aria-label="Mode" hidden><option${initialMode === 'A' ? ' selected' : ''}>A</option><option${initialMode === 'B' ? ' selected' : ''}>B</option></select></form><form id="commands"><button id="run" type="button" onclick="const m=document.querySelector('#mode');record(m.value);this.disabled=true">Run</button></form>`;
    res.end(`<!doctype html><title>Durable obligations</title><main>${body}</main>
      <form><label>Quote<input readonly id="quote" value="100"></label></form>
      <script>function record(event){const r=new XMLHttpRequest();r.open('POST','/oracle?event='+event,false);r.send();}</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const hostPath = join(directory, 'engine'), pluginPath = join(directory, 'plugin.sqlite'), providers = fakeProviders(url);
  const host = new BrowserEngine({ persistence: new SqliteStore(hostPath) });
  const plugin = new ExplorerPlugin(host, new ExplorerStore(pluginPath), providers);
  cleanup.push(async () => { await plugin.close(); await host.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); });
  const options = { url, headless: true, exploration: 'controls' as const, executionPolicy: 'interface-only' as const,
    settleMs: 0, observeTimeoutMs: 1000, actionTimeoutMs: 2000, contextRules: [], listExploration: 'all' as const,
    pageExploration: 'all' as const, regionExploration: 'off' as const, interfaceActions: [{ kind: 'click' }],
    replayable: [{ stableKey: 'id:open' }], maxActions: 20, maxDurationMs: 60000 };
  const session = await host.createSession(options), sid = session.id;
  const find = (name: string, source = host.observation(sid)) => {
    const actions = host.actions(sid, source.id).filter(a => a.kind === 'click' && a.label === name);
    expect(actions, name).toHaveLength(1); return actions[0];
  };
  const source = host.observation(sid), a = find('Run', source);
  const checkpoint = await host.createCheckpoint(sid, 'Retained pending targets');
  const seed = (scopes: Scope[], sources = true) => {
    const created = plugin.create({ url, budget: { rounds: 1, actions: 12, durationMs: 30000, modelRequests: 8 }, sessionOptions: { headless: true, executionPolicy: 'interface-only', settleMs: 0, observeTimeoutMs: 1000, actionTimeoutMs: 2000, maxActions: 20 } });
    plugin.revise(created.id, { items: scopes.map((scope, i) => ({ title: `Requested ${i}`, scope, prerequisites: [],
      completion: 'Actual fixture event for the requested branch', required: true, reason: 'User-selected recorded scope' })) });
    const task = plugin.store.task(created.id);
    if (sources) for (const item of task.plan) item.evidence = [{ sessionId: sid, observationId: source.id }];
    const round: Round = { id: crypto.randomUUID(), number: 1, sessionId: sid, startedAt: new Date().toISOString(), status: 'paused',
      actions: host.session(sid).actionCount, policyVersion: POLICY_VERSION, stack: [], entryPath: [], reentries: [], tried: [], reviewed: [], noProgress: 0 };
    task.rounds = [round]; task.usage.rounds = 1; task.usage.actions = round.actions; task.status = 'paused'; plugin.store.save(task);
    return task;
  };
  return { url, sid, source, a, checkpoint, oracle, seed, find,
    initialMode(mode: 'A'|'B') { initialMode = mode; },
    get host() { return host; }, get plugin() { return plugin; },
    async away() { await pageOf(host).goto(`${url}away`); await host.observe(sid); },
    async run(id: string) { plugin.start(id); await plugin.waitForIdle(); return plugin.view(id); },
  };
}


async function sourceModes() {
 const f=await fixture(),sourceA=f.source,a=f.a;
 await pageOf(f.host).locator('#mode').evaluate((el:HTMLSelectElement)=>{el.value='B';});
 const sourceB=await f.host.observe(f.sid),b=f.find('Run',sourceB),cpB=await f.host.createCheckpoint(f.sid,'B independently reachable');
 const keyA=browserOperationKey(a,sourceA),keyB=browserOperationKey(b,sourceB);expect(keyA).not.toBe(keyB);
 // B has its own real arrival path: the next entry load presents B.
 // Neither the recovery result nor the subsequent HTTP event is fabricated.
 f.initialMode('B'); await f.away();
 return {f,sourceA,a,sourceB,b,cpB,keyA,keyB};
}
it('control: the retained B condition is independently reachable by the real SDK from away',async()=>{
 const {f,sourceB,b,cpB}=await sourceModes();
 const result=await f.host.reachExplorationTarget(f.sid,{checkpointId:cpB.id,observationId:sourceB.id,actionIds:[b.id],currentObservationId:f.host.observation(f.sid).id});
 expect(result.status,JSON.stringify(result)).toBe('TARGET_REACHED');
 const attempt=await f.host.execute(f.sid,result.matchedActionIds[0],crypto.randomUUID());
 expect(attempt.status).toBe('succeeded');expect(f.oracle).toEqual(['B']);
});
it('a failed A source does not spend the independent B source restoration budget for the same Run control',async()=>{
 const {f,sourceA,a,sourceB,b,keyA,keyB}=await sourceModes();
 const task=f.seed([{url:f.url,kind:'click'}],false),root=task.plan[0];
 const child=(id:string,source:Observation,action:ActionCandidate,key:string):PlanItem=>({id,title:id,scope:scopeFor(action,source),prerequisites:[],completion:'Execute this captured source condition',required:true,dispatchScope:false,status:'pending',reason:'observed_in_scope',operationConditionKey:key,operationConditionPolicy:'browser-operation-key-v2',evidence:[{sessionId:f.sid,observationId:source.id}],attempts:[]});
 task.plan=[child('source-A',sourceA,a,keyA),child('source-B',sourceB,b,keyB),root]; f.plugin.store.save(task);
 const restore=f.host.reachExplorationTarget.bind(f.host),selections:Parameters<BrowserEngine['reachExplorationTarget']>[1][]=[];
 vi.spyOn(f.host,'reachExplorationTarget').mockImplementation(async(sid,request)=>{
  selections.push(request);
  // Only A fails explicitly; it neither changes the browser nor grants arrival.
  if(request.observationId===sourceA.id){const actual=f.host.observation(sid);return {id:crypto.randomUUID(),sessionId:sid,checkpointId:request.checkpointId,status:'UNREACHABLE',reason:'fixture_A_route_unavailable',checks:[],attemptIds:[],observationId:actual.id,targetObservationId:request.observationId,targetActionIds:request.actionIds,matchedActionIds:[],matches:[],checkpointVerified:false,currentExecution:false,executionAuthorized:false,remainingFrontier:f.host.getFrontier(sid).length,diagnostics:{strategies:[],dirtyActions:[],resetAvailable:false,unassessedEffectAttemptIds:[]}};}
  return restore(sid,request);
 });
 const result=await f.run(task.id),pendingA=result.task.plan.find(i=>i.id==='source-A')!,testedB=result.task.plan.find(i=>i.id==='source-B')!;
 expect(f.oracle,JSON.stringify({selections,taskReason:result.task.reason,routeRetries:result.task.routeRetries,deferred:result.task.scheduling?.deferred})).toEqual(['B']);
 expect(pendingA.status).not.toBe('succeeded');expect(pendingA.attempts).toEqual([]);expect(pendingA.resolvedBy).toBeUndefined();
 expect(testedB.status).toBe('succeeded');expect(testedB.attempts).toHaveLength(1);
 expect(selections.some(r=>r.observationId===sourceA.id)).toBe(true);expect(selections.some(r=>r.observationId===sourceB.id)).toBe(true);
});
