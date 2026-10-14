import { expect, it } from 'vitest';
import { BrowserEngine, type ActionCandidate } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { createServer } from 'node:http';

it('counts a reviewed custom operation without inventing DOM capabilities or promoting tentative probes', async () => {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<div id="currency" style="cursor:pointer">Currency</div><script>document.addEventListener('click',e=>{if(e.target.id==='currency')e.target.dataset.used='yes'})</script>`); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let supported = false;
  const engine = new BrowserEngine({ persistence: new MemoryStore(), hooks: {
    actions: (actions, { session, observation: o }) => {
      const c = o.controls.find(c => c.stableKey === 'id:currency')!;
      const reviewed: ActionCandidate = { id: '', sessionId: session.id, observationId: o.id, stateId: o.stateId, controlId: c.identityId, localId: c.localId,
        label: c.name, kind: 'click', risk: 'interface', replayable: false, excluded: false, sampleValidity: 'known', source: 'reviewer',
        preconditions: { context: o.context, visible: true, enabled: true, identityResolved: true },
        basis: { status: supported ? 'supported' : 'tentative', evidence: [{ source: 'reviewer', rule: 'review/v1', facts: { decision: supported ? 'Confirmed currency opener' : 'Unconfirmed pointer hint' } }] } };
      return [...actions, reviewed];
    },
  } });
  try {
    const s = await engine.createSession({ url: `http://127.0.0.1:${(server.address() as {port:number}).port}`, headless: true });
    const before = engine.observation(s.id);
    expect(before.controls[0].actions).toEqual([]);
    expect(engine.controlCoverage(s.id).counts).toMatchObject({ actionable: 0, unconfirmed: 1 });
    supported = true; await engine.observe(s.id);
    expect(engine.controlCoverage(s.id).counts).toMatchObject({ actionable: 1, covered: 0, incomplete: 1 });
    const a = engine.actions(s.id).find(a => a.source === 'reviewer')!;
    await engine.execute(s.id, a.id, 'reviewed');
    expect(engine.controlCoverage(s.id).counts).toMatchObject({ actionable: 1, covered: 1, incomplete: 0 });
    expect(engine.observation(s.id, before.id).controls[0].actions).toEqual([]);
    expect(engine.observation(s.id).controls[0].actions).toEqual([]);
  } finally { await engine.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
