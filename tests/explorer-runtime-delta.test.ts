import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { BrowserEngine, type ActionAttempt } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
import { ExplorerPlugin, ExplorerStore, type Task } from '@interaction/explorer-plugin';
import { fakeProviders } from './explorer-plugin-helpers.js';

/** Every server, browser and SQLite file belongs to this fixture. The HTTP
 * oracle records actual UI events independently of task completion claims. */
async function fixture() {
  const events:string[]=[],directory=mkdtempSync(join(tmpdir(),'explorer-runtime-delta-'));
  const server=createServer((request,response)=>{
    if(request.url?.startsWith('/oracle?')){events.push(new URL(request.url,'http://fixture').searchParams.get('label')!);response.writeHead(204);response.end();return;}
    response.setHeader('Content-Type','text/html');
    response.end(`<!doctype html><title>Runtime delta fixture</title><main>
      ${['Alpha','Beta'].map(label=>`<button id="${label.toLowerCase()}" type="button" onclick="record('${label}');this.disabled=true">${label}</button>`).join('')}
      </main><script>function record(label){const request=new XMLHttpRequest();request.open('POST','/oracle?label='+label,false);request.send();}</script>`);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/`,providers=fakeProviders(url);
  const hostPath=join(directory,'host'),pluginPath=join(directory,'plugin.sqlite');
  let host=new BrowserEngine({persistence:new SqliteStore(hostPath)}),store=new ExplorerStore(pluginPath),plugin=new ExplorerPlugin(host,store,providers);
  return {url,events,providers,pluginPath,get host(){return host;},get store(){return store;},get plugin(){return plugin;},
    create(){return plugin.create({url,budget:{rounds:2,actions:10,durationMs:60000,modelRequests:20},sessionOptions:{headless:true,settleMs:0,observeTimeoutMs:200,actionTimeoutMs:2000}});},
    async restart(){await plugin.close();await host.close();host=new BrowserEngine({persistence:new SqliteStore(hostPath)});store=new ExplorerStore(pluginPath);plugin=new ExplorerPlugin(host,store,providers);},
    async close(){await plugin.close();await host.close();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});}};
}

it('uses delta persistence in the public runtime and commits every active in-memory change together',async()=>{
  const f=await fixture();
  try{
    const task=f.create(),read=f.store.task.bind(f.store),apply=f.store.applyTaskDelta.bind(f.store);
    let dispatched=false,fullSavesAfterDispatch=0,fullReadsAfterDispatch=0;
    const snapshots:{expected:Task;actual:Task}[]=[];
    const fullSave=f.store.save.bind(f.store),fullRead=f.store.task.bind(f.store);
    vi.spyOn(f.store,'save').mockImplementation((...args)=>{if(dispatched)fullSavesAfterDispatch++;return fullSave(...args);});
    const reads=vi.spyOn(f.store,'task').mockImplementation(id=>{if(dispatched)fullReadsAfterDispatch++;return fullRead(id);});
    const fullAudits=vi.spyOn(f.store,'taskState');
    const allTasks=vi.spyOn(f.store,'tasks').mockImplementation(()=>{throw Error('Runtime scanned every retained task');});
    const deltas=vi.spyOn(f.store,'applyTaskDelta').mockImplementation((id,version,delta)=>{
      const active=(f.plugin as unknown as {active?:{task:Task}}).active?.task;
      // Compare the same JSON persistence representation, independently of the write set.
      const expected=active?JSON.parse(JSON.stringify(active)) as Task:undefined;
      const committed=apply(id,version,delta);
      if(expected)snapshots.push({expected:{...expected,updatedAt:committed.updatedAt},actual:read(id)});
      return committed;
    });
    const execute=f.host.execute.bind(f.host);
    vi.spyOn(f.host,'execute').mockImplementation((...args)=>{dispatched=true;return execute(...args);});
    f.plugin.start(task.id);await f.plugin.waitForIdle(task.id);
    const result=read(task.id);
    expect(f.events).toEqual(['Alpha','Beta']);expect(result.status).toBe('completed');
    expect(deltas.mock.calls.length).toBeGreaterThan(5);
    expect(deltas.mock.calls.some(([, ,delta])=>!!delta.plan?.update?.length)).toBe(true);
    expect(deltas.mock.calls.some(([, ,delta])=>!!delta.rounds?.update?.length)).toBe(true);
    expect(fullAudits).toHaveBeenCalledTimes(1);expect(reads).not.toHaveBeenCalled();expect(allTasks).not.toHaveBeenCalled();
    expect(fullSavesAfterDispatch).toBe(0);expect(fullReadsAfterDispatch).toBe(0);
    expect(snapshots.length).toBeGreaterThan(5);
    for(const snapshot of snapshots)expect(snapshot.actual).toEqual(snapshot.expected);
    const attempts=result.rounds.flatMap(round=>f.host.list<ActionAttempt>(round.sessionId,'attempt'));
    expect(attempts).toHaveLength(2);expect(attempts.every(attempt=>attempt.status==='succeeded')).toBe(true);

    // An event after the active task is released resolves its owner by the
    // indexed session lookup, without rebuilding every retained task.
    const owner=vi.spyOn(f.store,'taskIdForSession'),sid=result.rounds[0].sessionId,priorAllReads=allTasks.mock.calls.length;
    f.host.events.emit('event',{sequence:987654,sessionId:sid,at:new Date().toISOString(),type:'test.runtime_delta_owner',data:{}});
    expect(owner).toHaveBeenCalledWith(sid);expect(allTasks).toHaveBeenCalledTimes(priorAllReads);expect(reads).not.toHaveBeenCalled();
    expect(f.store.events(task.id).some(event=>event.type==='test.runtime_delta_owner'&&event.sessionId===sid)).toBe(true);
  }finally{vi.restoreAllMocks();await f.close();}
});

it('retains a delta-written unknown dispatch across cold restart before any new browser or model work',async()=>{
  const f=await fixture();
  try{
    const task=f.create(),execute=f.host.execute.bind(f.host);let unknownId='',sid='';
    const deltas=vi.spyOn(f.store,'applyTaskDelta');
    vi.spyOn(f.host,'execute').mockImplementation(async(...args)=>{
      const attempt=await execute(...args);
      if(!unknownId&&attempt.status==='succeeded'){
        const unknown={...attempt,status:'unknown',reason:'Independent durable result-loss fault'} satisfies ActionAttempt;
        f.host.store.put('attempt',unknown);unknownId=unknown.id;sid=unknown.sessionId;return unknown;
      }
      return attempt;
    });
    f.plugin.start(task.id);await f.plugin.waitForIdle(task.id);
    const before=f.store.task(task.id);
    expect(unknownId).not.toBe('');expect(f.events).toEqual(['Alpha']);
    expect(before).toMatchObject({status:'blocked',reason:'UNKNOWN_DISPATCH_REQUIRES_REVIEW'});
    expect(before.pendingDispatch?.sessionId).toBe(sid);
    expect(before.plan.some(item=>item.scope.label==='Beta'&&item.status!=='succeeded')).toBe(true);
    expect(before.plan.some(item=>item.attempts.some(attempt=>attempt.outcome==='unknown'))).toBe(true);
    expect(deltas.mock.calls.some(([, ,delta])=>delta.header.pendingDispatch!==undefined)).toBe(true);
    vi.restoreAllMocks();await f.restart();
    const create=vi.spyOn(f.host,'createSession'),observe=vi.spyOn(f.host,'observe'),dispatch=vi.spyOn(f.host,'execute');
    const target=vi.spyOn(f.host,'reachExplorationTarget'),checkpoint=vi.spyOn(f.host,'reachCheckpoint');
    const jev=vi.spyOn(f.providers.jev,'decide'),llm=vi.spyOn(f.providers.llm,'decide');
    const resumed=vi.spyOn(f.store,'applyTaskDelta');
    f.plugin.start(task.id);await f.plugin.waitForIdle(task.id);
    const after=f.store.task(task.id);
    expect(after).toMatchObject({status:'blocked',reason:'UNKNOWN_DISPATCH_REQUIRES_REVIEW'});
    expect(after.pendingDispatch).toEqual(before.pendingDispatch);
    expect(after.plan).toEqual(before.plan);expect(after.rounds).toHaveLength(before.rounds.length);
    expect(f.host.list<ActionAttempt>(sid,'attempt').find(attempt=>attempt.id===unknownId)?.status).toBe('unknown');
    expect(resumed).toHaveBeenCalled();
    for(const operation of [create,observe,dispatch,target,checkpoint,jev,llm])expect(operation).not.toHaveBeenCalled();
    expect(f.events).toEqual(['Alpha']);
  }finally{vi.restoreAllMocks();await f.close();}
});

it('halts a stale public runtime writer without overwriting another connection pending intent or budget',async()=>{
  const f=await fixture(),other=new ExplorerStore(f.pluginPath);
  try{
    const task=f.create(),create=f.host.createSession.bind(f.host);let committed:Task|undefined;
    vi.spyOn(f.host,'createSession').mockImplementation(async input=>{
      const session=await create(input),state=other.taskHeader(task.id);
      other.applyTaskDelta(task.id,state.version,{header:{...state.header,status:'blocked',reason:'concurrent_owner',
        budget:{...state.header.budget,actions:20},pendingDispatch:{sessionId:session.id,requestId:'other-unknown-request',actionId:'other-action',itemIds:[],observationId:f.host.observation(session.id).id}}});
      committed=other.task(task.id);return session;
    });
    const execute=vi.spyOn(f.host,'execute');
    f.plugin.start(task.id);await f.plugin.waitForIdle(task.id);
    expect(committed).toBeDefined();expect(f.store.task(task.id)).toEqual(committed);
    expect(f.store.task(task.id).pendingDispatch?.requestId).toBe('other-unknown-request');
    expect(execute).not.toHaveBeenCalled();expect(f.events).toEqual([]);
    expect(f.store.events(task.id).some(event=>event.type==='task.halted'&&(event.data as {reason?:string}).reason==='STALE_TASK_VERSION')).toBe(true);
  }finally{vi.restoreAllMocks();other.close();await f.close();}
});

it('rejects an inactive pause whose await window acquired a newer pending intent on another connection',async()=>{
  const f=await fixture(),other=new ExplorerStore(f.pluginPath);
  try{
    const task=f.create();f.plugin.start(task.id);await f.plugin.waitForIdle(task.id);
    expect(f.plugin.owner()).toBeUndefined();expect(f.store.task(task.id).status).toBe('completed');
    const pause=f.host.pause.bind(f.host);let committed:Task|undefined;
    vi.spyOn(f.host,'pause').mockImplementation(async sid=>{
      const result=await pause(sid),state=other.taskHeader(task.id);
      other.applyTaskDelta(task.id,state.version,{header:{...state.header,status:'blocked',reason:'concurrent_owner_during_pause',
        budget:{...state.header.budget,actions:20},pendingDispatch:{sessionId:sid,requestId:'pause-window-unknown',actionId:'other-action',itemIds:[],observationId:f.host.observation(sid).id}}});
      committed=other.task(task.id);return result;
    });
    await expect(f.plugin.pause(task.id)).rejects.toThrow('STALE_TASK_VERSION');
    expect(committed).toBeDefined();expect(f.store.task(task.id)).toEqual(committed);
    expect(f.store.task(task.id).pendingDispatch?.requestId).toBe('pause-window-unknown');
    expect(f.events).toEqual(['Alpha','Beta']);
  }finally{vi.restoreAllMocks();other.close();await f.close();}
});
