import {createServer} from 'node:http';
import {expect,it} from 'vitest';
import {BrowserEngine,type EngineHooks,type ExplorationGroup,type ActionAttempt,type SessionOptions,type ControlReviewRecord} from '@interaction/browser';
import {MemoryStore} from '@interaction/storage-memory';
import {pageOf} from './helpers.js';

async function fixture(html:string,hooks:EngineHooks={},options:Partial<SessionOptions>={}){
 const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(html)});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const engine=new BrowserEngine({persistence:new MemoryStore(),hooks});const s=await engine.createSession({url:`http://127.0.0.1:${(server.address() as any).port}`,headless:true,settleMs:30,observeTimeoutMs:1500,maxActions:100,maxDurationMs:30000,...options});
 return {engine,sid:s.id,close:async()=>{await engine.close();await new Promise<void>(r=>server.close(()=>r()))}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const groups=(t:Fixture)=>t.engine.list<ExplorationGroup>(t.sid,'exploration-group').filter(g=>g.evidence.some(e=>e.rule==='structural-list-operation/v1'));
const attempts=(t:Fixture)=>t.engine.list<ActionAttempt>(t.sid,'attempt');
const source={source:'upper-layer',evidence:['Review repeated records as one collection, retaining individual operations']};
const explore=async(t:Fixture)=>{await t.engine.explore(t.sid);await t.engine.waitForIdle()};
const cards='<div id="records" aria-label="Records">'+['Alpha','Beta','Gamma'].map(n=>`<div data-row-key="${n}"><span>${n}</span><button type="button" onclick="window.chosen.push('${n}')">Open</button></div>`).join('')+'</div><script>window.chosen=[]</script>';

it('defers nonsemantic repeated records, does other work first and executes only the caller sample',async()=>{
 const t=await fixture(cards+'<button type="button">Other work</button>');try{
  expect(groups(t)).toHaveLength(1);expect(groups(t)[0].members).toHaveLength(3);await explore(t);expect(attempts(t).map(a=>a.action.label)).toEqual(['Other work']);
  const g=groups(t)[0],o=t.engine.observation(t.sid);const beta=o.controls.find(c=>c.structuralItem?.recordKey?.includes('Beta'))!;
  await t.engine.decideExplorationGroup(t.sid,g.id,g.revision,{...source,mode:'sample',memberKeys:[g.members.find(m=>m.localId===beta.localId)!.key]});await explore(t);
  expect(await pageOf(t.engine).evaluate(()=>(window as any).chosen)).toEqual(['Beta']);expect(attempts(t).filter(a=>a.action.label==='Open')).toHaveLength(1);
  expect(t.engine.report(t.sid).explorationAudit.counts.policy_excluded).toBe(2);
 }finally{await t.close()}
});

it('does not turn a flat button bar or matching classes into a list, and keeps explicit lists independent',async()=>{
 const t=await fixture('<div><button>One</button><button>Two</button><button>Three</button></div><div role="listbox"><button role="option">A</button><button role="option">B</button></div><div class="same"><a href="#one">Link</a></div><section class="same"><button>Another</button></section>');try{
  expect(groups(t)).toEqual([]);expect(t.engine.list<ExplorationGroup>(t.sid,'exploration-group')).toHaveLength(1);
 }finally{await t.close()}
});

it('recognizes native list records and separates corresponding operation slots without merging identities or purposes',async()=>{
 const t=await fixture('<ul aria-label="Native records">'+['A','B'].map(n=>`<li data-key="${n}"><span>${n}</span><button type="button">Open</button><button type="button">Delete</button></li>`).join('')+'</ul>');try{
  expect(groups(t)).toHaveLength(2);expect(groups(t).map(g=>g.members.map(m=>m.label))).toEqual([['Open','Open'],['Delete','Delete']]);
  const cs=t.engine.observation(t.sid).controls.filter(c=>c.role==='button');expect(new Set(cs.map(c=>c.identityId)).size).toBe(4);
  for(const g of groups(t))expect(t.engine.purposeReviewMaterial(t.sid,g.id).conditions).toEqual([]);
  const g=groups(t).find(g=>g.members[0].label==='Open')!;await t.engine.decideExplorationGroup(t.sid,g.id,g.revision,{...source,mode:'all'});await explore(t);
  expect(attempts(t).map(a=>a.action.label)).toEqual(['Open','Open']);expect(t.engine.session(t.sid).stopReason).toBe('LIST_DECISION_REQUIRED');
 }finally{await t.close()}
});

it('offers tentative inherited-pointer rows for review without granting clicks or sharing a single approval',async()=>{
 const t=await fixture('<div id="records" style="cursor:pointer">'+['Alpha','Beta','Gamma'].map(n=>`<div data-key="${n}" style="height:30px" onclick="void 0">${n}</div>`).join('')+'</div>');try{
  expect(groups(t)).toHaveLength(1);expect(groups(t)[0].members).toHaveLength(3);await explore(t);expect(attempts(t)).toEqual([]);
  const o=t.engine.observation(t.sid),c=o.controls.find(c=>c.name==='Beta')!;
  await t.engine.reviewControls(t.sid,{observationId:o.id,source:'upper-layer',reviews:[{localId:c.localId,kind:'click',risk:'interface',reason:'Probe this row',evidence:['Current exact row and intended interaction reviewed']}]});
  const g=groups(t)[0];const a=t.engine.actions(t.sid).find(a=>a.localId===c.localId)!;await t.engine.decideExplorationGroup(t.sid,g.id,g.revision,{...source,mode:'sample',memberKeys:[g.members.find(m=>m.actionId===a.id)!.key]});await explore(t);
  expect(attempts(t).map(a=>a.action.label)).toEqual(['Beta']);expect(t.engine.observation(t.sid).controls.filter(c=>c.structuralItem&&c.name!=='Beta').every(c=>c.actionBasis?.click?.status==='tentative')).toBe(true);
 }finally{await t.close()}
});

it('discovers pointer-only custom rows even when the cursor is inherited and no handler is enumerated',async()=>{
 const t=await fixture('<div id="records" style="cursor:pointer">'+['A','B','C'].map(n=>`<div style="height:30px">${n}</div>`).join('')+'</div>');try{
  expect(groups(t)).toHaveLength(1);const cs=t.engine.observation(t.sid).controls.filter(c=>c.structuralItem);expect(cs.map(c=>c.name)).toEqual(['A','B','C']);
  expect(cs.every(c=>c.actionBasis?.click?.status==='tentative')).toBe(true);await explore(t);expect(attempts(t)).toEqual([]);
 }finally{await t.close()}
});

it('retains the collection when it grows or shrinks and rejects stale batch versions',async()=>{
 const t=await fixture(cards);try{
  const first=groups(t)[0];await pageOf(t.engine).locator('#records').evaluate(el=>el.insertAdjacentHTML('beforeend','<div data-row-key="Delta"><span>Delta</span><button type="button">Open</button></div>'));await t.engine.observe(t.sid);
  expect(groups(t)).toHaveLength(1);expect(groups(t)[0].members).toHaveLength(4);await expect(t.engine.decideExplorationGroup(t.sid,first.id,first.revision,{...source,mode:'all'})).rejects.toMatchObject({code:'STALE_GROUP_DECISION'});
  await pageOf(t.engine).locator('#records').evaluate(el=>[...el.children].slice(1).forEach(c=>c.remove()));await t.engine.observe(t.sid);
  expect(groups(t)).toHaveLength(1);await explore(t);expect(attempts(t)).toEqual([]);expect(t.engine.session(t.sid).stopReason).toBe('LIST_DECISION_REQUIRED');
 }finally{await t.close()}
});

it('does not transfer a sample or control review when a virtual row node represents a new record',async()=>{
 const t=await fixture(cards);try{
  const o=t.engine.observation(t.sid),c=o.controls.find(c=>c.structuralItem?.recordKey?.includes('Beta'))!;
  await t.engine.reviewControls(t.sid,{observationId:o.id,source:'upper-layer',reviews:[{localId:c.localId,kind:'click',risk:'interface',reason:'Current Beta record',evidence:['Exact record key']}]});
  const g=groups(t)[0],a=t.engine.actions(t.sid).find(a=>a.localId===c.localId)!;const key=g.members.find(m=>m.actionId===a.id)!.key;
  await t.engine.decideExplorationGroup(t.sid,g.id,g.revision,{...source,mode:'sample',memberKeys:[key]});
  await pageOf(t.engine).locator('[data-row-key=Beta]').evaluate(el=>{el.setAttribute('data-row-key','Replacement');el.querySelector('span')!.textContent='Replacement'});
  await expect(t.engine.execute(t.sid,a.id,'recycled')).rejects.toMatchObject({code:'STALE_OBSERVATION'});
  expect(t.engine.list<ControlReviewRecord>(t.sid,'control-review')[0].status).toBe('invalidated');
  const next=t.engine.observation(t.sid).controls.find(n=>n.localId===c.localId)!;expect(next.identityId).not.toBe(c.identityId);
  const f=t.engine.getFrontier(t.sid).find(f=>f.action.observationId===t.engine.observation(t.sid).id&&f.action.localId===c.localId)!;
  expect(f.reason).toBe('list_member_not_selected');expect(attempts(t)).toEqual([]);
 }finally{await t.close()}
});

for(const change of ['replace','label','parent','context'] as const)it(`requires a new collection decision after ${change} and never revives the old grant`,async()=>{
 const t=await fixture(cards+'<div id="destination"></div><span id="context">A</span>',{}, {contextRules:[{key:'mode',selector:'#context'}]});try{
  const g=groups(t)[0];await t.engine.decideExplorationGroup(t.sid,g.id,g.revision,{...source,mode:'all'});
  await pageOf(t.engine).evaluate(change=>{const el=document.querySelector('#records')!;
    if(change==='replace')el.replaceWith(el.cloneNode(true));if(change==='label')el.setAttribute('aria-label','Other records');if(change==='parent')document.querySelector('#destination')!.append(el);if(change==='context')document.querySelector('#context')!.textContent='B';
  },change);await t.engine.observe(t.sid);
  expect(groups(t).find(x=>x.id===g.id)?.status).toBe('invalidated');expect(groups(t).some(x=>x.status==='pending')).toBe(true);
  await pageOf(t.engine).evaluate(()=>{document.querySelector('#records')!.setAttribute('aria-label','Records');document.querySelector('#context')!.textContent='A';});await t.engine.observe(t.sid);
  expect(groups(t).find(x=>x.id===g.id)?.status).toBe('invalidated');
 }finally{await t.close()}
});

it('keeps virtual scrolling gated through an empty window and traverses all only after an explicit decision',async()=>{
 const t=await fixture(String.raw`<div id="viewport" style="height:100px;width:220px;overflow:auto"><div id="rows" style="height:420px"></div></div><button type="button">Other work</button><script>window.chosen=[];const v=document.querySelector("#viewport"),r=document.querySelector("#rows");window.renderRows=()=>{const start=Math.min(6,Math.floor(v.scrollTop/100)*3);r.innerHTML="<div style=\"height:"+v.scrollTop+"px\"></div>"+[start,start+1,start+2].map(i=>"<div data-row-key=\""+i+"\" style=\"height:30px\"><button type=\"button\" onclick=\"window.chosen.push("+i+")\">Open</button></div>").join("")};v.addEventListener("scroll",window.renderRows);window.renderRows()</script>`);try{
  expect(groups(t)).toHaveLength(1);await explore(t);expect(attempts(t).map(a=>a.action.label)).toEqual(['Other work']);
  await pageOf(t.engine).locator('#rows').evaluate(el=>el.replaceChildren());await t.engine.observe(t.sid);await explore(t);expect(attempts(t)).toHaveLength(1);
  expect(t.engine.getFrontier(t.sid).some(f=>f.action.kind==='scroll'&&f.status==='deferred')).toBe(true);
  await pageOf(t.engine).evaluate(()=>(window as any).renderRows());await t.engine.observe(t.sid);const g=groups(t)[0];await t.engine.decideExplorationGroup(t.sid,g.id,g.revision,{...source,mode:'all'});await explore(t);
  expect(await pageOf(t.engine).evaluate(()=>[...new Set((window as any).chosen)].sort())).toEqual([0,1,2,3,4,5,6,7,8]);
  expect(groups(t).filter(g=>g.status!=='invalidated')).toHaveLength(1);expect(t.engine.session(t.sid).actionCount).toBeLessThan(30);
 }finally{await t.close()}
});

it('does not infer a record list from flat menu commands',async()=>{
 const t=await fixture('<div role="menu" aria-label="Commands"><button role="menuitem">First</button><button role="menuitem">Second</button></div>');try{
  expect(groups(t)).toEqual([]);await explore(t);expect(attempts(t).filter(a=>a.action.kind==='click').map(a=>a.action.label).sort()).toEqual(['First','Second']);
 }finally{await t.close()}
});

it('preserves discovery in all mode without granting tentative pointer-row clicks',async()=>{
 const t=await fixture('<div style="cursor:pointer">'+['A','B','C'].map(n=>`<div style="height:30px">${n}</div>`).join('')+'</div>',{}, {listExploration:'all'});try{
  expect(groups(t)).toEqual([]);expect(t.engine.observation(t.sid).controls.filter(c=>c.structuralItem).map(c=>c.name)).toEqual(['A','B','C']);
  await explore(t);expect(attempts(t)).toEqual([]);
 }finally{await t.close()}
});

it('keeps nested records in their nearest collection and reports oversized discovery limits',async()=>{
 const t=await fixture('<div>'+['A','B','C'].map(outer=>'<section><h2>'+outer+'</h2><div>'+[1,2,3].map(n=>`<div data-key="${outer}${n}"><span>${outer}${n}</span><button type="button">Open</button></div>`).join('')+'</div></section>').join('')+'</div><div>'+[1,2,3].map(n=>'<div>'+Array.from({length:105},()=>'<span>text</span>').join('')+'<button type="button">Large '+n+'</button></div>').join('')+'</div>');try{
  expect(groups(t)).toHaveLength(3);expect(groups(t).every(g=>g.members.length===3)).toBe(true);
  expect(t.engine.observation(t.sid).gaps.some(g=>g.code==='STRUCTURAL_LIST_SCAN_TRUNCATED')).toBe(true);
 }finally{await t.close()}
});

it('invalidates changed record operations without accumulating empty decision requests or reviving approvals',async()=>{
 const t=await fixture('<div style="height:100px;overflow:auto"><div id="records" style="height:400px">'+['A','B','C'].map(n=>`<div data-key="${n}"><span>${n}</span><button type="button">Open</button></div>`).join('')+'</div></div>');try{
  const g=groups(t)[0];await t.engine.decideExplorationGroup(t.sid,g.id,g.revision,{...source,mode:'all'});
  await pageOf(t.engine).locator('#records button').evaluateAll(es=>es.forEach(el=>el.setAttribute('type','submit')));await t.engine.observe(t.sid);
  expect(groups(t).find(x=>x.id===g.id)?.status).toBe('invalidated');const count=groups(t).length;
  await t.engine.observe(t.sid);await t.engine.observe(t.sid);expect(groups(t)).toHaveLength(count);
  expect(groups(t).filter(g=>g.status!=='invalidated')).toHaveLength(1);
  await pageOf(t.engine).locator('#records button').evaluateAll(es=>es.forEach(el=>el.setAttribute('type','button')));await t.engine.observe(t.sid);
  expect(groups(t).find(x=>x.id===g.id)?.status).toBe('invalidated');expect(groups(t).filter(g=>g.status!=='invalidated').every(g=>g.status==='pending')).toBe(true);
 }finally{await t.close()}
});

it('retains a hidden collection decision so a deferred popup can be reopened without fresh approval',async()=>{
 const t=await fixture('<button type="button" popovertarget="panel" aria-expanded="false">Open panel</button><button type="button">Other work</button><div id="panel" popover>'+cards+'<button type="button" popovertarget="panel" popovertargetaction="hide">Close panel</button></div>');try{
  await explore(t);const g=groups(t)[0];expect(g.status).toBe('pending');expect(t.engine.session(t.sid).stopReason).toBe('LIST_DECISION_REQUIRED');
  expect(attempts(t).map(a=>a.action.label)).toEqual(['Open panel','Close panel','Other work']);
  await t.engine.decideExplorationGroup(t.sid,g.id,g.revision,{...source,mode:'all'});await explore(t);
  expect(attempts(t).filter(a=>a.action.label==='Open')).toHaveLength(3);expect(groups(t)).toHaveLength(1);
 }finally{await t.close()}
});

it('keeps duplicate controls within a custom record ambiguous despite distinct structural slots',async()=>{
 const t=await fixture('<div>'+['A','B','C'].map(n=>`<div data-key="${n}"><span>${n}</span><button type="button">Open</button><button type="button">Open</button></div>`).join('')+'</div>');try{
  const cs=t.engine.observation(t.sid).controls.filter(c=>c.name==='Open');expect(cs).toHaveLength(6);
  expect(cs.every(c=>c.hypothesisId)).toBe(true);expect(new Set(cs.map(c=>c.stableKey)).size).toBe(3);
  expect(groups(t)).toHaveLength(2);expect(groups(t).every(g=>g.members.length===3)).toBe(true);
 }finally{await t.close()}
});
