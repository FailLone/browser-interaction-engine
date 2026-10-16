import { it, expect } from 'vitest';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { resolve } from 'node:path';
import { ExplorerPlugin, ExplorerStore } from '@interaction/explorer-plugin';
import { createServer } from '../apps/server/src/server.js';
import { explorerFixture, fakeProviders } from './explorer-plugin-helpers.js';

it('shows actual classification reuse as program work and links to the original model input and output',async()=>{
  const f=await explorerFixture('<section id="notice" tabindex="0"><p>Notice content</p><a href="/">Reload this page</a></section>'),providers=fakeProviders(f.url),original=providers.jev.decide;
  providers.jev.decide=async(r,s)=>r.purpose==='control-classification'?{model:'mock-classifier',value:'container',confidence:1}:original(r,s);
  const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),providers),app=await createServer(f.host,{explorer:plugin});await app.listen({host:'127.0.0.1',port:0});
  const origin=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`,ui=await createViteServer({root:resolve('apps/ui'),logLevel:'error',server:{port:0,proxy:{'/v1':origin,'/plugins':origin}}});await ui.listen();
  const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1500,height:1100}});
  try{
    const task=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:2,actions:5,durationMs:60000,modelRequests:30}});plugin.start(task.id);await plugin.waitForIdle();
    plugin.revise(task.id,{goal:""});plugin.start(task.id);await plugin.waitForIdle();
    const view=plugin.view(task.id),reuse=view.events.find(e=>e.type==='classification.reused');expect(reuse).toBeDefined();
    const originalId=(reuse!.data as any).details.sourceDecisionIds[0];expect(originalId).toBeTruthy();
    expect(view.decisions.filter(d=>d.purpose==='control-classification')).toHaveLength(1);
    await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as {port:number}).port}`);await page.getByLabel('探索任务',{exact:true}).selectOption(task.id);
    await page.getByLabel('包含模型决策的遍历路径').getByRole('button').filter({hasText:'复用已有分类判断'}).first().click();
    expect(await page.getByLabel('探索决策详情').innerText()).toContain('本次没有调用模型');
    await page.getByRole('button',{name:`查看原模型输入、输出与影响（${originalId.slice(0,8)}）`}).click();
    expect(await page.getByRole('tabpanel',{name:'模型输入'}).innerText()).toContain('Notice content');
    await page.getByRole('tab',{name:'输出',exact:true}).click();expect(await page.getByRole('tabpanel',{name:'模型输出'}).innerText()).toContain('container');
    expect(view.task.usage.modelRequests).toBe(view.decisions.length);
  }finally{await browser.close();await ui.close();await app.close();await f.close();}
},90000);
