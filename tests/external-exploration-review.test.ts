import { createServer as createSite } from 'node:http';
import { expect, it } from 'vitest';
import { BrowserEngine, type RegionReviewMaterial } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { InteractionClient } from '@interaction/client';
import { createServer } from '../apps/server/src/server.js';
import { reviewExploration } from '../examples/external-exploration-review.js';

async function setup() {
  const site = createSite((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<input aria-label="Amount"><select aria-label="Choice"><option>A</option><option>B</option><option>C</option></select>');});
  await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
  const engine=new BrowserEngine({persistence:new MemoryStore()});
  const api=await createServer(engine);await api.listen({host:'127.0.0.1',port:0});
  const client=new InteractionClient(`http://127.0.0.1:${(api.server.address() as any).port}`);
  const session=await client.createSession({url:`http://127.0.0.1:${(site.address() as any).port}`,headless:true,regionExploration:'review',settleMs:30,observeTimeoutMs:600});
  return {client,engine,sid:session.id,close:async()=>{await api.close();await engine.close();await new Promise<void>(r=>site.close(()=>r()));}};
}
const partition=(m:RegionReviewMaterial)=>({observationId:m.observationId,source:'example-caller',evidence:['UI inspection covers all current controls'],
  regions:[{key:'entry',label:'Entry UI',candidateIds:[m.candidates.find(c=>c.basis==='document')!.id],controlIds:m.controls.map(c=>c.localId),pageTraversal:true}]});

it('runs the external example through HTTP, deciding new regions and list samples independently',async()=>{
  const t=await setup();try{
    await reviewExploration(t.client,t.sid,{partition:async m=>partition(m),decide:async m=>{
      expect(m.groups.some(g=>g.kind==='reviewed-region')).toBe(true);
      return m.groups.map(g=>({groupId:g.id,revision:g.revision,decision:g.kind==='similar-list'
        ? {mode:'sample' as const,memberKeys:g.members.filter(m=>m.value==='B').map(m=>m.key),source:'example-caller',evidence:['Only B is in the requested sample']}
        : {mode:'all' as const,source:'example-caller',evidence:['Inspect this UI region']}}));
    }});
    await t.engine.waitForIdle();const report=await t.client.report(t.sid);
    expect(report.explorationAudit.counts.succeeded).toBe(2);expect(report.explorationAudit.counts.policy_excluded).toBe(2);
    expect(report.explorationAudit.discoveryComplete).toBe(false);
    expect(report.completionAudit).toMatchObject({ unit: 'observed_browser_scope', status: 'unverified', exhaustive: false });
    expect(report.completionAudit.recordedActions.counts.policy_excluded).toBe(2);
  }finally{await t.close();}
});

it('leaves a stale external partition paused without rewriting its observation or deciding later scopes',async()=>{
  const t=await setup();let decided=false;try{
    await expect(reviewExploration(t.client,t.sid,{partition:async m=>{await t.client.observe(t.sid);return partition(m);},decide:async()=>{decided=true;return [];}})).rejects.toMatchObject({code:'STALE_REGION_REVIEW'});
    expect(decided).toBe(false);expect(t.engine.session(t.sid)).toMatchObject({status:'paused',actionCount:0});
    expect(t.engine.regionReviewMaterial(t.sid).review).toBeUndefined();
  }finally{await t.close();}
});
