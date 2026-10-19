import { z } from 'zod';
import type { Page } from 'playwright';
import {
  hostMatches,
  type PreparedSession,
  type SessionCheck,
  type SessionCookie,
  type SessionProvider,
} from './session.js';

export interface ExperimentOptions {
  /** Experiment name, e.g. `checkout-redesign`; with `variant`, shown in events and the summary. */
  name: string;
  variant: string;
  /** Hosts the variant applies to; `.example.com` covers subdomains. Nothing is sent elsewhere. */
  domains: string[];
  /** Bucketing cookies, e.g. `{ exp_checkout: 'B' }`. */
  cookies?: Record<string, string>;
  /** Hold the cookies at their value even when the site re-buckets (default true). */
  pin?: boolean;
  /** Request headers, sent only to `domains`. */
  headers?: Record<string, string>;
  /** localStorage entries, written before page scripts on every document of `domains`. */
  localStorage?: Record<string, string>;
  /**
   * Proves the page runs in the variant (a DOM marker, a global). By default the cookies and
   * localStorage entries are read back; a header-only experiment has nothing to read back.
   */
  check?(page: Page): Promise<SessionCheck> | SessionCheck;
  recheckMs?: number;
}

/**
 * An A/B variant as browser state: cookies (pinned by default), host-scoped headers and
 * localStorage. Combine it with a login (`session: [login, experiment]`) to test the variant
 * signed in. Its `resumeKey` keeps resumed runs on the same variant.
 */
export function experimentSession(options: ExperimentOptions): SessionProvider {
  const { name, variant, domains } = options;
  if (!domains.length) throw new Error('An experiment needs the domains it applies to');
  const cookies = Object.entries(options.cookies ?? {}).flatMap(([cookie, value]) =>
    domains.map(
      (domain): SessionCookie => ({
        name: cookie,
        value,
        domain,
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: 'Lax',
      }),
    ),
  );
  const local = options.localStorage ?? {};
  return {
    id: `experiment:${name}`,
    resumeKey: `experiment:${name}=${variant}`,
    async prepare(): Promise<PreparedSession> {
      const pin = options.pin ?? true;
      return {
        describe: { experiment: name, variant },
        context: pin || !cookies.length ? {} : { storageState: { cookies, origins: [] } },
        ...(pin && cookies.length ? { pinnedCookies: cookies } : {}),
        ...(options.headers ? { headers: [{ domains, headers: options.headers }] } : {}),
        ...(Object.keys(local).length
          ? { initScripts: [`(${writeLocalStorage.toString()})(${JSON.stringify(domains)}, ${JSON.stringify(local)})`] }
          : {}),
        writes: { cookies: Object.keys(options.cookies ?? {}), localStorage: Object.keys(local) },
        recheckMs: options.recheckMs ?? 60_000,
        check: async page =>
          options.check ? options.check(page) : readBack(page, domains, options.cookies ?? {}, local),
        release: async () => {},
      };
    },
  };
}

/** In-page: write the entries before page scripts run, on matching hosts only. */
function writeLocalStorage(domains: string[], entries: Record<string, string>) {
  const host = location.hostname;
  if (!domains.some(d => (d.startsWith('.') ? host === d.slice(1) || host.endsWith(d) : host === d))) return;
  try {
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  } catch {
    // Storage blocked (sandboxed frame); the check reports it on the main page.
  }
}

async function readBack(
  page: Page,
  domains: string[],
  cookies: Record<string, string>,
  local: Record<string, string>,
): Promise<SessionCheck> {
  const host = new URL(page.url()).hostname;
  if (!hostMatches(host, domains)) return { ok: false, reason: 'off_domain', facts: { host } };
  const jar = new Map((await page.context().cookies(page.url())).map(c => [c.name, c.value]));
  const cookieMismatch = Object.entries(cookies).filter(([k, v]) => jar.get(k) !== v);
  if (cookieMismatch.length)
    return {
      ok: false,
      reason: 'variant_cookie_mismatch',
      facts: Object.fromEntries(cookieMismatch.map(([k]) => [k, jar.get(k) ?? null])),
    };
  const stored = await page
    .evaluate(keys => Object.fromEntries(keys.map(k => [k, localStorage.getItem(k)])), Object.keys(local))
    .catch(() => ({}) as Record<string, string | null>);
  const localMismatch = Object.entries(local).filter(([k, v]) => stored[k] !== v);
  if (localMismatch.length)
    return {
      ok: false,
      reason: 'variant_storage_mismatch',
      facts: Object.fromEntries(localMismatch.map(([k]) => [k, stored[k] ?? null])),
    };
  return { ok: true, facts: { host } };
}

const record = z.record(z.string().min(1).max(256), z.string().max(4096));
const experimentSchema = z
  .object({
    name: z.string().min(1).max(128),
    variant: z.string().min(1).max(128),
    domains: z.array(z.string().min(1).max(253)).min(1).max(20),
    cookies: record.optional(),
    pin: z.boolean().optional(),
    headers: record.optional(),
    localStorage: record.optional(),
    recheckMs: z.number().int().min(5_000).optional(),
  })
  .strict();

/** For `CrawlManager`'s session factories: an experiment from run request options (no custom check). */
export const experimentSessionFactory = (options: Record<string, unknown>) =>
  experimentSession(experimentSchema.parse(options));
