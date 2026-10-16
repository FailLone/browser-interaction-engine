import { it,expect } from 'vitest';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { resolve } from 'node:path';
import { ExplorerPlugin,ExplorerStore } from '@interaction/explorer-plugin';
import { createServer } from '../apps/server/src/server.js';
import { explorerFixture,fakeProviders } from './explorer-plugin-helpers.js';

it('discards a delayed previous task response and polls only incremental history for the selected task',async()=>{
 const f=await explorerFixture(),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),fakeProviders(f.url));
 const first=plugin.create({url:f.url,goal:'First task'}),second=plugin.create({url:f.url,goal:'Second task'});
 const app=await createServer(f.host,{explorer:plugin});await app.listen({host:'127.0.0.1',port:0});const origin=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
 const ui=await createViteServer({root:resolve('apps/ui'),logLevel:'error',server:{port:0,strictPort:false,proxy:{'/v1':origin,'/plugins':origin}}});await ui.listen();const browser=await chromium.launch({headless:true}),page=await browser.newPage();
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const fullReads=new Map<string,number>();page.on('request',r=>{const match=/\/plugins\/explorer\/v1\/tasks\/([^/?]+)$/.exec(r.url());if(match&&r.method()==='GET')fullReads.set(match[1],(fullReads.get(match[1])||0)+1);});
 await page.route(`**/plugins/explorer/v1/tasks/${first.id}`,async route=>{entered();await gate;try{await route.continue();}catch{/* Switching tasks cancels the obsolete request. */}});
 try{
  await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as {port:number}).port}`);const select=page.getByLabel('探索任务',{exact:true});await select.selectOption(first.id);await started;
  await select.selectOption(second.id);await page.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('[aria-label="自主探索目标"]')?.value==='Second task');release();
  for(let i=0;i<2;i++)await page.waitForResponse(r=>r.url().includes(`/tasks/${second.id}/updates?after=`));
  expect(await select.inputValue()).toBe(second.id);expect(await page.getByLabel('自主探索目标',{exact:true}).inputValue()).toBe('Second task');expect(fullReads.get(second.id)).toBe(1);expect(errors).toEqual([]);
 }finally{release();await browser.close();await ui.close();await app.close();await f.close();}
});
