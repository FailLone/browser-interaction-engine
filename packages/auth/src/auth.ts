import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright';
import {
  type PreparedSession,
  type SessionCheck,
  type SessionProvider,
  type SessionTarget,
  withoutKeys,
} from '@interaction/crawler';
import { keyFrom, type PresetDecoder, sealedJsonPreset, Vault } from './codec.js';
import { parsePresetName, type PresetIdentity, type PresetNameParser } from './names.js';
import { type SessionSnapshot, snapshotSchema, storageStateOf } from './snapshot.js';
import { type Account, type AccountQuery, type AccountStore, localeMatches, type Verification } from './store.js';
import { heartbeat, type HeartbeatResult, hostMatches, type SiteProfile, tradeUrlOf } from './sites.js';

export interface PresetAuthOptions {
  store: AccountStore;
  /** This project's key: snapshots are stored encrypted with it. */
  vaultKey: string | Buffer;
  /** The exporter's key, used only to read preset files. */
  presetKey: string | Buffer;
  /** Reads the exporter's preset format; default `sealedJsonPreset`. */
  decode?: PresetDecoder;
  parseName?: PresetNameParser;
  sites: SiteProfile[];
  headless?: boolean;
  /** Timeout for opening the trade page during verification. */
  navigationTimeoutMs?: number;
}

export interface ImportPreset {
  /** File to read, or `data` with the preset `name` (a file name works). */
  file?: string;
  data?: Buffer;
  name?: string;
  environment?: string;
  permissions?: string[];
  /** Overrides the snapshot's own expiry. */
  expiresAt?: string;
}

/** Which accounts a provider may hand out; the page host and mobile flag come from each crawl. */
export interface SessionSelection extends Omit<AccountQuery, 'host' | 'mobile'> {
  /** Use exactly this account (still checked against scope). */
  accountId?: string;
}

export interface ProviderOptions {
  select?: SessionSelection;
  /**
   * The task the crawls belong to. Crawls of one task may share an account (several pages, each in
   * its own context); other tasks wait for it. Default: a new task per provider.
   */
  task?: string;
  /** How long to wait for a locked account before failing; default 0. */
  waitMs?: number;
  /** Lock lifetime without renewal; checks renew it. Default 10 minutes. */
  lockTtlMs?: number;
  /** Interval between in-crawl checks; default 60 s. */
  recheckMs?: number;
}

/**
 * Logged-in test sessions from exported presets: import (decrypt, map the preset name to a known
 * site, re-encrypt with this project's key), verify (logged-in heartbeat accepted and an
 * anonymous one explicitly refused), and hand out verified accounts to crawls as a
 * `SessionProvider`, which restores the session into each crawl's own context and keeps
 * re-checking heartbeat, domain, route and language.
 */
export class PresetAuth {
  readonly store: AccountStore;
  private readonly vault: Vault;
  private readonly presetKey: Buffer;
  private readonly decode: PresetDecoder;
  private readonly parseName: PresetNameParser;
  constructor(readonly options: PresetAuthOptions) {
    this.store = options.store;
    this.vault = new Vault(options.vaultKey);
    this.presetKey = keyFrom(options.presetKey);
    this.decode = options.decode ?? sealedJsonPreset;
    this.parseName = options.parseName ?? parsePresetName;
  }

  site(name: string) {
    return this.options.sites.find(s => s.site === name);
  }

  /** The preset name, checked against the site registry and the account it would replace. */
  identify(name: string): { identity: PresetIdentity; profile: SiteProfile } {
    const identity = this.parseName(name);
    const profile = this.site(identity.site);
    if (!profile) throw new Error(`Preset ${identity.preset}: unknown site "${identity.site}"`);
    if (!(profile.markets ?? [profile.site]).includes(identity.market))
      throw new Error(`Preset ${identity.preset}: site ${identity.site} has no market "${identity.market}"`);
    if (profile.entities && !profile.entities.includes(identity.entity))
      throw new Error(`Preset ${identity.preset}: site ${identity.site} has no entity "${identity.entity}"`);
    const existing = this.store.byPreset(identity.preset);
    if (
      existing &&
      (existing.site !== identity.site || existing.market !== identity.market || existing.entity !== identity.entity)
    )
      throw new Error(
        `Preset ${identity.preset} is mapped to ${existing.site}/${existing.market}/${existing.entity} already`,
      );
    return { identity, profile };
  }

  /**
   * Import a preset and verify it. The account is stored as `pending` first and only becomes
   * `active` when verification passes; a preset that cannot be read or validated is not stored.
   */
  async import(input: ImportPreset): Promise<{ account: Account; verification: Verification }> {
    const name = input.name ?? (input.file && basename(input.file));
    if (!name) throw new Error('A preset needs a name');
    const { identity, profile } = this.identify(name);
    const data = input.data ?? (input.file ? await readFile(input.file) : undefined);
    if (!data) throw new Error('A preset needs a file or data');
    let snapshot: SessionSnapshot;
    try {
      snapshot = snapshotSchema.parse(await this.decode(data, this.presetKey));
    } catch (error) {
      throw new Error(`Preset ${identity.preset} could not be read: ${String((error as Error).message).slice(0, 200)}`);
    }
    const hosts = [
      ...snapshot.cookies.map(c => c.domain.replace(/^\./, '')),
      ...snapshot.origins.map(o => new URL(o.origin).hostname),
    ];
    if (!hosts.some(h => hostMatches(h, profile.domains) || profile.domains.some(d => d.endsWith(`.${h}`))))
      throw new Error(`Preset ${identity.preset} holds no storage for ${profile.domains.join(', ')}`);
    const expiresAt = input.expiresAt ?? snapshot.expiresAt;
    const account = this.store.save(
      {
        preset: identity.preset,
        site: identity.site,
        market: identity.market,
        entity: identity.entity,
        environment: input.environment ?? profile.environment ?? 'default',
        permissions: input.permissions ?? [],
        domains: profile.domains,
        locale: snapshot.device.locale,
        mobile: snapshot.device.isMobile,
        ...(expiresAt ? { expiresAt } : {}),
      },
      this.vault.seal(snapshot),
    );
    const verification = await this.verify(account.id);
    return { account: this.store.account(account.id)!, verification };
  }

  /**
   * Restore the account in one fresh context and open its trade page: the heartbeat must be
   * accepted (code 0) on an allowed host, off the login route. Then open the same page in a
   * context without the session: its heartbeat must be explicitly refused. Network failures and
   * unexpected responses fail either side. Only when both hold is the account activated and its
   * refreshed snapshot kept.
   */
  async verify(accountId: string): Promise<Verification> {
    const account = this.store.account(accountId);
    if (!account) throw new Error('Unknown account');
    const { profile, identity } = this.identify(account.preset);
    const snapshot = this.vault.open(this.store.snapshot(accountId)!);
    const url = tradeUrlOf(profile, identity);
    const at = new Date().toISOString();
    let verification: Verification = { accountId, at, ok: false };
    let refreshed: Buffer | undefined;
    const browser = await chromium.launch({ headless: this.options.headless ?? true });
    try {
      const logged = await this.probe(browser, profile, url, contextFor(snapshot, true));
      verification = { ...verification, loggedIn: logged.result };
      if (logged.result.outcome !== 'accepted') {
        verification.reason = logged.reason ?? 'logged_in_rejected';
        return verification;
      }
      const anonymous = await this.probe(browser, profile, url, contextFor(snapshot, false));
      verification.anonymous = anonymous.result;
      if (anonymous.result.outcome !== 'rejected') {
        // An accepted anonymous heartbeat proves nothing about the session; an unreadable one is not a refusal.
        verification.reason = anonymous.result.outcome === 'accepted' ? 'anonymous_accepted' : 'anonymous_invalid';
        return verification;
      }
      verification.ok = true;
      if (logged.state) refreshed = this.vault.seal({ ...snapshot, ...logged.state });
      return verification;
    } catch (error) {
      verification.reason = `error: ${String(error).slice(0, 200)}`;
      return verification;
    } finally {
      await browser.close().catch(() => {});
      this.store.recordVerification(verification, refreshed);
    }
  }

  private async probe(browser: Browser, profile: SiteProfile, url: string, options: BrowserContextOptions) {
    const context = await browser.newContext(options);
    try {
      const page = await context.newPage();
      let reason: string | undefined;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.options.navigationTimeoutMs ?? 30_000 });
      } catch (error) {
        return {
          result: { outcome: 'invalid', error: String(error).slice(0, 200) } as HeartbeatResult,
          reason: 'trade_page_unreachable',
        };
      }
      const where = new URL(page.url());
      if (!hostMatches(where.hostname, profile.domains)) reason = 'off_domain';
      else if (profile.loginRoute?.test(page.url())) reason = 'login_route';
      const result = await heartbeat(page, context, profile.heartbeat, url);
      // With a session, landing on the login page or another host is a failure whatever the heartbeat said.
      if (reason && options.storageState && result.outcome === 'accepted')
        return { result: { ...result, outcome: 'invalid' as const }, reason };
      const state = options.storageState
        ? ((await context.storageState({ indexedDB: true })) as Pick<SessionSnapshot, 'cookies' | 'origins'>)
        : undefined;
      return { result, reason, state };
    } finally {
      await context.close().catch(() => {});
    }
  }

  /** A session provider for crawls; see `ProviderOptions`. */
  provider(options: ProviderOptions = {}): SessionProvider {
    return new PresetSessionProvider(this, this.vault, options);
  }
}

/** Context options that restore a snapshot's device, and its storage when `withStorage`. */
function contextFor(snapshot: SessionSnapshot, withStorage: boolean): BrowserContextOptions {
  const d = snapshot.device;
  return {
    ...(withStorage ? { storageState: storageStateOf(snapshot) } : {}),
    userAgent: d.userAgent,
    locale: d.locale,
    ...(d.timezoneId ? { timezoneId: d.timezoneId } : {}),
    ...(d.deviceScaleFactor ? { deviceScaleFactor: d.deviceScaleFactor } : {}),
    ...(d.viewport ? { viewport: d.viewport } : {}),
    isMobile: d.isMobile,
    hasTouch: d.hasTouch,
  };
}

class PresetSessionProvider implements SessionProvider {
  readonly id = 'preset-auth';
  private readonly task: string;
  constructor(
    private readonly auth: PresetAuth,
    private readonly vault: Vault,
    private readonly options: ProviderOptions,
  ) {
    this.task = options.task ?? crypto.randomUUID();
  }

  /** Accounts in scope for the page, in preference order. */
  candidates(target: SessionTarget): Account[] {
    const { accountId, ...query } = this.options.select ?? {};
    const found = this.auth.store.find({
      ...query,
      host: new URL(target.url).hostname,
      mobile: target.viewport.mobile,
    });
    return accountId ? found.filter(a => a.id === accountId) : found;
  }

  async prepare(target: SessionTarget): Promise<PreparedSession> {
    const ttl = this.options.lockTtlMs ?? 600_000;
    const deadline = Date.now() + (this.options.waitMs ?? 0);
    let account: Account | undefined;
    for (;;) {
      const candidates = this.candidates(target);
      if (!candidates.length)
        throw new Error(`No verified account covers ${new URL(target.url).hostname} with the requested scope`);
      // An account this task already holds comes first, so pages of one task share it.
      const ordered = [
        ...candidates.filter(a => this.auth.store.lockOwner(a.id) === this.task),
        ...candidates.filter(a => this.auth.store.lockOwner(a.id) !== this.task),
      ];
      account = ordered.find(a => this.auth.store.acquire(a.id, this.task, ttl));
      if (account || Date.now() >= deadline) break;
      await new Promise(r => setTimeout(r, 500));
    }
    if (!account) throw new Error('Every account in scope is in use by another task');
    const held = account;
    let released = false;
    const release = () => {
      if (!released) this.auth.store.release(held.id, this.task);
      released = true;
    };
    try {
      const snapshot = this.vault.open(this.auth.store.snapshot(held.id)!);
      const profile = this.auth.site(held.site);
      if (!profile) throw new Error(`Site ${held.site} is no longer registered`);
      const identity = { preset: held.preset, site: held.site, market: held.market, entity: held.entity };
      let invalid = false;
      return {
        describe: {
          account: held.id,
          preset: held.preset,
          site: held.site,
          market: held.market,
          entity: held.entity,
          environment: held.environment,
          locale: held.locale,
          mobile: held.mobile,
        },
        context: contextFor(snapshot, true),
        recheckMs: this.options.recheckMs ?? 60_000,
        check: async (page: Page): Promise<SessionCheck> => {
          this.auth.store.renew(held.id, this.task, ttl);
          const check = await checkPage(page, held, profile, tradeUrlOf(profile, identity));
          if (check.reason === 'heartbeat_rejected' || check.reason === 'login_route') invalid = true;
          return check;
        },
        release: async ({ context, verified, foreign }) => {
          try {
            if (invalid) this.auth.store.invalidate(held.id);
            else if (verified && context) {
              // Keep what the site refreshed (rotated tokens, new cookies) for the next crawl, but not
              // what other sessions of the crawl put in (an experiment's bucket cookie).
              const state = await context.storageState({ indexedDB: true }).catch(() => undefined);
              if (state)
                this.auth.store.recordVerification(
                  { accountId: held.id, at: new Date().toISOString(), ok: true, reason: 'crawl' },
                  this.vault.seal({
                    ...snapshot,
                    ...((foreign ? withoutKeys(state, foreign) : state) as Pick<
                      SessionSnapshot,
                      'cookies' | 'origins'
                    >),
                  }),
                );
            }
          } finally {
            release();
          }
        },
      };
    } catch (error) {
      release();
      throw error;
    }
  }
}

/** The open page still runs in the account: right host, not the login route, its language, heartbeat accepted. */
async function checkPage(page: Page, account: Account, profile: SiteProfile, base: string): Promise<SessionCheck> {
  const url = page.url();
  const host = new URL(url).hostname;
  if (!hostMatches(host, account.domains)) return { ok: false, reason: 'off_domain', facts: { host } };
  if (profile.loginRoute?.test(url)) return { ok: false, reason: 'login_route', facts: { url } };
  const lang = await page.evaluate(() => document.documentElement.lang).catch(() => '');
  // Compared by language, not region (en-GB pages on an en-US account pass); an undeclared language passes.
  if (lang && !localeMatches(account.locale, lang.split('-')[0]!))
    return { ok: false, reason: 'language_mismatch', facts: { lang, locale: account.locale } };
  const result = await heartbeat(page, page.context(), profile.heartbeat, base);
  if (result.outcome === 'accepted') return { ok: true, facts: { host, lang, heartbeat: result.status } };
  return {
    ok: false,
    reason: result.outcome === 'rejected' ? 'heartbeat_rejected' : 'heartbeat_invalid',
    facts: { ...result },
  };
}

const selectionSchema = z
  .object({
    accountId: z.string().optional(),
    site: z.string().optional(),
    market: z.string().optional(),
    entity: z.string().optional(),
    environment: z.string().optional(),
    permissions: z.array(z.string()).optional(),
    locale: z.string().optional(),
    validForMs: z.number().int().min(0).optional(),
  })
  .strict();
const providerOptionsSchema = z
  .object({
    select: selectionSchema.optional(),
    task: z.string().min(1).max(128).optional(),
    waitMs: z.number().int().min(0).max(600_000).optional(),
    recheckMs: z.number().int().min(5_000).optional(),
  })
  .strict();

/** For `CrawlManager`'s session factories: run request options are validated, then a provider is made. */
export const presetSessionFactory = (auth: PresetAuth) => (options: Record<string, unknown>) =>
  auth.provider(providerOptionsSchema.parse(options));
