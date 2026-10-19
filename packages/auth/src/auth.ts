import { z } from 'zod';
import { chromium, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright';
import {
  type PreparedSession,
  type SessionCheck,
  type SessionProvider,
  type SessionTarget,
  withoutKeys,
} from '@interaction/crawler';
import type { AccountCheck, AuthAdapter } from './adapter.js';
import { Vault } from './codec.js';
import { type SessionSnapshot, snapshotSchema, storageStateOf } from './snapshot.js';
import type { Account, AccountQuery, AccountStore, Verification } from './store.js';

export interface AuthOptions<Input = unknown> {
  store: AccountStore;
  /** This project's key: snapshots are stored encrypted with it. */
  vaultKey: string | Buffer;
  /** Where accounts come from and how they are judged. */
  adapter: AuthAdapter<Input>;
  headless?: boolean;
}

export interface ImportOptions {
  /** Added to what the adapter grants. */
  permissions?: string[];
  /** Added to (and override) the adapter's labels, e.g. `{ environment: 'staging' }`. */
  labels?: Record<string, string>;
  /** Overrides the adapter's and the snapshot's expiry. */
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
 * Logged-in test sessions, independent of where they come from: the adapter acquires an account
 * (from a preset file, a login script, a token service, …) and judges it; this class stores it
 * encrypted, activates it only once the adapter's verification passes, and hands verified
 * accounts out to crawls as a `SessionProvider`, which restores the session into each crawl's own
 * context, has the adapter re-check it while the crawl runs and keeps what the site refreshed.
 */
export class Auth<Input = unknown> {
  readonly store: AccountStore;
  readonly adapter: AuthAdapter<Input>;
  private readonly vault: Vault;
  constructor(readonly options: AuthOptions<Input>) {
    this.store = options.store;
    this.adapter = options.adapter;
    this.vault = new Vault(options.vaultKey);
  }

  /**
   * Import an account and verify it. It is stored as `pending` first and only becomes `active`
   * when verification passes; an input the adapter cannot read or whose snapshot does not
   * validate is not stored.
   */
  async import(input: Input, options: ImportOptions = {}): Promise<{ account: Account; verification: Verification }> {
    const acquired = await this.adapter.acquire(input, key => this.store.byKey(key));
    const parsed = snapshotSchema.safeParse(acquired.snapshot);
    if (!parsed.success)
      throw new Error(`Account ${acquired.key} has no usable session: ${parsed.error.message.slice(0, 200)}`);
    const snapshot = parsed.data;
    const expiresAt = options.expiresAt ?? acquired.expiresAt ?? snapshot.expiresAt;
    const account = this.store.save(
      {
        key: acquired.key,
        labels: { ...acquired.labels, ...options.labels },
        permissions: [...new Set([...(acquired.permissions ?? []), ...(options.permissions ?? [])])],
        domains: acquired.domains,
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
   * Have the adapter verify the account in fresh contexts. Only when it passes is the account
   * activated and the storage of its first session context kept as the refreshed snapshot.
   */
  async verify(accountId: string): Promise<Verification> {
    const account = this.store.account(accountId);
    if (!account) throw new Error('Unknown account');
    const snapshot = this.vault.open(this.store.snapshot(accountId)!);
    const at = new Date().toISOString();
    let verification: Verification = { accountId, at, ok: false };
    let refreshed: Buffer | undefined;
    const browser = await chromium.launch({ headless: this.options.headless ?? true });
    const contexts: BrowserContext[] = [];
    let sessionContext: BrowserContext | undefined;
    try {
      const result = await this.adapter.verify(account, {
        open: async ({ withSession = true } = {}) => {
          const context = await browser.newContext(contextFor(snapshot, withSession));
          contexts.push(context);
          if (withSession) sessionContext ??= context;
          return context.newPage();
        },
      });
      verification = { ...verification, ...result };
      if (result.ok && sessionContext) {
        const state = await sessionContext.storageState({ indexedDB: true });
        refreshed = this.vault.seal({ ...snapshot, ...(state as Pick<SessionSnapshot, 'cookies' | 'origins'>) });
      }
      return verification;
    } catch (error) {
      verification = { ...verification, ok: false, reason: `error: ${String(error).slice(0, 200)}` };
      return verification;
    } finally {
      for (const context of contexts) await context.close().catch(() => {});
      await browser.close().catch(() => {});
      this.store.recordVerification(verification, refreshed);
    }
  }

  /** A session provider for crawls; see `ProviderOptions`. */
  provider(options: ProviderOptions = {}): SessionProvider {
    return new AuthSessionProvider(this, this.vault, options);
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

class AuthSessionProvider implements SessionProvider {
  readonly id: string;
  private readonly task: string;
  constructor(
    private readonly auth: Auth<never>,
    private readonly vault: Vault,
    private readonly options: ProviderOptions,
  ) {
    this.id = auth.adapter.id;
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
      let invalid = false;
      return {
        describe: {
          account: held.id,
          key: held.key,
          ...held.labels,
          locale: held.locale,
          mobile: held.mobile,
        },
        context: contextFor(snapshot, true),
        recheckMs: this.options.recheckMs ?? 60_000,
        check: async (page: Page): Promise<SessionCheck> => {
          this.auth.store.renew(held.id, this.task, ttl);
          const { invalidate, ...check }: AccountCheck = await this.auth.adapter.check(page, held);
          if (invalidate) invalid = true;
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

const selectionSchema = z
  .object({
    accountId: z.string().optional(),
    labels: z.record(z.string(), z.string()).optional(),
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
export const authSessionFactory = (auth: Auth<never>) => (options: Record<string, unknown>) =>
  auth.provider(providerOptionsSchema.parse(options));
