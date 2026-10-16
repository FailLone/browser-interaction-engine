import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

// Supply an archived baseline or the current worktree. All interaction occurs
// in freshly owned local HTTP/browser/SQLite fixtures created by testEngine.
const sourceRoot = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const { testEngine, act, pageOf } = await import(pathToFileURL(resolve(sourceRoot, 'tests/helpers.ts')).href);
const results = [];
for (const nested of [false, true]) for (const mode of ['target', 'checkpoint']) {
  const html = `<main>${nested ? '<button id="open" type="button">Open routes</button>' : ''}
    <div id="routes" ${nested ? 'hidden' : ''}><button id="route0" type="button">Route 0</button><button id="route1" type="button">Route 1</button></div>
    <form id="work" hidden><label>Amount<input id="amount" value="1"></label></form></main>
    <script>
      window.routeClicks=[];window.openClicks=0;window.amountInputs=[];window.failFirst=false;
      if(document.querySelector('#open'))document.querySelector('#open').onclick=()=>{window.openClicks++;document.querySelector('#routes').hidden=false;};
      for(let i=0;i<2;i++)document.querySelector('#route'+i).onclick=()=>{window.routeClicks.push(i);if(i!==0||!window.failFirst)document.querySelector('#work').hidden=false;};
      document.querySelector('#amount').oninput=e=>window.amountInputs.push(e.target.value);
    </script>`;
  const server = createServer((_req, res) => { res.setHeader('content-type','text/html');res.end(html); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  let owned: Awaited<ReturnType<typeof testEngine>> | undefined;
  const record: Record<string, unknown> = { nested, mode };
  try {
    const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/`;
    const declarations = ['id:route0','id:route1','id:open'].map(stableKey => ({stableKey}));
    owned = await testEngine(url, { contextRules:[], exploration:'controls', interfaceActions:declarations, replayable:declarations });
    const { engine, sessionId } = owned, page = pageOf(engine);
    let checkpoint, target;
    for(let route=0;route<2;route++){
      if(nested)assert.equal((await act(engine,sessionId,'Open routes')).status,'succeeded');
      assert.equal((await act(engine,sessionId,`Route ${route}`)).status,'succeeded');
      if(!checkpoint){
        checkpoint=await engine.createCheckpoint(sessionId,'ready amount');
        target=engine.actions(sessionId).find(a=>a.label==='Amount'&&a.kind==='fill');assert.ok(target);
      }
      await page.evaluate(nested=>{(document.querySelector('#work') as HTMLElement).hidden=true;if(nested)(document.querySelector('#routes') as HTMLElement).hidden=true;},nested);
      await engine.observe(sessionId);
    }
    await page.evaluate(()=>Object.assign(window,{routeClicks:[],openClicks:0,amountInputs:[],failFirst:true}));
    const start=performance.now();
    const reached=mode==='target'?await engine.reachExplorationTarget(sessionId,{checkpointId:checkpoint.id,observationId:target.observationId,actionIds:[target.id]}):await engine.reachCheckpoint(sessionId,checkpoint.id);
    record.recoveryMs=performance.now()-start;record.status=reached.status;record.reason=reached.reason;
    record.recoveryAttemptLabels=reached.attemptIds.map(id=>engine.store.require('attempt',id).action.label);
    record.routeClicks=await page.evaluate(()=>(window as any).routeClicks);
    record.openClicks=await page.evaluate(()=>(window as any).openClicks);
    record.amountAttemptsBeforeFill=engine.list(sessionId,'attempt').filter(a=>a.action.label==='Amount').length;
    assert.equal(record.amountAttemptsBeforeFill,0,'arrival must not execute the target');
    const arrived=reached.status===(mode==='target'?'TARGET_REACHED':'REACHED_VERIFIED');
    record.arrived=arrived;record.interactive=false;
    if(arrived){
      assert.deepEqual(record.routeClicks,[0,1]);assert.equal(record.openClicks,nested?1:0);
      const current=engine.observation(sessionId),candidates=engine.actions(sessionId).filter(a=>a.label==='Amount'&&a.kind==='fill');assert.equal(candidates.length,1);
      const fill=await engine.execute(sessionId,candidates[0].id,crypto.randomUUID(),'42',{profile:'interface-exploration',observationId:current.id});
      record.fillStatus=fill.status;record.domValue=await page.locator('#amount').inputValue();record.inputEvents=await page.evaluate(()=>(window as any).amountInputs);
      assert.equal(fill.status,'succeeded');assert.equal(record.domValue,'42');assert.deepEqual(record.inputEvents,['42']);
      record.interactive=true;
    }
  }catch(error){record.error=String(error);process.exitCode=1;}
  finally{await owned?.close();await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));}
  results.push(record);
}
const sha=(file:string)=>createHash('sha256').update(readFileSync(resolve(sourceRoot,file))).digest('hex');
const report={sourceRoot,node:process.version,engineSha256:sha('packages/core/src/engine.ts'),runnerSha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),summary:{cases:results.length,arrived:results.filter(r=>r.arrived).length,independentlyInteractive:results.filter(r=>r.interactive).length,errors:results.filter(r=>r.error).length},results};
writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report.summary));
