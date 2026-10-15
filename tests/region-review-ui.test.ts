import { expect, it } from 'vitest';
import { createServer as httpServer } from 'node:http';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { resolve } from 'node:path';
import { createServer } from '../apps/server/src/server.js';
import { pageOf, testEngine } from './helpers.js';

it('confirms suggested regions separately from exploration and rejects stale UI drafts', async () => {
  const fixture = httpServer((_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<div><h2>金额区</h2><input aria-label="金额"><input aria-label="结果"></div><div><h2>图表区</h2><button>日线</button><button>周线</button></div>');});await new Promise<void>(r=>fixture.listen(0,'127.0.0.1',r));
  const t=await testEngine(`http://127.0.0.1:${(fixture.address() as any).port}`,{contextRules:[],regionExploration:'review',exploration:'controls'});
  const api=await createServer(t.engine);await api.listen({host:'127.0.0.1',port:0});
  const ui=await createViteServer({root:resolve('apps/ui'),logLevel:'error',server:{port:0,strictPort:false,proxy:{'/v1':`http://127.0.0.1:${(api.server.address() as any).port}`}}});await ui.listen();
  const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as any).port}`);expect(await page.getByRole('checkbox',{name:'先确认探索区域再探索'}).isChecked()).toBe(false);
    await page.locator('.session-item').first().click();await page.getByRole('button',{name:'范围决策',exact:true}).click();
    const partition=page.getByRole('region',{name:'探索区域划分'});await partition.getByRole('button',{name:'采用建议生成草稿'}).click();
    expect(await partition.locator('.region-draft .data-row').count()).toBe(2);
    await pageOf(t.engine).evaluate(()=>document.querySelector('button')!.parentElement!.insertAdjacentHTML('beforeend','<button>月线</button>'));
    await t.engine.observe(t.sessionId);await partition.getByText('观察已更新，请重新载入划分草稿。').waitFor();expect(await partition.getByRole('button',{name:'确认划分并生成探索范围'}).isDisabled()).toBe(true);
    await partition.getByRole('button',{name:'采用建议生成草稿'}).click();expect(await partition.locator('.region-draft').getByText('3 个控件',{exact:true}).count()).toBe(1);await partition.getByRole('button',{name:'确认划分并生成探索范围'}).click();
    const scopes=page.getByRole('region',{name:'探索范围决策'});await scopes.getByRole('checkbox',{name:'选择范围：金额区'}).waitFor();
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);expect(t.engine.regionReviewMaterial(t.sessionId).review?.regions).toHaveLength(2);
    await scopes.getByRole('checkbox',{name:'选择范围：金额区'}).check();await scopes.getByRole('button',{name:'穷尽所选范围',exact:true}).click();
    await page.getByRole('button',{name:'▶ DFS 探索',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.runbar .badge')?.textContent==='已暂停');
    expect(t.engine.session(t.sessionId).actionCount).toBe(2);expect(errors).toEqual([]);
  }finally{await browser.close();await ui.close();await api.close();await t.close();await new Promise<void>(r=>fixture.close(()=>r()));}
});
