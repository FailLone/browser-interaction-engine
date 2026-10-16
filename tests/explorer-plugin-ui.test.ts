import { it,expect } from 'vitest';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { resolve,join } from 'node:path';
import { ExplorerPlugin,ExplorerStore } from '@interaction/explorer-plugin';
import { createServer } from '../apps/server/src/server.js';
import { explorerFixture,fakeProviders,semanticPopupHtml } from './explorer-plugin-helpers.js';
it('shows probe model input, output and actual results separately from click coverage',async()=>{
 const f=await explorerFixture('<div id="info" role="button" tabindex="0" title="More information">Info</div>'),p=fakeProviders(f.url),original=p.jev.decide;
 p.jev.decide=async(r,s)=>r.purpose==='control-classification'?{model:'mock',value:'interaction',confidence:1}:r.purpose==='control-risk'?{model:'mock',value:Object.fromEntries(Object.keys(r.checks!).map(k=>[k,.01]))}:r.purpose==='probe-risk'?{model:'mock',value:Object.fromEntries(Object.keys(r.checks!).map(k=>[k,k==='interface_hover'?.99:.01]))}:original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p),app=await createServer(f.host,{explorer:plugin});await app.listen({host:'127.0.0.1',port:0});const origin=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
 const ui=await createViteServer({root:resolve('apps/ui'),logLevel:'error',server:{port:0,strictPort:false,proxy:{'/v1':origin,'/plugins':origin}}});await ui.listen();const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1500,height:1100}});
 try{const task=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(task.id);await plugin.waitForIdle();const v=plugin.view(task.id),attempt=f.host.list<any>(v.task.rounds[0].sessionId,'attempt')[0];expect(attempt.action.kind).toBe('hover');
  await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as {port:number}).port}`);await page.getByLabel('探索任务',{exact:true}).selectOption(task.id);
  await page.getByLabel('包含模型决策的遍历路径').getByRole('button').filter({hasText:'判断观察探测的用途与风险'}).filter({hasText:'JEV'}).first().click();
  expect(await page.getByRole('tabpanel',{name:'模型输入'}).innerText()).toContain('interface_hover');
  await page.getByRole('tab',{name:'输出',exact:true}).click();expect(await page.getByRole('tabpanel',{name:'模型输出'}).innerText()).toContain('0.99');
  await page.getByRole('tab',{name:'决策影响',exact:true}).click();const impact=page.getByRole('tabpanel',{name:'决策影响'});expect(await impact.innerText()).toContain('已派发观察探测');expect(await impact.innerText()).toContain('探测实际结果（不计点击覆盖）');expect(await impact.innerText()).toContain(attempt.id);expect(await impact.innerText()).toContain('"executionCoverage": false');
  await page.getByLabel('探索决策详情').screenshot({path:resolve('.data/explorer-probe-inspector.png')});
 }finally{await browser.close();await ui.close();await app.close();await f.close();}
});
it('shows unchanged unresolved evidence as a program deferral with its original model reference',async()=>{
 const f=await explorerFixture(`<div role="button" tabindex="0" id="unclear" style="cursor:pointer">Unclear</div><button type="button" onclick="this.disabled=true;document.getElementById('unclear').style.transform='translateY(40px)'">Shift</button>`),p=fakeProviders(f.url),original=p.jev.decide;
 p.jev.decide=async(r,s)=>r.purpose==='control-classification'?{model:'mock',value:'interaction',confidence:1}:r.purpose==='control-risk'&&(r.state as any).material.control.stableKey==='id:unclear'?{model:'mock',value:Object.fromEntries(Object.keys(r.checks!).map(k=>[k,.01]))}:original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p),app=await createServer(f.host,{explorer:plugin});await app.listen({host:'127.0.0.1',port:0});const origin=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
 const ui=await createViteServer({root:resolve('apps/ui'),logLevel:'error',server:{port:0,strictPort:false,proxy:{'/v1':origin,'/plugins':origin}}});await ui.listen();const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1500,height:1100}});
 try{const task=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(task.id);await plugin.waitForIdle();const source=plugin.view(task.id).decisions.find(d=>d.purpose==='control-risk'&&(d.request.state as any).material.control.stableKey==='id:unclear')!;
  await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as {port:number}).port}`);await page.getByLabel('探索任务',{exact:true}).selectOption(task.id);
  const node=page.getByLabel('包含模型决策的遍历路径').getByRole('button').filter({hasText:'用途证据未变，保留待测'}).first();expect(await node.innerText()).toContain('程序');await node.click();const inspector=page.getByLabel('探索决策详情');expect(await inspector.innerText()).toContain('本次未重复调用模型');expect(await inspector.innerText()).toContain(source.id);expect(await inspector.innerText()).toContain('"executionAuthorized": false');
 }finally{await browser.close();await ui.close();await app.close();await f.close();}
});
it('distinguishes completed classification evidence from executed actions in the plan and inspector',async()=>{
 const f=await explorerFixture('<div id="details" tabindex="0">Details</div><button type="button" onclick="this.disabled=true">Ready</button>'),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),fakeProviders(f.url)),app=await createServer(f.host,{explorer:plugin});await app.listen({host:'127.0.0.1',port:0});const origin=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
 const ui=await createViteServer({root:resolve('apps/ui'),logLevel:'error',server:{port:0,strictPort:false,proxy:{'/v1':origin,'/plugins':origin}}});await ui.listen();const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1500,height:1100}});
 try{const task=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.revise(task.id,{items:[{title:'All controls',scope:{url:f.url},required:true,prerequisites:[],completion:'Verify observed controls',reason:'user scope'}]});const saved=plugin.store.task(task.id);saved.plan.push({id:'review-gap',title:'Review Details',scope:{url:f.url,label:'Details',stableKey:'id:details'},required:true,dispatchScope:false,prerequisites:[],completion:'Resolve classification',reason:'classification_unresolved',status:'unresolved',attempts:[],evidence:[]});plugin.store.save(saved);plugin.start(task.id);await plugin.waitForIdle();expect(plugin.view(task.id).task.status).toBe('completed');
  await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as {port:number}).port}`);await page.getByLabel('探索任务',{exact:true}).selectOption(task.id);
  await page.getByLabel('包含模型决策的遍历路径').getByRole('button').filter({hasText:'分类已验证，关闭审阅缺口'}).click();const inspector=page.getByLabel('探索决策详情');expect(await inspector.innerText()).toContain('不代表执行了操作');expect(await inspector.innerText()).toContain('classificationId');expect(await inspector.innerText()).toContain('"executed": false');
  const row=page.locator('.explorer-plan-item').filter({hasText:'Review Details'});expect(await row.innerText()).toContain('有分类证据（不计操作次数）');expect(await row.innerText()).not.toContain('有实际执行证据');await row.getByText('范围、前置条件与证据',{exact:true}).click();expect(await row.innerText()).toContain('reviewResolvedBy');
 }finally{await browser.close();await ui.close();await app.close();await f.close();}
});
it('shows unsupported coverage as a program node with source evidence, not executed coverage',async()=>{
 const f=await explorerFixture('<canvas id="chart"></canvas><button type="button" onclick="this.disabled=true">Ready</button>'),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),fakeProviders(f.url)),app=await createServer(f.host,{explorer:plugin});await app.listen({host:'127.0.0.1',port:0});const origin=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
 const ui=await createViteServer({root:resolve('apps/ui'),logLevel:'error',server:{port:0,strictPort:false,proxy:{'/v1':origin,'/plugins':origin}}});await ui.listen();const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1500,height:1100}});
 try{const task=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(task.id);await plugin.waitForIdle();
  await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as {port:number}).port}`);await page.getByLabel('探索任务',{exact:true}).selectOption(task.id);
  await page.getByLabel('包含模型决策的遍历路径').getByRole('button').filter({hasText:'保留宿主无法验证的范围'}).click();
  const inspector=page.getByLabel('探索决策详情');expect(await inspector.innerText()).toContain('其他控件的执行成功不能替代这部分验证');expect(await inspector.innerText()).toContain('UNSUPPORTED_CANVAS');expect(await inspector.innerText()).toContain('observationId');expect(await inspector.innerText()).toContain('无需模型调用');
  const row=page.locator('.explorer-plan-item').filter({hasText:'当前宿主能力不足：画布内部'});expect(await row.innerText()).toContain('待确认');expect(await row.innerText()).not.toContain('有实际执行证据');
 }finally{await browser.close();await ui.close();await app.close();await f.close();}
});
it('shows a semantic LLM handoff, grounded input/output and the resulting accepted review',async()=>{
 const f=await explorerFixture(semanticPopupHtml),providers=fakeProviders(f.url,{url:f.url,label:'Picker',kind:'click'}),original=providers.jev.decide;
 providers.jev.decide=async(r,s)=>r.purpose==='control-classification'?{model:'mock',value:'interaction',confidence:1}:r.purpose==='control-risk'?{model:'mock',value:Object.fromEntries(Object.keys(r.checks!).map(k=>[k,.5]))}:original(r,s);
 providers.llm.decide=async(r,s)=>r.purpose==='operation-clarification'?{model:'mock-llm',value:{choice:'click',evidenceRefs:['current','actions','effect:click'],reason:'Captured relationship to the child choice panel.',interfaceOnly:true,externalWrite:false}}:original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),providers),app=await createServer(f.host,{explorer:plugin});await app.listen({host:'127.0.0.1',port:0});const origin=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
 const ui=await createViteServer({root:resolve('apps/ui'),logLevel:'error',server:{port:0,strictPort:false,proxy:{'/v1':origin,'/plugins':origin}}});await ui.listen();const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1500,height:1100}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 try {const task=plugin.create({url:f.url,goal:'Open Picker',sessionOptions:{settleMs:0,observeTimeoutMs:300},budget:{rounds:1}});plugin.start(task.id);await plugin.waitForIdle();expect(plugin.view(task.id).task.status).toBe('completed');
  await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as {port:number}).port}`);await page.getByLabel('探索任务',{exact:true}).selectOption(task.id);
  const timeline=page.getByLabel('包含模型决策的遍历路径');await timeline.getByRole('button').filter({hasText:'澄清控件用途'}).first().click();
  const inspector=page.getByLabel('探索决策详情');expect(await inspector.innerText()).toContain('JEV 补充观察后仍有歧义');
  await page.getByRole('tab',{name:'输入',exact:true}).click();expect(await page.getByRole('tabpanel',{name:'模型输入'}).innerText()).toContain('effect:click');
  await page.getByRole('tab',{name:'输出',exact:true}).click();expect(await page.getByRole('tabpanel',{name:'模型输出'}).innerText()).toContain('Captured relationship');
  await page.getByRole('tab',{name:'决策影响',exact:true}).click();const impact=await page.getByRole('tabpanel',{name:'决策影响'}).innerText();expect(impact).toContain('核对结构化结论与证据引用');expect(impact).toContain('reviewControls');expect(impact).toContain('上游判断来源');
  await inspector.screenshot({path:resolve('.data/explorer-semantic-inspector.png')});expect(errors).toEqual([]);
 } finally {await browser.close();await ui.close();await app.close();await f.close();}
});
it('integrates autonomous exploration, interleaves JEV/LLM decisions and restores task history',async()=>{
 const f=await explorerFixture();const providers=fakeProviders(f.url);const original=providers.jev.decide;let uncertain=false;
 providers.jev.decide=async(r,s)=>{if(r.purpose==='region-review'&&!uncertain){uncertain=true;return {value:'include',confidence:.5,model:'mock-jev'};}if(r.purpose==='scope-review')return {value:'sample',confidence:1,model:'mock-jev'};return original(r,s);};
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(join(f.dir,'plugin.sqlite')),providers);const app=await createServer(f.host,{explorer:plugin});await app.listen({host:'127.0.0.1',port:0});const origin=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
 const ui=await createViteServer({root:resolve('apps/ui'),logLevel:'error',server:{port:0,strictPort:false,proxy:{'/v1':origin,'/plugins':origin}}});await ui.listen();const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1500,height:1100}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 try{const task=plugin.create({url:f.url,goal:'UI acceptance',sessionOptions:{settleMs:0,observeTimeoutMs:100}});await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as {port:number}).port}`);await page.getByLabel('探索任务',{exact:true}).selectOption(task.id);await page.getByRole('button',{name:'开始 / 继续探索',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.explorer-task-status strong')?.textContent==='当前计划完成');
 const timeline=page.getByLabel('包含模型决策的遍历路径');await timeline.waitFor();expect(await timeline.innerText()).toContain('JEV');expect(await timeline.innerText()).toContain('LLM');expect(await timeline.innerText()).not.toContain('转交 LLM');
 await timeline.getByRole('button').filter({hasText:'LLM'}).filter({hasText:'请求判断'}).first().click();await page.getByLabel('探索决策详情').waitFor();expect(await page.getByLabel('探索决策详情').innerText()).toContain('mock-llm');
 expect(await page.getByLabel('探索决策详情').evaluate(el=>!!el.closest('.evidence'))).toBe(true);expect(await timeline.getByLabel('探索决策详情').count()).toBe(0);
 expect(await page.getByRole('tabpanel',{name:'模型输入'}).innerText()).toContain('UI acceptance');
 await page.getByRole('tab',{name:'输出',exact:true}).click();expect(await page.getByRole('tabpanel',{name:'模型输出'}).innerText()).toContain('items');
 await page.getByRole('tab',{name:'决策影响',exact:true}).click();expect(await page.getByRole('tabpanel',{name:'决策影响'}).innerText()).toContain('已生成探索计划');
 await page.getByRole('button',{name:'返回页面证据'}).click();expect(await page.getByLabel('探索决策详情').count()).toBe(0);
 await timeline.getByRole('button').filter({hasText:'识别探索区域'}).first().click();
 await page.getByRole('tab',{name:'决策影响',exact:true}).click();
 expect(await page.getByRole('tabpanel',{name:'决策影响'}).innerText()).toContain('不排除候选');
 expect(await page.getByRole('tabpanel',{name:'决策影响'}).innerText()).toContain('evidence-routing-v5');
 await page.getByRole('tab',{name:'输出',exact:true}).click();expect(await page.getByRole('tabpanel',{name:'模型输出'}).innerText()).toContain('include');
 await page.getByRole('button',{name:'返回页面证据'}).click();
 expect(await page.getByLabel('遍历范围',{exact:true}).inputValue()).toBe('all');
 await timeline.getByRole('button').filter({hasText:'程序保留全部已发现成员'}).first().click();
 expect(await page.getByLabel('探索决策详情').innerText()).toContain('无需模型调用');
 expect(await page.getByLabel('探索决策详情').innerText()).toContain('"executionAuthorized": false');
 expect(plugin.view(task.id).decisions.some(d=>d.purpose==='scope-review')).toBe(false);
 await page.getByRole('button',{name:'返回页面证据'}).click();
 await page.screenshot({path:join(f.dir,'explorer-ui.png'),fullPage:true});expect(errors).toEqual([]);
 const firstSession=plugin.view(task.id).task.rounds[0].sessionId;
 plugin.revise(task.id,{goal:'Second round'});plugin.start(task.id);await plugin.waitForIdle(task.id);
 const secondSession=plugin.view(task.id).task.rounds[1].sessionId;
 await page.reload();await page.getByRole('button').filter({hasText:firstSession.slice(0,8)}).click();await timeline.waitFor();
 await page.waitForFunction(id=>document.querySelector<HTMLSelectElement>('[aria-label="探索任务"]')?.value===id,task.id);
 expect(await page.locator('.session-item.selected').innerText()).toContain(firstSession.slice(0,8));
 expect(await timeline.innerText()).not.toContain('转交 LLM');expect(await timeline.innerText()).toContain('本轮模型调用');
 const firstDecisions=plugin.view(task.id).decisions.filter(d=>d.sessionId===firstSession);
 expect(await timeline.getByRole('button').filter({hasText:'请求判断'}).count()).toBe(firstDecisions.length);
 await timeline.getByRole('button').filter({hasText:'查看最近调用'}).click();await page.getByLabel('探索决策详情').waitFor();
 await page.getByRole('button').filter({hasText:secondSession.slice(0,8)}).click();
 await page.waitForFunction(id=>document.querySelector('.session-item.selected')?.textContent?.includes(id),secondSession.slice(0,8));
 expect(await page.getByLabel('探索决策详情').count()).toBe(0);
 expect(await timeline.getByRole('button').filter({hasText:'请求判断'}).count()).toBe(plugin.view(task.id).decisions.filter(d=>d.sessionId===secondSession).length);
 await f.host.stop(secondSession);const ordinary=await f.host.createSession({url:f.url,settleMs:0,observeTimeoutMs:100});await page.reload();
 await page.getByRole('button').filter({hasText:firstSession.slice(0,8)}).click();await timeline.waitFor();
 await timeline.getByRole('button').filter({hasText:'查看最近调用'}).click();await page.getByLabel('探索决策详情').waitFor();
 await page.getByRole('button').filter({hasText:ordinary.id.slice(0,8)}).click();
 await page.waitForFunction(()=>!document.querySelector('[aria-label="探索决策详情"]')&&!document.querySelector('[aria-label="包含模型决策的遍历路径"]'));
 expect(await page.getByLabel('探索任务',{exact:true}).inputValue()).toBe('');expect(errors).toEqual([]);
 }finally{await browser.close();await ui.close();await app.close();await f.close();}
});
it('creates blank exhaustive tasks without LLM and shows JEV task classification for written exhaustive requests',async()=>{
 const f=await explorerFixture(),providers=fakeProviders(f.url),original=providers.jev.decide;
 providers.jev.decide=async(r,s)=>r.purpose==='task-intent'?{model:'mock',value:'exhaustive',confidence:.99}:original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(join(f.dir,'plugin.sqlite')),{jev:providers.jev});const app=await createServer(f.host,{explorer:plugin});await app.listen({host:'127.0.0.1',port:0});const origin=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
 const ui=await createViteServer({root:resolve('apps/ui'),logLevel:'error',server:{port:0,strictPort:false,proxy:{'/v1':origin,'/plugins':origin}}});await ui.listen();const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1500,height:1100}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 try{await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as {port:number}).port}`);await page.getByLabel('自主探索目标').waitFor();expect(await page.getByLabel('自主探索目标').inputValue()).toBe('');expect(await page.getByLabel('遍历范围',{exact:true}).isDisabled()).toBe(true);await page.getByLabel('起始网址',{exact:true}).fill(f.url);
 await page.getByRole('button',{name:'＋ 创建探索任务',exact:true}).click();await page.getByRole('button',{name:'开始 / 继续探索',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.explorer-task-status strong')?.textContent==='当前计划完成');
 const first=plugin.tasks()[0];expect(first.intent).toMatchObject({mode:'exhaustive',source:'default'});expect(plugin.view(first.id).decisions.every(d=>d.actor==='jev')).toBe(true);
 const timeline=page.getByLabel('包含模型决策的遍历路径');expect(await timeline.innerText()).toContain('LLM 0 次');await timeline.getByRole('button').filter({hasText:'程序建立全页范围'}).click();expect(await page.getByLabel('探索决策详情').innerText()).toContain('"llmRequired": false');
 await page.getByLabel('自主探索目标').fill('尽可能穷尽当前页面');await page.getByRole('button',{name:'＋ 创建探索任务',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.explorer-task-status strong')?.textContent==='待开始');
 const second=plugin.tasks().find(t=>t.goal==='尽可能穷尽当前页面')!;expect(second).toBeDefined();expect(await page.getByLabel('探索任务',{exact:true}).inputValue()).toBe(second.id);
 await page.getByRole('button',{name:'开始 / 继续探索',exact:true}).click();
 try{await page.waitForFunction(()=>document.querySelector('.explorer-task-status strong')?.textContent==='当前计划完成');}catch(error){throw new Error(JSON.stringify({ui:await page.getByLabel('自主探索',{exact:true}).innerText(),tasks:plugin.tasks().map(t=>({id:t.id,status:t.status,reason:t.reason,rounds:t.rounds.length})),sessions:f.host.sessions().map(s=>({id:s.id,status:s.status})),error:String(error)}));}
 expect(await page.getByLabel('自主探索',{exact:true}).innerText()).toContain('来源：JEV');expect(await timeline.innerText()).toContain('LLM 0 次');await timeline.getByRole('button').filter({hasText:'判断任务类型'}).first().click();await page.getByRole('tab',{name:'决策影响',exact:true}).click();expect(await page.getByRole('tabpanel',{name:'决策影响'}).innerText()).toContain('program-root');expect(errors).toEqual([]);
 }finally{await browser.close();await ui.close();await app.close();await f.close();}
});
