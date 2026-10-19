import type { BrowserContext, BrowserContextOptions, Page } from 'playwright';
import type { ResolvedViewport } from './browser/viewport.js';

/** The page a session is asked for. `viewport.mobile` is known up front; desktop-edge narrows later. */
export interface SessionTarget {
  url: string;
  viewport: ResolvedViewport;
}

/** Result of checking that the open page really runs in the session (logged in, right site, right language). */
export interface SessionCheck {
  ok: boolean;
  /** Short machine-readable reason when not ok, e.g. 'heartbeat_rejected', 'login_route'. */
  reason?: string;
  /** Non-secret facts shown in the run's events. */
  facts?: Record<string, unknown>;
}

/** Context options a session may set; the crawl's viewport size always wins. */
export type SessionContextOptions = Pick<
  BrowserContextOptions,
  | 'storageState'
  | 'userAgent'
  | 'locale'
  | 'timezoneId'
  | 'hasTouch'
  | 'isMobile'
  | 'deviceScaleFactor'
  | 'extraHTTPHeaders'
  | 'geolocation'
  | 'permissions'
  | 'colorScheme'
>;

export type SessionStorageState = Exclude<NonNullable<BrowserContextOptions['storageState']>, string>;
export type SessionCookie = SessionStorageState['cookies'][number];

/** Request headers sent only to some hosts; `.example.com` covers subdomains. */
export interface ScopedHeaders {
  domains: string[];
  headers: Record<string, string>;
}

/** Cookie and localStorage names a session put into the browser. */
export interface SessionKeys {
  cookies: string[];
  localStorage: string[];
}

/** A session ready to be restored into one crawl's fresh browser context. */
export interface PreparedSession {
  /** Shown in events and the run summary (account, preset, …); never secrets. */
  describe: Record<string, unknown>;
  context: SessionContextOptions;
  /** Sent only to matching hosts; prefer these over `context.extraHTTPHeaders`, which go everywhere. */
  headers?: ScopedHeaders[];
  /**
   * Cookies held at their value for the whole crawl: page scripts cannot change them and a
   * response that sets them is undone. Also restored at start, so they need not be in `storageState`.
   */
  pinnedCookies?: SessionCookie[];
  /** Scripts run before any page script, e.g. to restore state Playwright cannot. */
  initScripts?: string[];
  /** Names an init script writes, so other sessions can leave them out of what they save. */
  writes?: Partial<SessionKeys>;
  /** Run once the entry page has loaded, and every `recheckMs` after; a failed check stops the crawl. */
  check?(page: Page): Promise<SessionCheck>;
  recheckMs?: number;
  /**
   * Always called once, before the browser closes, also when the crawl failed. `context` is the
   * crawl's context (for saving refreshed storage); `verified` is whether every check of this
   * session passed; `foreign` names what other sessions of the same crawl put into the browser,
   * which a session saving the context's storage must leave out.
   */
  release(outcome: { context?: BrowserContext; verified: boolean; foreign?: SessionKeys }): Promise<void>;
}

/**
 * Supplies browser state for a crawl: a logged-in account, an A/B variant, a feature flag. The
 * crawler only restores what it is given and runs the checks; where the state comes from and
 * what "valid" means belong to the provider (see `@interaction/auth`, `experimentSession`).
 * A crawl may combine several providers; they must not set the same thing.
 */
export interface SessionProvider {
  id: string;
  /**
   * Set when the state changes what pages show (an experiment variant): a resumed run must use
   * providers with the same keys, so tested work from another layout is not taken as done.
   */
  resumeKey?: string;
  /** Throw when no session fits the target; the crawl then fails before a browser starts. */
  prepare(target: SessionTarget): Promise<PreparedSession>;
}

export const hostMatches = (host: string, domains: string[]) =>
  domains.some(d => (d.startsWith('.') ? host === d.slice(1) || host.endsWith(d) : host === d));

/** What a session puts into the browser, by name. */
export function sessionKeys(session: PreparedSession): SessionKeys {
  const state = session.context.storageState as SessionStorageState | undefined;
  return {
    cookies: [
      ...new Set([
        ...(state?.cookies ?? []).map(c => c.name),
        ...(session.pinnedCookies ?? []).map(c => c.name),
        ...(session.writes?.cookies ?? []),
      ]),
    ],
    localStorage: [
      ...new Set([
        ...(state?.origins ?? []).flatMap(o => o.localStorage.map(e => e.name)),
        ...(session.writes?.localStorage ?? []),
      ]),
    ],
  };
}

/** Storage state without the named cookies and localStorage entries (and origins left empty). */
export function withoutKeys<T extends SessionStorageState>(state: T, keys: SessionKeys): T {
  const cookies = new Set(keys.cookies),
    local = new Set(keys.localStorage);
  return {
    ...state,
    cookies: state.cookies.filter(c => !cookies.has(c.name)),
    origins: state.origins
      .map(o => ({ ...o, localStorage: o.localStorage.filter(e => !local.has(e.name)) }))
      .filter(o => o.localStorage.length || (o as { indexedDB?: unknown[] }).indexedDB?.length),
  };
}

/**
 * One browser setup from several sessions. A cookie or localStorage key a session sets on purpose
 * (pinned, or named in `writes`) replaces the same name in another session's restored storage:
 * a login snapshot captured on the site usually holds the site's own bucket cookie, which an
 * experiment must override. Anything else two sessions both set (two sessions asserting one
 * cookie, a device field with different values, a header) is an error rather than a silent
 * override, since one of them would then be checked against state it does not have.
 */
export function composeSessions(sessions: { id: string; session: PreparedSession }[]) {
  const owner = new Map<string, string>();
  const claim = (what: string, id: string) => {
    const other = owner.get(what);
    if (other && other !== id) throw new Error(`Sessions ${other} and ${id} both set ${what}`);
    owner.set(what, id);
  };
  // Names each session asserts; restored entries of these names from other sessions are dropped.
  const asserted = sessions.map(({ id, session }) => {
    const cookies = new Set([...(session.pinnedCookies ?? []).map(c => c.name), ...(session.writes?.cookies ?? [])]);
    const local = new Set(session.writes?.localStorage ?? []);
    for (const name of cookies) claim(`cookie ${name}`, id);
    for (const name of local) claim(`localStorage ${name}`, id);
    return { id, cookies, local };
  });
  const assertedElsewhere = (id: string, kind: 'cookies' | 'local', name: string) =>
    asserted.some(a => a.id !== id && a[kind].has(name));
  const context: Record<string, unknown> = {};
  const cookies: SessionCookie[] = [];
  type Origin = { origin: string; localStorage: { name: string; value: string }[]; indexedDB?: unknown[] };
  const origins = new Map<string, Origin>();
  const extraHTTPHeaders: Record<string, string> = {};
  const permissions = new Set<string>();
  const headers: ScopedHeaders[] = [];
  const pinnedCookies: SessionCookie[] = [];
  const initScripts: string[] = [];
  for (const { id, session } of sessions) {
    const { storageState, extraHTTPHeaders: extra, permissions: granted, ...device } = session.context;
    for (const [key, value] of Object.entries(device)) {
      if (value === undefined) continue;
      if (key in context && JSON.stringify(context[key]) !== JSON.stringify(value)) claim(`context.${key}`, id);
      if (!owner.has(`context.${key}`)) owner.set(`context.${key}`, id);
      context[key] = value;
    }
    const state = storageState as SessionStorageState | undefined;
    for (const cookie of [...(state?.cookies ?? []), ...(session.pinnedCookies ?? [])]) {
      if (assertedElsewhere(id, 'cookies', cookie.name)) continue;
      claim(`cookie ${cookie.name}@${cookie.domain}${cookie.path}`, id);
      if (!cookies.some(c => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path))
        cookies.push(cookie);
    }
    for (const o of (state?.origins ?? []) as Origin[]) {
      const merged = origins.get(o.origin) ?? { origin: o.origin, localStorage: [] };
      for (const entry of o.localStorage) {
        if (assertedElsewhere(id, 'local', entry.name)) continue;
        claim(`localStorage ${entry.name}@${o.origin}`, id);
        merged.localStorage.push(entry);
      }
      if (o.indexedDB?.length) {
        claim(`indexedDB@${o.origin}`, id);
        merged.indexedDB = o.indexedDB;
      }
      origins.set(o.origin, merged);
    }
    for (const [name, value] of Object.entries(extra ?? {})) {
      claim(`header ${name.toLowerCase()}`, id);
      extraHTTPHeaders[name] = value;
    }
    for (const scoped of session.headers ?? []) {
      for (const name of Object.keys(scoped.headers)) claim(`header ${name.toLowerCase()}`, id);
      headers.push(scoped);
    }
    for (const p of granted ?? []) permissions.add(p);
    pinnedCookies.push(...(session.pinnedCookies ?? []));
    initScripts.push(...(session.initScripts ?? []));
  }
  return {
    context: {
      ...context,
      ...(cookies.length || origins.size ? { storageState: { cookies, origins: [...origins.values()] } } : {}),
      ...(Object.keys(extraHTTPHeaders).length ? { extraHTTPHeaders } : {}),
      ...(permissions.size ? { permissions: [...permissions] } : {}),
    } as SessionContextOptions,
    headers,
    pinnedCookies,
    initScripts,
  };
}
