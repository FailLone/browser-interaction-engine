import { it,expect } from 'vitest';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { resolve,join } from 'node:path';
import { ExplorerPlugin,ExplorerStore } from '@interaction/explorer-plugin';
import { createServer } from '../apps/server/src/server.js';
import { explorerFixture,fakeProviders } from './explorer-plugin-helpers.js';
it('integrates autonomous exploration, interleaves JEV/LLM decisions and restores task history',async()=>{
 const f=await explorerFixture();const providers=fakeProviders(f.url);const original=providers.jev.decide;let uncertain=false;
 providers.jev.decide=async(r,s)=>{if(r.purpose==='next-action'&&!uncertain){uncertain=true;return {value:'uncertain',confidence:1,model:'mock-jev'};}return original(r,s);};
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(join(f.dir,'plugin.sqlite')),providers);const app=await createServer(f.host,{explorer:plugin});await app.listen({host:'127.0.0.1',port:0});const origin=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
 const ui=await createViteServer({root:resolve('apps/ui'),logLevel:'error',server:{port:0,strictPort:false,proxy:{'/v1':origin,'/plugins':origin}}});await ui.listen();const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1500,height:1100}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 try{const task=plugin.create({url:f.url,goal:'UI acceptance',sessionOptions:{settleMs:0,observeTimeoutMs:100}});await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as {port:number}).port}`);await page.getByLabel('探索任务',{exact:true}).selectOption(task.id);await page.getByRole('button',{name:'开始 / 继续探索',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[aria-label="自主探索"]')?.textContent?.includes('当前计划完成'));
 const timeline=page.getByLabel('包含模型决策的遍历路径');await timeline.waitFor();expect(await timeline.innerText()).toContain('JEV');expect(await timeline.innerText()).toContain('LLM');expect(await timeline.innerText()).toContain('转交 LLM');
 await timeline.getByRole('button').filter({hasText:'请求判断'}).first().click();await page.getByLabel('探索决策详情').waitFor();expect(await page.getByLabel('探索决策详情').innerText()).toContain('mock-llm');
 await page.screenshot({path:join(f.dir,'explorer-ui.png'),fullPage:true});expect(errors).toEqual([]);
 await page.reload();await page.getByLabel('探索任务',{exact:true}).selectOption(task.id);await page.getByLabel('包含模型决策的遍历路径').waitFor();expect(await page.getByLabel('包含模型决策的遍历路径').innerText()).toContain('转交 LLM');
 }finally{await browser.close();await ui.close();await app.close();await f.close();}
});
