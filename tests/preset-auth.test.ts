import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import {
  AccountStore,
  encodeSealedJsonPreset,
  keyFrom,
  parsePresetName,
  PresetAuth,
  presetSessionFactory,
  type SessionSnapshot,
  type SiteProfile,
  Vault,
} from '@interaction/auth';
import { CrawlManager, CrawlStore, SampledCrawler, type CrawlEvent } from '@interaction/crawler';

// A site that only works logged in: the trade page redirects to /login without the session
// cookie, and the heartbeat wants the cookie plus a token the app keeps in localStorage.
const site = { anonymousAccepted: false, revokeAfter: Infinity, heartbeats: 0 };
let server: Server,
  origin = '';
const trade = `<!doctype html><html lang="en"><title>Trade</title><main>
  <button onclick="document.getElementById('p').hidden=false">Open orders</button>
  <section id="p" hidden><button>Order details</button></section></main>
  <script>document.cookie = 'seen=1; path=/'</script>`;
beforeAll(async () => {
  server = createHttpServer((req, res) => {
    const cookies = req.headers.cookie ?? '';
    const loggedIn = /(^|; )sid=good(;|$)/.test(cookies);
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/api/heartbeat') {
      res.setHeader('content-type', 'application/json');
      const ok =
        (loggedIn && req.headers['x-token'] === 't1' && ++site.heartbeats <= site.revokeAfter) ||
        site.anonymousAccepted;
      return res.end(JSON.stringify(ok ? { code: 0, data: {} } : { code: 10002, msg: 'not logged in' }));
    }
    if (url.pathname === '/trade' && !loggedIn) {
      res.writeHead(302, { location: '/login' });
      return res.end();
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      url.pathname === '/trade'
        ? trade
        : '<!doctype html><html lang="en"><title>Login</title><form><input name="u"></form>',
    );
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
beforeEach(() => Object.assign(site, { anonymousAccepted: false, revokeAfter: Infinity, heartbeats: 0 }));

const presetKey = 'exporter-key-0123456789',
  vaultKey = 'project-key-0123456789';
const snapshot = (): SessionSnapshot => ({
  cookies: [
    {
      name: 'sid',
      value: 'good',
      domain: '127.0.0.1',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ],
  origins: [{ origin, localStorage: [{ name: 'token', value: 't1' }] }],
  device: { userAgent: 'Mozilla/5.0 TestBrowser', locale: 'en-US', isMobile: false, hasTouch: false },
});
const profile = (): SiteProfile => ({
  site: 'global',
  entities: ['eid14', 'eid15'],
  domains: ['127.0.0.1'],
  environment: 'test',
  tradeUrl: `${origin}/trade`,
  heartbeat: {
    url: '/api/heartbeat',
    headers: async page => ({ 'x-token': (await page.evaluate(() => localStorage.getItem('token'))) ?? '' }),
  },
  loginRoute: /\/login/,
});
const setup = () => {
  const store = new AccountStore(join(mkdtempSync(join(tmpdir(), 'auth-')), 'accounts.sqlite'));
  const auth = new PresetAuth({ store, vaultKey, presetKey, sites: [profile()] });
  return { store, auth, preset: encodeSealedJsonPreset(snapshot(), keyFrom(presetKey)) };
};

test('preset names map to site, market and entity, and must match the registry', () => {
  expect(parsePresetName('/x/global-eid14.enc')).toEqual({
    preset: 'global-eid14',
    site: 'global',
    market: 'global',
    entity: 'eid14',
  });
  expect(parsePresetName('global-hk-eid3')).toMatchObject({ market: 'hk', entity: 'eid3' });
  expect(() => parsePresetName('global')).toThrow(/site\[-market\]-entity/);
  const { auth } = setup();
  expect(() => auth.identify('asia-eid14')).toThrow(/unknown site/);
  expect(() => auth.identify('global-eid99')).toThrow(/no entity/);
  expect(() => auth.identify('global-hk-eid14')).toThrow(/no market/);
});

test('an import is activated only when the logged-in heartbeat passes and the anonymous one is refused', async () => {
  const { auth, store, preset } = setup();
  const { account, verification } = await auth.import({
    name: 'global-eid14.enc',
    data: preset,
    permissions: ['trade'],
  });
  expect(verification).toMatchObject({
    ok: true,
    loggedIn: { outcome: 'accepted', code: 0 },
    anonymous: { outcome: 'rejected' },
  });
  expect(account).toMatchObject({
    status: 'active',
    site: 'global',
    entity: 'eid14',
    environment: 'test',
    locale: 'en-US',
  });
  // Stored under this project's key, refreshed with what the site set during verification.
  const stored = new Vault(vaultKey).open(store.snapshot(account.id)!);
  expect(stored.cookies.map(c => c.name).sort()).toEqual(['seen', 'sid']);
  expect(() => new Vault(presetKey).open(store.snapshot(account.id)!)).toThrow();

  // An anonymous context that is also accepted proves nothing: the account is not enabled.
  site.anonymousAccepted = true;
  const again = await auth.verify(account.id);
  expect(again).toMatchObject({ ok: false, reason: 'anonymous_accepted' });
  expect(store.account(account.id)!.status).toBe('invalid');
  expect(store.verifications(account.id)).toHaveLength(2);
});

test('unreadable presets are not stored and refused sessions are not enabled', async () => {
  const { auth, store, preset } = setup();
  await expect(
    auth.import({ name: 'global-eid14', data: encodeSealedJsonPreset(snapshot(), keyFrom('another-key-0123456789')) }),
  ).rejects.toThrow(/could not be read/);
  await expect(
    auth.import({
      name: 'global-eid14',
      data: encodeSealedJsonPreset({ ...snapshot(), device: {} } as never, keyFrom(presetKey)),
    }),
  ).rejects.toThrow(/could not be read/);
  expect(store.accounts()).toHaveLength(0);
  expect(preset.length).toBeGreaterThan(0);

  const expired = { ...snapshot(), cookies: [{ ...snapshot().cookies[0]!, value: 'revoked' }] };
  const { verification } = await auth.import({
    name: 'global-eid15',
    data: encodeSealedJsonPreset(expired, keyFrom(presetKey)),
  });
  expect(verification).toMatchObject({ ok: false, loggedIn: { outcome: 'rejected' }, reason: 'login_route' });
  expect(store.byPreset('global-eid15')!.status).toBe('invalid');
});

test('accounts are chosen by scope and locked per task', async () => {
  const { auth, store, preset } = setup();
  const { account } = await auth.import({ name: 'global-eid14', data: preset, permissions: ['trade'] });
  expect(store.find({ entity: 'eid14', permissions: ['trade'], host: '127.0.0.1', locale: 'en' })).toHaveLength(1);
  expect(store.find({ permissions: ['withdraw'] })).toHaveLength(0);
  expect(store.find({ host: 'example.com' })).toHaveLength(0);
  expect(store.find({ mobile: true })).toHaveLength(0);
  expect(store.find({ locale: 'zh' })).toHaveLength(0);

  const target = {
    url: `${origin}/trade`,
    viewport: { width: 1280, height: 800, mobile: false, source: 'preset' as const },
  };
  const a = auth.provider({ task: 'a' }),
    b = auth.provider({ task: 'b' });
  // One task may open several pages with the account; another task waits for all of them.
  const first = await a.prepare(target),
    second = await a.prepare(target);
  await expect(b.prepare(target)).rejects.toThrow(/in use/);
  await first.release({ verified: false });
  await expect(b.prepare(target)).rejects.toThrow(/in use/);
  await second.release({ verified: false });
  const third = await b.prepare(target);
  expect(third.describe).toMatchObject({ account: account.id, preset: 'global-eid14' });
  expect(third.context).toMatchObject({ userAgent: 'Mozilla/5.0 TestBrowser', locale: 'en-US', hasTouch: false });
  await third.release({ verified: false });
  expect(store.lockOwner(account.id)).toBeUndefined();
});

const waitFor = async <T>(read: () => T, done: (value: T) => boolean) => {
  for (let i = 0; i < 300; i++) {
    const value = read();
    if (done(value)) return value;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('timeout');
};

test('a crawl runs in the restored session, re-checks it, and is stopped when it is refused', async () => {
  const { auth, store, preset } = setup();
  const { account } = await auth.import({ name: 'global-eid14', data: preset });

  const crawls = new CrawlManager(
    new CrawlStore(join(mkdtempSync(join(tmpdir(), 'crawls-')), 'c.sqlite')),
    {},
    {},
    {
      preset: presetSessionFactory(auth),
    },
  );
  try {
    const run = crawls.start({
      url: `${origin}/trade`,
      durationMs: 60_000,
      models: false,
      session: { provider: 'preset', options: { select: { entity: 'eid14' } } },
    });
    const done = await waitFor(
      () => crawls.store.run(run.id)!,
      r => r.status !== 'running',
    );
    expect(done.status).toBe('finished');
    expect(done.summary).toMatchObject({
      stopReason: 'scope_exhausted',
      sessions: [{ provider: 'preset-auth', verified: true }],
    });
    const events = crawls.store.events(run.id, 0, 1000) as CrawlEvent[];
    const states = events.filter(e => e.type === 'state') as Extract<CrawlEvent, { type: 'state' }>[];
    expect(states.every(e => e.state.url.endsWith('/trade'))).toBe(true);
    const labels = events
      .filter(e => e.type === 'action')
      .map(e => (e as Extract<CrawlEvent, { type: 'action' }>).step.label);
    expect(labels).toContain('Order details');
    expect(events.find(e => e.type === 'session' && e.check)).toMatchObject({ check: { ok: true } });
    expect(store.lockOwner(account.id)).toBeUndefined();
    expect(() => crawls.start({ url: `${origin}/trade`, session: { provider: 'nope' } })).toThrow(
      /Unknown session provider/,
    );
  } finally {
    await crawls.close();
  }

  // The site revokes the session mid-crawl: the next check stops the crawl and the account leaves rotation.
  site.revokeAfter = site.heartbeats + 2;
  const events: CrawlEvent[] = [];
  const crawler = new SampledCrawler({
    url: `${origin}/trade`,
    durationMs: 60_000,
    session: auth.provider({ recheckMs: 0 }),
    log: e => events.push(e),
  });
  const summary = await crawler.run();
  expect(summary.stopReason).toBe('session_invalid');
  expect(events.filter(e => e.type === 'session' && e.check).at(-1)).toMatchObject({
    check: { ok: false, reason: 'heartbeat_rejected' },
  });
  expect(store.account(account.id)!.status).toBe('invalid');
  expect(store.lockOwner(account.id)).toBeUndefined();
  // With no verified account left, a crawl fails before a browser starts.
  await expect(new SampledCrawler({ url: `${origin}/trade`, session: auth.provider() }).run()).rejects.toThrow(
    /No verified account/,
  );
});
