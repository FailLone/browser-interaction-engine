import { BrowserEngine, type Observation, type ActionAttempt } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { mkdirSync, writeFileSync } from 'node:fs';
const [url, out] = process.argv.slice(2);
if (!url || !out) throw new Error('Usage: live-page-check.ts URL output-directory');
mkdirSync(out, { recursive: true });
const engine = new BrowserEngine({ persistence: new MemoryStore() });
try {
  const s = await engine.createSession({ url, headless: true, maxActions: 12, maxDurationMs: 45000 });
  for (let i = 0; i < 8; i++) { await new Promise(r => setTimeout(r, 150)); await engine.observe(s.id); }
  const samples = engine.list<Observation>(s.id, 'observation');
  const initial = samples[0];
  const drift = initial.controls.filter(c => c.actions.length).map(c => {
    const versions = samples.map(o => o.controls.find(n => n.instanceId === c.instanceId)).filter(Boolean);
    return { name: c.name, observed: versions.length, identities: new Set(versions.map(c => c!.identityId)).size,
      texts: new Set(versions.map(c => c!.displayedText)).size, keys: new Set(versions.map(c => c!.stableKey)).size };
  });
  await engine.explore(s.id); await engine.waitForIdle();
  const observations = engine.list<Observation>(s.id, 'observation');
  const attempts = engine.list<ActionAttempt>(s.id, 'attempt');
  const summary = { session: engine.session(s.id), drift, attempts: attempts.map(a => ({ status: a.status, label: a.action.label, kind: a.action.kind })),
    observations: observations.map(o => ({ id: o.id, stable: o.stable, controls: o.controls.length, liveReadouts: o.controls.filter(c => c.liveContent).length, gaps: o.gaps.filter(g => g.critical) })),
    coverage: engine.controlCoverage(s.id).counts };
  writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 2));
  writeFileSync(`${out}/observations.json`, JSON.stringify(observations));
  console.log(JSON.stringify({ stop: summary.session.stopReason, actions: summary.session.actionCount, observations: observations.length, drifting: drift.filter(d => d.identities > 1), gaps: summary.observations.flatMap(o => o.gaps) }));
} finally { await engine.close(); }
