import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { BrowserEngine, type DiscoveryScanRecord, type ExplorationGroup, type SessionOptions } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { SqliteStore } from '@interaction/storage-sqlite';
import { InteractionClient } from '@interaction/client';
import { createServer as createApi } from '../apps/server/src/server.js';
import { pageOf } from './helpers.js';

async function setup(html: string, options: Partial<SessionOptions> = {}, persistence: MemoryStore | SqliteStore = new MemoryStore()) {
  const site = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
  const engine = new BrowserEngine({ persistence });
  try {
    const s = await engine.createSession({ url: `http://127.0.0.1:${(site.address() as any).port}`, headless: true, settleMs: 30, observeTimeoutMs: 3000, evidence: {enabled: false}, ...options });
    return { engine, sid: s.id, close: async () => { await engine.close(); await new Promise<void>(r => site.close(() => r())); } };
  } catch (error) { await engine.close(); site.close(); throw error; }
}
type Fixture = Awaited<ReturnType<typeof setup>>;
const padding = '<div hidden>' + '<i></i>'.repeat(5100) + '</div>';
const tail = '<div id="tail" style="cursor:pointer;height:30px">Late custom entry</div>';
const records = (t: Fixture) => t.engine.list<DiscoveryScanRecord>(t.sid, 'discovery-scan');
function input(t: Fixture, budget: {offset?:number;elements?:number;templateNodes?:number;templateDepth?:number;collections?:number} = {}, selector?: string) {
  const m = t.engine.discoveryScanMaterial(t.sid);
  return { observationId: m.observationId, targetId: m.discovery!.targets.find(t => selector ? t.selector === selector : t.tag === 'html')!.id,
    source: 'fixture-upper-layer', evidence: ['Review current omission locations; read only the specified window'], budget };
}

it('locates omitted signals and supplements a bounded window without granting or executing an action', async () => {
  const t = await setup(padding + tail); try {
    const before = t.engine.observation(t.sid), m = t.engine.discoveryScanMaterial(t.sid);
    const root = m.discovery!.targets.find(t => t.tag === 'html')!;
    expect(root.selector).toBe('html'); expect(await pageOf(t.engine).locator(root.selector).count()).toBe(1);
    expect(m.discovery?.signal).toMatchObject({scanned:5000, firstOmitted:{index:5000}});
    expect(before.controls.some(c => c.stableKey === 'id:tail')).toBe(false);
    const r = await t.engine.supplementDiscovery(t.sid, input(t, {offset:5000, elements:200}));
    const after = t.engine.observation(t.sid), c = after.controls.find(c => c.stableKey === 'id:tail')!;
    expect(r).toMatchObject({status:'active', resultObservationId:after.id, source:'fixture-upper-layer'});
    expect(after.discoveryScan?.signal.omitted).toBe(0); expect(c.interactionHints?.some(h => h.rule.includes('cursor') || h.rule.includes('pointer'))).toBe(true);
    expect(t.engine.actions(t.sid).some(a => a.localId === c.localId && a.basis?.status === 'supported')).toBe(false);
    expect(t.engine.controlReviewMaterial(t.sid).pendingControlIds).toContain(c.localId);
    expect(t.engine.session(t.sid).actionCount).toBe(0); expect(t.engine.list(t.sid, 'attempt')).toEqual([]);
    expect(t.engine.observation(t.sid, before.id)).toEqual(before);
    const audit = t.engine.report(t.sid).completionAudit;
    expect(audit.gaps.find(g => g.code === 'SIGNAL_SCAN_TRUNCATED')).toMatchObject({current:false});
    expect(audit.discovery.find(d => d.current)?.scan.signal.omitted).toBe(0); expect(audit.exhaustive).toBe(false);
    expect(audit.gaps.some(g => g.code === 'EVENT_LISTENER_COVERAGE' && g.current)).toBe(true);
  } finally { await t.close(); }
});

for (const kind of ['depth','nodes'] as const) it(`locates a ${kind} limit and discovers a list only after bounded supplementation`, async () => {
  const content = kind === 'depth' ? '<div>'.repeat(10)+'<button type="button">Open</button>'+'</div>'.repeat(10) : '<span>x</span>'.repeat(105)+'<button type="button">Open</button>';
  const t = await setup('<ul id="records">'+['A','B'].map(k=>`<li data-key="${k}">${content}</li>`).join('')+'</ul>'); try {
    const before = t.engine.observation(t.sid);
    expect(before.discoveryScan?.structural.omissions.some(o => o.kind === (kind === 'depth' ? 'template_depth':'template_nodes') && o.ownerSelector === '#records')).toBe(true);
    expect(before.structuralLists).toEqual([]);
    await t.engine.supplementDiscovery(t.sid, input(t, {templateNodes:200, templateDepth:15}, '#records'));
    const after = t.engine.observation(t.sid);
    expect(after.discoveryScan?.structural.templatesTruncated).toBe(0); expect(after.structuralLists?.[0].members).toHaveLength(2);
    const groups = t.engine.list<ExplorationGroup>(t.sid, 'exploration-group').filter(g=>g.kind==='similar-list');
    expect(groups.some(g=>g.status==='pending' && g.members.length===2)).toBe(true);
    expect(t.engine.session(t.sid).actionCount).toBe(0);
  } finally { await t.close(); }
});

it('reports partial sibling windows with exact owner and never calls them complete', async () => {
  const t = await setup('<div hidden>'+'<i></i>'.repeat(4990)+'</div><ul id="rows">'+['A','B','C','D','E'].map(n=>`<li data-key="${n}"><button type="button">${n}</button></li>`).join('')+'</ul>'); try {
    expect(t.engine.observation(t.sid).discoveryScan?.structural.omissions).toContainEqual(expect.objectContaining({kind:'row_window',ownerSelector:'#rows'}));
    await t.engine.supplementDiscovery(t.sid, input(t, {elements:30}, '#rows'));
    expect(t.engine.observation(t.sid).discoveryScan?.structural.rowWindowsTruncated).toBe(0);
    expect(t.engine.observation(t.sid).structuralLists?.[0].members).toHaveLength(5);
  } finally { await t.close(); }
});

it('locates the collection cap and expands it only to the explicitly requested bound', async () => {
  const t = await setup(Array.from({length:302},(_,i)=>`<ul id="list${i}"><li data-key="A"><button type="button">A${i}</button></li><li data-key="B"><button type="button">B${i}</button></li></ul>`).join(''), {observeTimeoutMs:15000}); try {
    const before = t.engine.observation(t.sid);
    expect(before.structuralLists).toHaveLength(300);
    expect(before.discoveryScan?.structural.omissions).toContainEqual(expect.objectContaining({kind:'collections',ownerSelector:'#list300',limit:300}));
    await t.engine.supplementDiscovery(t.sid,input(t,{collections:301}));
    expect(t.engine.observation(t.sid).structuralLists).toHaveLength(301);
    expect(t.engine.observation(t.sid).discoveryScan?.structural.collectionsTruncated).toBe(true);
    await t.engine.supplementDiscovery(t.sid,input(t,{collections:302}));
    expect(t.engine.observation(t.sid).structuralLists).toHaveLength(302);
    expect(t.engine.observation(t.sid).discoveryScan?.structural.collectionsTruncated).toBe(false);
    expect(t.engine.session(t.sid).actionCount).toBe(0);
  } finally { await t.close(); }
});

it('retains the critical main-control cap even when supplementary signal scanning is requested', async () => {
  const t = await setup('<button type="button">X</button>'.repeat(1501), {observeTimeoutMs:15000}); try {
    const before=t.engine.observation(t.sid);
    expect(before.discoveryScan?.controls).toMatchObject({discovered:1501,collected:1500,limit:1500});
    expect(before.gaps.some(g=>g.code==='TRUNCATED' && g.critical)).toBe(true);
    await expect(t.engine.supplementDiscovery(t.sid,input(t))).rejects.toMatchObject({code:'STALE_DISCOVERY_SCAN'});
    expect(records(t)).toEqual([]);expect(t.engine.observation(t.sid).gaps.some(g=>g.code==='TRUNCATED' && g.critical)).toBe(true);
  } finally { await t.close(); }
});

it('replaces the active window rather than accumulating unbounded nodes, keeping both observations and records', async () => {
  const t = await setup(padding + tail + '<div hidden>'+'<i></i>'.repeat(5200)+'</div>'); try {
    const first = await t.engine.supplementDiscovery(t.sid, input(t, {offset:5000,elements:200}));
    expect(t.engine.observation(t.sid).controls.some(c=>c.stableKey==='id:tail')).toBe(true);
    const second = await t.engine.supplementDiscovery(t.sid, input(t, {offset:10000,elements:5000}));
    const after=t.engine.observation(t.sid);
    expect(after.discoveryScan!.signal.scanned).toBeLessThanOrEqual(10000); expect(after.discoveryScan!.signal.omitted).toBeGreaterThan(0);
    expect(after.controls.some(c=>c.stableKey==='id:tail')).toBe(false);
    expect(records(t).find(r=>r.id===first.id)).toMatchObject({status:'superseded',replacedBy:second.id});
    expect(t.engine.observation(t.sid,first.resultObservationId).controls.some(c=>c.stableKey==='id:tail')).toBe(true);
    expect(t.engine.report(t.sid).discoveryScans).toHaveLength(2);
  } finally { await t.close(); }
});

for (const change of ['insert','replace','reparent','url','reload'] as const) it(`invalidates a supplemental window after ${change} and never revives it`, async () => {
  const t=await setup('<div id="one"><span id="target">Text</span></div><div id="two"></div>'); try {
    const r=await t.engine.supplementDiscovery(t.sid,input(t));
    if(change==='reload')await pageOf(t.engine).reload();
    else await pageOf(t.engine).evaluate(change=>{
      const el=document.querySelector('#target')!;
      if(change==='insert')el.append(document.createElement('i'));
      if(change==='replace')el.replaceWith(el.cloneNode(true));
      if(change==='reparent')document.querySelector('#two')!.append(el);
      if(change==='url')history.pushState({},'','#changed');
    },change);
    await t.engine.observe(t.sid);expect(records(t).find(x=>x.id===r.id)).toMatchObject({status:'invalidated'});
    await t.engine.observe(t.sid);expect(records(t)[0].status).toBe('invalidated');expect(t.engine.session(t.sid).actionCount).toBe(0);
  } finally { await t.close(); }
});

it('retains a read-only scan through text changes but rejects a stale topology even when ordinary controls did not change', async () => {
  const t=await setup('<div id="text">One</div>'); try {
    const r=await t.engine.supplementDiscovery(t.sid,input(t));
    await pageOf(t.engine).locator('#text').evaluate(el=>el.textContent='Two');await t.engine.observe(t.sid);
    expect(records(t).find(x=>x.id===r.id)?.status).toBe('active');
    const stale=input(t);await pageOf(t.engine).evaluate(()=>document.body.append(document.createElement('i')));
    await expect(t.engine.supplementDiscovery(t.sid,stale)).rejects.toMatchObject({code:'STALE_DISCOVERY_SCAN'});
    expect(records(t)).toHaveLength(1);expect(records(t)[0].status).toBe('invalidated');
  } finally { await t.close(); }
});

it('rechecks an active supplemental window before dispatching an otherwise unchanged native operation', async () => {
  const t=await setup('<button type="button" onclick="window.clicked=true">Open</button>');try {
    await t.engine.supplementDiscovery(t.sid,input(t));const action=t.engine.actions(t.sid).find(a=>a.label==='Open')!;
    await pageOf(t.engine).evaluate(()=>document.body.append(document.createElement('i')));
    await expect(t.engine.execute(t.sid,action.id,'changed-window')).rejects.toMatchObject({code:'STALE_OBSERVATION'});
    expect(await pageOf(t.engine).evaluate(()=>(window as any).clicked)).toBeUndefined();
    expect(records(t)[0].status).toBe('invalidated');expect(t.engine.session(t.sid).actionCount).toBe(0);
  }finally{await t.close();}
});

it('records a failed capture without retaining an active scan grant', async () => {
  const t=await setup('<div>Text</div>');try {
    (t.engine as any).capture=async()=>{throw new Error('fixture capture failure');};
    await expect(t.engine.supplementDiscovery(t.sid,input(t))).rejects.toThrow('fixture capture failure');
    expect(records(t)[0]).toMatchObject({status:'failed',error:'Error: fixture capture failure'});
    expect(t.engine.store.events(t.sid).some(e=>e.type==='discovery.scan_failed')).toBe(true);
  }finally{await t.close();}
});

it('rejects stale observations, arbitrary roots, empty evidence and invalid budgets before recording a plan', async () => {
  const t=await setup('<div>Text</div>'); try {
    const stale=input(t);await t.engine.observe(t.sid);
    await expect(t.engine.supplementDiscovery(t.sid,stale)).rejects.toMatchObject({code:'STALE_DISCOVERY_SCAN'});
    for(const patch of [{targetId:'not-observed'}, {evidence:[]}, {budget:{elements:5001}}, {budget:{offset:999}}, {budget:{templateDepth:21}}, {budget:{templateNodes:501}}, {budget:{collections:1001}}]) {
      await expect(t.engine.supplementDiscovery(t.sid,{...input(t),...patch})).rejects.toBeDefined();
    }
    expect(records(t)).toEqual([]);expect(t.engine.session(t.sid).actionCount).toBe(0);
  } finally { await t.close(); }
});

it('publishes queryable deduplicated requests and serves materials, commands and records through the SDK/HTTP', async () => {
  const t=await setup(padding+tail);const api=await createApi(t.engine);await api.listen({host:'127.0.0.1',port:0});
  const client=new InteractionClient(`http://127.0.0.1:${(api.server.address() as any).port}`);try {
    await t.engine.observe(t.sid);expect(t.engine.store.events(t.sid).filter(e=>e.type==='discovery.scan_requested')).toHaveLength(1);
    expect((await client.discoveryScanMaterial(t.sid)).discovery?.signal.omitted).toBeGreaterThan(0);
    const seen:string[]=[];t.engine.events.on('event',e=>{if(e.type==='discovery.scan_completed')seen.push(t.engine.discoveryScanMaterial(t.sid).observationId);});
    const r=await client.supplementDiscovery(t.sid,input(t,{offset:5000,elements:200}));await new Promise(r=>setTimeout(r,20));
    expect(seen).toEqual([r.resultObservationId]);expect((await client.discoveryScans(t.sid)).items[0].id).toBe(r.id);
    await expect(client.discoveryScanMaterial('missing')).rejects.toMatchObject({code:'NOT_FOUND'});
  } finally { await api.close();await t.close(); }
});

it('keeps SQLite records across restart and invalidates the old document plan', async () => {
  const directory=mkdtempSync(join(tmpdir(),'discovery-scan-'));const t=await setup('<div>Text</div>',{},new SqliteStore(directory));let next:BrowserEngine|undefined;try {
    const r=await t.engine.supplementDiscovery(t.sid,input(t));await t.engine.close();next=new BrowserEngine({persistence:new SqliteStore(directory)});
    expect(next.list<DiscoveryScanRecord>(t.sid,'discovery-scan')[0].id).toBe(r.id);
    await next.observe(t.sid);expect(next.list<DiscoveryScanRecord>(t.sid,'discovery-scan')[0].status).toBe('invalidated');
  } finally {await next?.close();await t.close();rmSync(directory,{recursive:true,force:true});}
});
