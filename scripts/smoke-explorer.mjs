import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { InteractionEngine } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
import { ExplorerPlugin, ExplorerStore } from '@interaction/explorer-plugin';
import { createServer } from '../dist/apps/server/src/server.js';

const directory = resolve('.data', `explorer-smoke-${Date.now()}`);
mkdirSync(directory, {recursive:true});
const fixture=httpServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<title>Compiled explorer fixture</title><main><h1>Controls</h1><button type="button" onclick="this.disabled=true">Alpha</button><button type="button" onclick="this.disabled=true">Beta</button></main>');});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${fixture.address().port}/`;
const engine=new InteractionEngine({persistence:new SqliteStore(resolve(directory,'engine'))});
let fallBack=false;
const decide=async request=>{
  if(request.kind==='generate')return {model:'explicit-smoke-mock',value:{mode:'targeted',items:[{title:'Both controls',scope:{url},prerequisites:[],completion:'Observed interface actions succeed',required:true,reason:'smoke fixture'}]}};
  if(request.kind==='checklist')return {model:'explicit-smoke-mock',value:Object.fromEntries(Object.keys(request.checks).map(k=>[k,k.startsWith('interface_')?.99:.01]))};
  let value=Object.keys(request.options).find(k=>k!=='uncertain');
  if(request.purpose==='task-intent')value='targeted';
  if(request.purpose==='control-classification')value='display';
  if(request.purpose==='scope-review')value='all';
  return {value,model:'explicit-smoke-mock',confidence:1};
};
const plugin=new ExplorerPlugin(engine,new ExplorerStore(resolve(directory,'explorer.sqlite')),{jev:{name:'mock-jev',model:'smoke',decide:async request=>{if(request.purpose==='region-review'&&!fallBack){fallBack=true;return {value:'include',model:'mock-jev',confidence:.5};}return decide(request);}},llm:{name:'mock-llm',model:'smoke',decide}});
const app=await createServer(engine,{explorer:plugin});await app.listen({host:'127.0.0.1',port:0});
const origin=`http://127.0.0.1:${app.server.address().port}`;
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1500,height:1100}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
  const task=plugin.create({url,goal:'编译产物验收：遍历两个控件并验证 JEV 低分不转交 LLM',sessionOptions:{settleMs:0,observeTimeoutMs:100}});
  await page.goto(origin);await page.getByLabel('探索任务',{exact:true}).selectOption(task.id);
  await page.getByRole('button',{name:'开始 / 继续探索',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="自主探索"]')?.textContent?.includes('当前计划完成'));
  const timeline=page.getByLabel('包含模型决策的遍历路径');await timeline.waitFor();
  assert.ok(!(await timeline.innerText()).includes('转交 LLM'));
  const final=plugin.view(task.id);assert.equal(final.task.status,'completed');assert.equal(final.task.usage.actions,2);assert.deepEqual(errors,[]);
  const screenshot=resolve(directory,'dashboard.png');await page.screenshot({path:screenshot,fullPage:true});
  const report={at:new Date().toISOString(),node:process.version,providers:'explicit mocks',compiledPlugin:'passed',compiledUI:'passed',actualBrowserActions:2,fallback:'none for low-confidence grouping',sdkModified:false,screenshot};
  writeFileSync(resolve(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {await browser.close();await app.close();await engine.close();await new Promise(r=>fixture.close(r));}
