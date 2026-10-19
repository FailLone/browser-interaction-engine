import type { BrowserContext, Page } from 'playwright';
import type { PresetIdentity } from './names.js';

/** How a heartbeat answered: logged in, explicitly refused, or nothing usable (network, format). */
export type HeartbeatOutcome = 'accepted' | 'rejected' | 'invalid';

export interface HeartbeatResult {
  outcome: HeartbeatOutcome;
  status?: number;
  /** The response's business code, when it had one. */
  code?: unknown;
  error?: string;
}

export interface HeartbeatResponse {
  status: number;
  /** Parsed JSON, or undefined when the body was not JSON. */
  body: unknown;
}

export interface HeartbeatSpec {
  /** Absolute, or relative to the trade page. */
  url: string;
  method?: 'GET' | 'POST';
  body?: string;
  /**
   * Request headers derived from the open page, e.g. a token the app keeps in localStorage.
   * Cookies are always sent.
   */
  headers?(page: Page): Promise<Record<string, string>> | Record<string, string>;
  /**
   * Default: HTTP 2xx with JSON `code === 0` is accepted; a JSON numeric `code` other than 0,
   * or HTTP 401/403, is rejected; anything else (HTML login page, 5xx, no code) is invalid.
   */
  classify?(response: HeartbeatResponse): HeartbeatOutcome;
}

/**
 * What the registry knows about one site. Preset names are checked against it, verification
 * opens `tradeUrl` and calls `heartbeat`, and crawls re-check `domains`, `loginRoute` and the
 * language against it.
 */
export interface SiteProfile {
  /** The site part of a preset name, e.g. `global`. */
  site: string;
  /** Markets presets of this site may name; default: only the site itself. */
  markets?: string[];
  /** Entities presets may name; omitted means any. */
  entities?: string[];
  /** Hosts the session is for; `.example.com` covers subdomains. */
  domains: string[];
  /** Environment accounts of this site belong to unless the import says otherwise, e.g. `prod`. */
  environment?: string;
  tradeUrl: string | ((identity: PresetIdentity) => string);
  heartbeat: HeartbeatSpec;
  /** Pages that mean "not logged in" (matched against the full URL). */
  loginRoute?: RegExp;
}

export { hostMatches } from '@interaction/crawler';

export const tradeUrlOf = (profile: SiteProfile, identity: PresetIdentity) =>
  typeof profile.tradeUrl === 'function' ? profile.tradeUrl(identity) : profile.tradeUrl;

export function defaultClassify({ status, body }: HeartbeatResponse): HeartbeatOutcome {
  if (status === 401 || status === 403) return 'rejected';
  const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
  if (typeof code !== 'number') return 'invalid';
  if (code !== 0) return 'rejected';
  return status >= 200 && status < 300 ? 'accepted' : 'invalid';
}

/**
 * Call the heartbeat as the page would: from inside the page when it is on the heartbeat's
 * origin (so the app's cookies and derived headers apply), otherwise through the context's
 * request client, which shares the cookies but is not subject to CORS.
 */
export async function heartbeat(
  page: Page,
  context: BrowserContext,
  spec: HeartbeatSpec,
  base: string,
): Promise<HeartbeatResult> {
  let response: { status: number; text: string };
  try {
    const url = new URL(spec.url, base).href;
    const headers = (await spec.headers?.(page)) ?? {};
    const init = { method: spec.method ?? 'GET', headers, ...(spec.body !== undefined ? { body: spec.body } : {}) };
    if (new URL(page.url()).origin === new URL(url).origin)
      response = await page.evaluate(
        async ({ url, init }) => {
          const r = await fetch(url, { ...init, credentials: 'include', redirect: 'follow' });
          return { status: r.status, text: await r.text() };
        },
        { url, init },
      );
    else {
      const r = await context.request.fetch(url, { method: init.method, headers, data: spec.body, maxRedirects: 5 });
      response = { status: r.status(), text: await r.text() };
    }
  } catch (error) {
    return { outcome: 'invalid', error: String(error).slice(0, 200) };
  }
  let body: unknown;
  try {
    body = JSON.parse(response.text);
  } catch {
    body = undefined;
  }
  const outcome = (spec.classify ?? defaultClassify)({ status: response.status, body });
  const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
  return { outcome, status: response.status, ...(code !== undefined ? { code } : {}) };
}
