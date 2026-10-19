import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { AccountStore, encodeSealedJsonPreset, keyFrom, PresetAuth, type SiteProfile, Vault } from '@interaction/auth';
import {
  composeSessions,
  CrawlManager,
  CrawlStore,
  experimentSession,
  experimentSessionFactory,
  SampledCrawler,
  type CrawlEvent,
  type PreparedSession,
} from '@interaction/crawler';

// A site that buckets visitors: without a valid `exp_checkout` cookie it assigns A (Set-Cookie on
// every page, and again from a page script), unless `rebucket` is off. Variant B shows an extra
// panel. Requests are recorded so headers can be checked per host.
const site = { rebucket: true };
const requests: { host: string; path: string; cookie: string; variant?: string }[] = [];
let server: Server,
  origin = '',
  other = '';
const page = (variant: string, rebucket: boolean) => `<!doctype html><html lang="en"><title>Shop</title><main>
  <p id="variant">${variant}</p>
  <button onclick="document.getElementById('a').hidden=false">Open cart</button>
  <section id="a" hidden><button>Cart item</button></section>
  ${variant === 'B' ? `<button onclick="document.getElementById('b').hidden=false">Try new checkout</button><section id="b" hidden><button>New checkout step</button></section>` : ''}
  </main>
  ${rebucket ? `<script>document.cookie = 'exp_checkout=A; path=/'</script>` : ''}
  <img src="${'OTHER'}/pixel.gif">`;
beforeAll(async () => {
  server = createHttpServer((req, res) => {
    const cookie = req.headers.cookie ?? '';
    const host = req.headers.host ?? '';
    const url = new URL(req.url!, 'http://x');
    requests.push({ host, path: url.pathname, cookie, variant: req.headers['x-ab-variant'] as string | undefined });
    if (url.pathname === '/pixel.gif') return res.end();
    if (url.pathname === '/api/heartbeat') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(/sid=good/.test(cookie) ? { code: 0 } : { code: 401 }));
    }
    const variant = /exp_checkout=B/.test(cookie) || req.headers['x-ab-variant'] === 'B' ? 'B' : 'A';
    if (site.rebucket) res.setHeader('set-cookie', 'exp_checkout=A; Path=/');
    res.setHeader('content-type', 'text/html');
    res.end(page(variant, site.rebucket).replace('OTHER', other));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  origin = `http://127.0.0.1:${port}`;
  // Same server under another host name: a third party that must not get the experiment header.
  other = `http://localhost:${port}`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
beforeEach(() => {
  site.rebucket = true;
  requests.length = 0;
});

const labels = (events: CrawlEvent[]) =>
  events.filter(e => e.type === 'action').map(e => (e as Extract<CrawlEvent, { type: 'action' }>).step.label);

test('a pinned variant cookie survives re-bucketing by the server and page scripts', async () => {
  const events: CrawlEvent[] = [];
  const crawler = new SampledCrawler({
    url: `${origin}/shop`,
    durationMs: 60_000,
    session: experimentSession({
      name: 'checkout',
      variant: 'B',
      domains: ['127.0.0.1'],
      cookies: { exp_checkout: 'B' },
      recheckMs: 0,
    }),
    log: e => events.push(e),
  });
  const summary = await crawler.run();
  expect(summary.stopReason).toBe('scope_exhausted');
  expect(summary.sessions).toEqual([{ provider: 'experiment:checkout', verified: true, checks: expect.any(Number) }]);
  expect(labels(events)).toContain('New checkout step');
  const pages = requests.filter(r => r.path === '/shop');
  expect(pages.length).toBeGreaterThan(0);
  expect(pages.every(r => /exp_checkout=B/.test(r.cookie) && !/exp_checkout=A/.test(r.cookie))).toBe(true);
});

test('without pinning, re-bucketing is caught by the check and the crawl stops', async () => {
  const events: CrawlEvent[] = [];
  const summary = await new SampledCrawler({
    url: `${origin}/shop`,
    durationMs: 60_000,
    session: experimentSession({
      name: 'checkout',
      variant: 'B',
      domains: ['127.0.0.1'],
      cookies: { exp_checkout: 'B' },
      pin: false,
    }),
    log: e => events.push(e),
  }).run();
  expect(summary.stopReason).toBe('session_invalid');
  expect(events.find(e => e.type === 'session' && e.check)).toMatchObject({
    check: { ok: false, reason: 'variant_cookie_mismatch', facts: { exp_checkout: 'A' } },
  });
  expect(labels(events)).toHaveLength(0);
});

test('experiment headers go only to the experiment domains; localStorage is read back', async () => {
  site.rebucket = false;
  const events: CrawlEvent[] = [];
  const summary = await new SampledCrawler({
    url: `${origin}/shop`,
    durationMs: 60_000,
    session: experimentSession({
      name: 'checkout',
      variant: 'B',
      domains: ['127.0.0.1'],
      headers: { 'x-ab-variant': 'B' },
      localStorage: { ab_checkout: 'B' },
      check: async p => ({ ok: (await p.textContent('#variant')) === 'B', reason: 'variant_not_rendered' }),
    }),
    log: e => events.push(e),
  }).run();
  expect(summary.stopReason).toBe('scope_exhausted');
  expect(labels(events)).toContain('New checkout step');
  expect(requests.filter(r => r.host.startsWith('127.0.0.1')).every(r => r.variant === 'B')).toBe(true);
  const third = requests.filter(r => r.host.startsWith('localhost'));
  expect(third.length).toBeGreaterThan(0);
  expect(third.every(r => r.variant === undefined)).toBe(true);

  // Default check: the localStorage entry is read back from the page.
  const session = await experimentSession({
    name: 'x',
    variant: 'B',
    domains: ['127.0.0.1'],
    localStorage: { ab_checkout: 'B' },
  }).prepare({ url: origin, viewport: { width: 1, height: 1, mobile: false, source: 'custom' } });
  expect(session.initScripts).toHaveLength(1);
  expect(session.writes).toEqual({ cookies: [], localStorage: ['ab_checkout'] });
});

test('sessions that set the same cookie or header cannot be combined', () => {
  const base = (over: Partial<PreparedSession>): PreparedSession => ({
    describe: {},
    context: {},
    release: async () => {},
    ...over,
  });
  const cookie = {
    name: 'exp',
    value: 'B',
    domain: 'a.com',
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: 'Lax' as const,
  };
  // A restored cookie (the site's own bucket in a login snapshot) gives way to one set on purpose.
  const overridden = composeSessions([
    {
      id: 'login',
      session: base({
        context: {
          storageState: {
            cookies: [cookie, { ...cookie, name: 'sid' }],
            origins: [
              {
                origin: 'https://a.com',
                localStorage: [
                  { name: 'ab', value: 'A' },
                  { name: 'token', value: 't' },
                ],
              },
            ],
          },
        },
      }),
    },
    { id: 'exp', session: base({ pinnedCookies: [{ ...cookie, value: 'B' }], writes: { localStorage: ['ab'] } }) },
  ]);
  const state = overridden.context.storageState as {
    cookies: { name: string; value: string }[];
    origins: { localStorage: { name: string }[] }[];
  };
  expect(state.cookies.map(c => `${c.name}=${c.value}`)).toEqual(['sid=B', 'exp=B']);
  expect(state.origins[0]!.localStorage.map(e => e.name)).toEqual(['token']);
  // Two sessions asserting the same cookie cannot both hold.
  expect(() =>
    composeSessions([
      { id: 'a', session: base({ pinnedCookies: [cookie] }) },
      { id: 'b', session: base({ writes: { cookies: ['exp'] } }) },
    ]),
  ).toThrow(/a and b both set cookie exp/);
  expect(() =>
    composeSessions([
      { id: 'a', session: base({ headers: [{ domains: ['a.com'], headers: { 'X-AB': '1' } }] }) },
      { id: 'b', session: base({ context: { extraHTTPHeaders: { 'x-ab': '2' } } }) },
    ]),
  ).toThrow(/both set header x-ab/);
  expect(() =>
    composeSessions([
      { id: 'a', session: base({ context: { locale: 'en-US' } }) },
      { id: 'b', session: base({ context: { locale: 'zh-CN' } }) },
    ]),
  ).toThrow(/both set context\.locale/);
  const merged = composeSessions([
    { id: 'a', session: base({ context: { locale: 'en-US', storageState: { cookies: [cookie], origins: [] } } }) },
    { id: 'b', session: base({ context: { locale: 'en-US' }, pinnedCookies: [{ ...cookie, name: 'exp2' }] }) },
  ]);
  expect(merged.context.locale).toBe('en-US');
  expect((merged.context.storageState as { cookies: { name: string }[] }).cookies.map(c => c.name)).toEqual([
    'exp',
    'exp2',
  ]);
});

test('a login and an experiment combine, and the variant stays out of the saved login snapshot', async () => {
  site.rebucket = true;
  const presetKey = 'exporter-key-0123456789',
    vaultKey = 'project-key-0123456789';
  const store = new AccountStore(join(mkdtempSync(join(tmpdir(), 'auth-')), 'accounts.sqlite'));
  const profile: SiteProfile = {
    site: 'global',
    domains: ['127.0.0.1'],
    tradeUrl: `${origin}/shop`,
    heartbeat: { url: '/api/heartbeat' },
  };
  const auth = new PresetAuth({ store, vaultKey, presetKey, sites: [profile] });
  const snapshot = {
    cookies: [
      {
        name: 'sid',
        value: 'good',
        domain: '127.0.0.1',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax' as const,
      },
    ],
    origins: [],
    device: { userAgent: 'Mozilla/5.0 TestBrowser', locale: 'en-US', isMobile: false, hasTouch: false },
  };
  const { account } = await auth.import({
    name: 'global-eid14',
    data: encodeSealedJsonPreset(snapshot, keyFrom(presetKey)),
  });
  expect(account.status).toBe('active');

  const crawls = new CrawlManager(
    new CrawlStore(join(mkdtempSync(join(tmpdir(), 'crawls-')), 'c.sqlite')),
    {},
    {},
    {
      login: options => auth.provider(options),
      experiment: experimentSessionFactory,
    },
  );
  const waitDone = async (id: string) => {
    for (let i = 0; i < 300; i++) {
      const run = crawls.store.run(id)!;
      if (run.status !== 'running') return run;
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('timeout');
  };
  const experiment = {
    provider: 'experiment',
    options: { name: 'checkout', variant: 'B', domains: ['127.0.0.1'], cookies: { exp_checkout: 'B' } },
  };
  try {
    // Verification's anonymous probe has no session; only the crawl's own requests count.
    requests.length = 0;
    const run = crawls.start({ url: `${origin}/shop`, models: false, session: [{ provider: 'login' }, experiment] });
    const done = await waitDone(run.id);
    expect(done.error).toBeUndefined();
    expect(done.summary).toMatchObject({
      stopReason: 'scope_exhausted',
      sessions: [
        { provider: 'preset-auth', verified: true },
        { provider: 'experiment:checkout', verified: true },
      ],
    });
    expect(done.options).toMatchObject({ sessionKeys: ['experiment:checkout=B'] });
    const events = crawls.store.events(run.id, 0, 1000) as CrawlEvent[];
    expect(labels(events)).toContain('New checkout step');
    expect(requests.filter(r => r.path === '/shop').every(r => /sid=good/.test(r.cookie))).toBe(true);
    // The login refreshed its snapshot after the crawl, without the experiment's cookie.
    const saved = new Vault(vaultKey).open(store.snapshot(account.id)!);
    expect(saved.cookies.map(c => c.name)).toEqual(['sid']);

    // Resuming keeps the variant; another variant is refused.
    const resumed = crawls.start({ url: `${origin}/shop`, models: false, resumeFrom: run.id });
    expect(resumed.options).toMatchObject({ sessionKeys: ['experiment:checkout=B'] });
    await waitDone(resumed.id);
    expect(() =>
      crawls.start({
        url: `${origin}/shop`,
        models: false,
        resumeFrom: run.id,
        session: [{ provider: 'login' }, { ...experiment, options: { ...experiment.options, variant: 'A' } }],
      }),
    ).toThrow(/experiment variants/);
    expect(() =>
      crawls.start({
        url: `${origin}/shop`,
        session: { provider: 'experiment', options: { name: 'x', variant: 'B', domains: [], cookies: {} } },
      }),
    ).toThrow();
  } finally {
    await crawls.close();
  }
});
