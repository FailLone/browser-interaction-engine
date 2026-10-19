import type { Page } from 'playwright';
import type { SessionCheck } from '@interaction/crawler';
import type { Account } from './store.js';

/** What an adapter got from its source: who the account is, where it may be used, and its session. */
export interface AcquiredAccount {
  /** Unique per account; importing the same key again replaces it (and it must be verified again). */
  key: string;
  /** Free-form scope crawls select by, e.g. `{ site: 'global', entity: 'eid14' }`. */
  labels?: Record<string, string>;
  permissions?: string[];
  /** Hosts the session is for; `.example.com` covers subdomains. Crawls of other hosts never get it. */
  domains: string[];
  /** Loosely typed is fine: it is validated as a `SessionSnapshot`, and nothing is stored when it does not parse. */
  snapshot: unknown;
  /** Overrides the snapshot's own expiry. */
  expiresAt?: string;
}

export interface VerifyResult {
  ok: boolean;
  /** Short machine-readable reason when not ok. */
  reason?: string;
  /** Non-secret facts kept with the verification record. */
  facts?: Record<string, unknown>;
}

/** Browser access during verification; every context is fresh and closed when `verify` returns. */
export interface Verifier {
  /**
   * A page in a new context with the account's device, and its session unless `withSession` is
   * false. When verification passes, the storage of the first session context opened is kept as
   * the account's refreshed snapshot.
   */
  open(options?: { withSession?: boolean }): Promise<Page>;
}

export interface AccountCheck extends SessionCheck {
  /** The account itself no longer works (logged out, revoked): take it out of rotation until verified again. */
  invalidate?: boolean;
}

/**
 * Everything specific to where accounts come from and what "logged in" means for a site. The auth
 * package stores, locks, restores and schedules; the adapter supplies accounts and judges them.
 */
export interface AuthAdapter<Input = unknown> {
  /** Names the session provider in crawl events and summaries. */
  id: string;
  /**
   * Turn an import (a file, credentials, a token from a service, …) into an account. Throw when it
   * cannot be read or does not belong here; nothing is stored then. `existing` is the account
   * the key would replace, if any.
   */
  acquire(input: Input, existing: (key: string) => Account | undefined): Promise<AcquiredAccount>;
  /** Prove a newly imported or re-verified session works before crawls may use it. */
  verify(account: Account, verifier: Verifier): Promise<VerifyResult>;
  /** Whether the crawl's open page still runs in the account; called once the entry page has loaded and on every recheck. */
  check(page: Page, account: Account): Promise<AccountCheck>;
}
