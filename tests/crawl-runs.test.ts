import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { CrawlManager, CrawlStore } from '@interaction/crawler';
import { createServer } from '../apps/server/src/server.js';

const page = `<!doctype html><title>Run</title><main>
  <button onclick="document.getElementById('p').hidden=false">Open panel</button>
  <section id="p" hidden><button>Panel action</button></section>
  <ul>${Array.from({ length: 10 }, (_, i) => `<li><button>Row ${i}</button></li>`).join('')}</ul></main>`;
let site: Server,
  url = '';
beforeAll(async () => {
  site = createHttpServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(page);
  });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
});
afterAll(() => new Promise<void>(resolve => site.close(() => resolve())));

const waitFor = async <T>(read: () => Promise<T>, done: (value: T) => boolean) => {
  for (let i = 0; i < 300; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('timeout');
};

test('crawl runs are started, stored and inspected over HTTP, and a resumed run does not repeat tested work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crawls-'));
  const crawls = new CrawlManager(new CrawlStore(join(dir, 'crawls.sqlite')));
  const app = await createServer(crawls);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const api = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const json = async (path: string, init?: RequestInit) =>
    (await fetch(`${api}${path}`, { ...init, headers: { 'content-type': 'application/json' } })).json();
  try {
    const first = await json('/v1/crawls', {
      method: 'POST',
      body: JSON.stringify({ url, durationMs: 60000, models: false }),
    });
    expect(first.status).toBe('running');
    const done = await waitFor(
      () => json(`/v1/crawls/${first.id}`),
      run => run.status !== 'running',
    );
    expect(done.status).toBe('finished');
    // Everything on the page was tested well before the limit: the run says why it ended early.
    expect(done.summary.stopReason).toBe('scope_exhausted');
    expect(done.summary.actions).toBeGreaterThan(0);
    expect((await json('/v1/crawls')).map((r: { id: string }) => r.id)).toContain(first.id);

    const events = await json(`/v1/crawls/${first.id}/events`);
    const labels = events
      .filter((e: { type: string }) => e.type === 'action')
      .map((e: { step: { label: string } }) => e.step.label);
    expect(labels).toEqual(expect.arrayContaining(['Open panel', 'Panel action']));
    const state = events.find((e: { type: string }) => e.type === 'state').state.key;
    const shot = await fetch(`${api}/v1/crawls/${first.id}/screenshot?state=${encodeURIComponent(state)}`);
    // Screenshots are WebP; the route says so.
    expect(shot.headers.get('content-type')).toBe('image/webp');
    expect((await shot.arrayBuffer()).byteLength).toBeGreaterThan(100);

    // Resuming: everything was already sampled, so no action repeats and known states are not new.
    const second = await json('/v1/crawls', {
      method: 'POST',
      body: JSON.stringify({ url, durationMs: 60000, models: false, resumeFrom: first.id }),
    });
    const resumed = await waitFor(
      () => json(`/v1/crawls/${second.id}`),
      run => run.status !== 'running',
    );
    expect(resumed.summary.actions).toBe(0);
    expect(resumed.summary.states).toBe(0);
    expect(resumed.summary.resumedStates).toBe(done.summary.states);

    // Stopping a running crawl.
    const third = await json('/v1/crawls', {
      method: 'POST',
      body: JSON.stringify({ url, durationMs: 60000, models: false }),
    });
    const stopped = await json(`/v1/crawls/${third.id}/stop`, { method: 'POST', body: '{}' });
    expect(stopped.run.status).toBe('finished');
    expect((await json(`/v1/crawls/${third.id}/events`)).at(-1)).toMatchObject({ type: 'stop', reason: 'stopped' });
  } finally {
    await app.close();
    await crawls.close();
  }
}, 180000);

test('a run loads only the host plugins it names and records their findings and checks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crawls-'));
  const crawls = new CrawlManager(
    new CrawlStore(join(dir, 'crawls.sqlite')),
    {},
    {
      titles: () => ({
        id: 'titles',
        checks: () => [{ id: 'title', name: 'Title length' }],
        onState: ({ snapshot }) => ({
          findings: [
            { rule: 'title', severity: 'warning', selector: 'title', text: snapshot.title, detail: 'Short title' },
          ],
          checks: [
            { id: 'title', verdict: 'fail', targets: 1, ms: 0, codes: [{ code: 'SHORT', verdict: 'fail', count: 1 }] },
          ],
        }),
      }),
    },
  );
  const app = await createServer(crawls);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const api = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const post = (body: unknown) =>
    fetch(`${api}/v1/crawls`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  try {
    expect(await (await fetch(`${api}/v1/crawl-plugins`)).json()).toEqual(['titles']);
    expect((await post({ url, durationMs: 10000, models: false, plugins: ['missing'] })).status).toBe(409);
    const run = await (await post({ url, durationMs: 10000, models: false, plugins: ['titles'] })).json();
    await waitFor(
      async () => (await fetch(`${api}/v1/crawls/${run.id}`)).json(),
      r => r.status !== 'running',
    );
    const events: { type: string }[] = await (await fetch(`${api}/v1/crawls/${run.id}/events`)).json();
    const findings = events.filter(e => e.type === 'finding');
    // The same finding on every state is reported once.
    expect(findings).toEqual([
      expect.objectContaining({ plugin: 'titles', finding: expect.objectContaining({ rule: 'title', text: 'Run' }) }),
    ]);
    // The checks are named once; every new state gets one inspection, and later ones point back at the finding.
    expect(events.filter(e => e.type === 'checks')).toEqual([
      expect.objectContaining({ plugin: 'titles', checks: [{ id: 'title', name: 'Title length' }] }),
    ]);
    // Each follows its state's announcement, so it carries no state key.
    const inspections = events.filter(e => e.type === 'inspection');
    expect(inspections.length).toBe(events.filter(e => e.type === 'state').length);
    events.forEach(
      (e, i) =>
        e.type === 'inspection' && expect(events.slice(0, i).findLast(p => p.type !== 'finding')?.type).toBe('state'),
    );
    expect(inspections[0]).toMatchObject({
      plugin: 'titles',
      checks: [{ id: 'title', verdict: 'fail', targets: 1, codes: [{ code: 'SHORT', verdict: 'fail', count: 1 }] }],
    });
    expect(inspections[0]).not.toHaveProperty('repeated');
    if (inspections.length > 1) expect(inspections[1]).toMatchObject({ repeated: [{ finding: 0 }] });
  } finally {
    await app.close();
    await crawls.close();
  }
}, 60000);

test('a run crawls on the viewport it asks for, and a resumed run keeps it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crawls-'));
  const crawls = new CrawlManager(new CrawlStore(join(dir, 'crawls.sqlite')));
  const app = await createServer(crawls);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const api = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const post = (body: unknown) =>
    fetch(`${api}/v1/crawls`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  const finished = (id: string) =>
    waitFor(
      async () => (await fetch(`${api}/v1/crawls/${id}`)).json(),
      r => r.status !== 'running',
    );
  try {
    expect((await post({ url, models: false, viewport: 'tablet' })).status).toBe(400);
    expect((await post({ url, models: false, viewport: { width: 100, height: 800 } })).status).toBe(400);
    const mobile = await (await post({ url, durationMs: 10000, models: false, viewport: 'mobile' })).json();
    expect(mobile.options.viewport).toBe('mobile');
    const done = await finished(mobile.id);
    expect(done.summary.viewport).toMatchObject({ preset: 'mobile', width: 393, mobile: true });
    const events = await (await fetch(`${api}/v1/crawls/${mobile.id}/events`)).json();
    expect(events[0]).toMatchObject({ type: 'viewport', viewport: { preset: 'mobile' } });

    expect((await post({ url, models: false, resumeFrom: mobile.id, viewport: 'desktop' })).status).toBe(409);
    const resumed = await (await post({ url, durationMs: 10000, models: false, resumeFrom: mobile.id })).json();
    expect((await finished(resumed.id)).summary.viewport).toMatchObject({ preset: 'mobile' });

    // No breakpoints on this page: desktop-edge falls back to 1024x768 and says so.
    const edge = await (await post({ url, durationMs: 10000, models: false, viewport: 'desktop-edge' })).json();
    expect((await finished(edge.id)).summary.viewport).toMatchObject({ width: 1024, source: 'fallback' });
  } finally {
    await app.close();
    await crawls.close();
  }
}, 90000);

test('a run started with a goal plans it on the open page, pursues its question and keeps it on resume', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crawls-'));
  const asked: string[] = [];
  // Fake models: the plan asks whether the panel offers an action; the answer is behind "Open panel".
  const llm = {
    name: 'llm',
    model: 'llm',
    async decide(request: { purpose: string; state: unknown }) {
      asked.push(request.purpose);
      if (request.purpose === 'crawler-goal-plan')
        return {
          model: 'llm',
          value: {
            stayOnPage: true,
            allowedPaths: [],
            areas: [],
            focus: ['panel'],
            tasks: ['open the panel'],
            question: 'Does the panel offer an action?',
          },
        };
      const state = request.state as { newText: string; actions: string[] };
      if (state.newText.includes('Panel action'))
        return { model: 'llm', value: { answered: true, found: true, answer: '"Panel action"', next: -1, reason: '' } };
      const next = state.actions.findIndex(a => a.includes('Open panel'));
      return { model: 'llm', value: { answered: false, found: false, answer: '', next, reason: 'open it' } };
    },
  };
  const jev = {
    name: 'jev',
    model: 'jev',
    async decide(request: { checks?: Record<string, unknown> }) {
      return { model: 'jev', value: Object.fromEntries(Object.keys(request.checks ?? {}).map(k => [k, 0.9])) };
    },
  };
  const crawls = new CrawlManager(new CrawlStore(join(dir, 'crawls.sqlite')), { llm, jev });
  const app = await createServer(crawls);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const api = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const post = (body: unknown) =>
    fetch(`${api}/v1/crawls`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  try {
    // A goal without models is refused up front rather than crawling without one.
    expect((await post({ url, durationMs: 10000, models: false, goal: 'find the panel action' })).status).toBe(409);
    const run = await (await post({ url, durationMs: 60000, goal: 'find the panel action' })).json();
    expect(run.options.goal).toBe('find the panel action');
    const done = await waitFor(
      async () => (await fetch(`${api}/v1/crawls/${run.id}`)).json(),
      r => r.status !== 'running',
    );
    expect(done.summary.stopReason).toBe('goal_answered');
    expect(done.summary.pursuit).toMatchObject({ answered: true, settled: true, steeredActions: 1 });
    expect(done.summary.goal.plan.question).toBe('Does the panel offer an action?');
    // Planning and pursuit are counted with the run's LLM spend.
    expect(done.summary.models.llm.calls).toBe(asked.length);
    const events = await (await fetch(`${api}/v1/crawls/${run.id}/debug/events`)).json();
    expect(events.find((e: { type: string }) => e.type === 'goal').plan.question).toBe(
      'Does the panel offer an action?',
    );
    const answer = events.findLast((e: { type: string }) => e.type === 'pursuit');
    // The debug page gets a short state id it can load the answer's screenshot with.
    expect(answer).toMatchObject({ answered: true, state: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect((await fetch(`${api}/v1/crawls/${run.id}/debug/screenshot/${answer.state}`)).status).toBe(200);

    const resumed = await (await post({ url, durationMs: 10000, resumeFrom: run.id })).json();
    expect(resumed.options.goal).toBe('find the panel action');
    await waitFor(
      async () => (await fetch(`${api}/v1/crawls/${resumed.id}`)).json(),
      r => r.status !== 'running',
    );
  } finally {
    await app.close();
    await crawls.close();
  }
}, 120000);
