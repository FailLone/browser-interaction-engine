import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostMatches } from '@interaction/crawler';

export type AccountStatus = 'pending' | 'active' | 'invalid';

/** A test account: who it is, where it may be used, and its sealed session snapshot. */
export interface Account {
  id: string;
  /** The adapter's unique name for it, e.g. a preset name. */
  key: string;
  /** The adapter's scope, e.g. `{ site: 'global', entity: 'eid14' }`; crawls select by it. */
  labels: Record<string, string>;
  permissions: string[];
  domains: string[];
  locale: string;
  mobile: boolean;
  status: AccountStatus;
  expiresAt?: string;
  verifiedAt?: string;
  importedAt: string;
}

export interface Verification {
  accountId: string;
  at: string;
  ok: boolean;
  /** Why it failed, as the adapter put it, or 'error: …' when verification threw. */
  reason?: string;
  /** Non-secret facts from the adapter. */
  facts?: Record<string, unknown>;
}

export interface AccountQuery {
  /** Every one must equal the account's label. */
  labels?: Record<string, string>;
  /** Every one must be granted to the account. */
  permissions?: string[];
  /** The page host; the account's domains must cover it. */
  host?: string;
  /** `en` matches `en-US`; `en-US` matches only `en-US`. */
  locale?: string;
  mobile?: boolean;
  /** The session must stay valid at least this long from now. */
  validForMs?: number;
}

type Row = Record<string, string | number | null>;

/** Accounts, their sealed snapshots, verification history and use locks, in one SQLite file. */
export class AccountStore {
  private readonly db: Database.Database;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, labels TEXT NOT NULL,
        permissions TEXT NOT NULL, domains TEXT NOT NULL, locale TEXT NOT NULL,
        mobile INTEGER NOT NULL, status TEXT NOT NULL, expires_at TEXT, verified_at TEXT, imported_at TEXT NOT NULL,
        snapshot BLOB NOT NULL, lock_owner TEXT, lock_holders INTEGER NOT NULL DEFAULT 0, lock_until INTEGER);
      CREATE TABLE IF NOT EXISTS account_verifications(account_id TEXT NOT NULL, at TEXT NOT NULL, ok INTEGER NOT NULL,
        data TEXT NOT NULL);`);
  }

  /** Insert or replace by key. A replaced snapshot must be verified again before use. */
  save(account: Omit<Account, 'id' | 'status' | 'importedAt' | 'verifiedAt'>, snapshot: Buffer): Account {
    const existing = this.byKey(account.key);
    const id = existing?.id ?? crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO accounts(id,key,labels,permissions,domains,locale,mobile,status,expires_at,imported_at,snapshot)
         VALUES(@id,@key,@labels,@permissions,@domains,@locale,@mobile,'pending',@expiresAt,@importedAt,@snapshot)
         ON CONFLICT(id) DO UPDATE SET labels=@labels,permissions=@permissions,
           domains=@domains,locale=@locale,mobile=@mobile,status='pending',expires_at=@expiresAt,verified_at=NULL,
           imported_at=@importedAt,snapshot=@snapshot`,
      )
      .run({
        ...account,
        id,
        labels: JSON.stringify(account.labels),
        permissions: JSON.stringify(account.permissions),
        domains: JSON.stringify(account.domains),
        mobile: account.mobile ? 1 : 0,
        expiresAt: account.expiresAt ?? null,
        importedAt: new Date().toISOString(),
        snapshot,
      });
    return this.account(id)!;
  }

  account(id: string): Account | undefined {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id) as Row | undefined;
    return row && decode(row);
  }
  byKey(key: string): Account | undefined {
    const row = this.db.prepare('SELECT * FROM accounts WHERE key=?').get(key) as Row | undefined;
    return row && decode(row);
  }
  accounts(): Account[] {
    return (this.db.prepare('SELECT * FROM accounts ORDER BY key').all() as Row[]).map(decode);
  }
  snapshot(id: string): Buffer | undefined {
    return (this.db.prepare('SELECT snapshot FROM accounts WHERE id=?').get(id) as { snapshot: Buffer } | undefined)
      ?.snapshot;
  }

  /**
   * Record a verification. Only a passed one activates the account and, when given, replaces its
   * snapshot with the refreshed one; a failed one leaves the snapshot and marks the account invalid.
   */
  recordVerification(verification: Verification, refreshed?: Buffer) {
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO account_verifications(account_id,at,ok,data) VALUES(?,?,?,?)')
        .run(verification.accountId, verification.at, verification.ok ? 1 : 0, JSON.stringify(verification));
      if (verification.ok)
        this.db
          .prepare(`UPDATE accounts SET status='active', verified_at=?, snapshot=COALESCE(?, snapshot) WHERE id=?`)
          .run(verification.at, refreshed ?? null, verification.accountId);
      else this.db.prepare(`UPDATE accounts SET status='invalid' WHERE id=?`).run(verification.accountId);
    })();
  }
  verifications(accountId: string): Verification[] {
    return (
      this.db
        .prepare('SELECT data FROM account_verifications WHERE account_id=? ORDER BY rowid DESC')
        .all(accountId) as { data: string }[]
    ).map(r => JSON.parse(r.data));
  }

  /** Taken out of use until verified again, e.g. after a crawl's check found it logged out. */
  invalidate(id: string) {
    this.db.prepare(`UPDATE accounts SET status='invalid' WHERE id=?`).run(id);
  }

  /** Active accounts in scope, most recently verified first. */
  find(query: AccountQuery): Account[] {
    const until = Date.now() + (query.validForMs ?? 0);
    return this.accounts()
      .filter(
        a =>
          a.status === 'active' &&
          (!a.expiresAt || Date.parse(a.expiresAt) > until) &&
          Object.entries(query.labels ?? {}).every(([name, value]) => a.labels[name] === value) &&
          (query.permissions ?? []).every(p => a.permissions.includes(p)) &&
          (!query.host || hostMatches(query.host, a.domains)) &&
          (!query.locale || localeMatches(a.locale, query.locale)) &&
          (query.mobile === undefined || a.mobile === query.mobile),
      )
      .sort((a, b) => (b.verifiedAt ?? '').localeCompare(a.verifiedAt ?? ''));
  }

  /**
   * Take the account's lock for `owner`. An owner may hold it several times at once (one task
   * checking several pages with the same account); other owners wait until every hold is
   * released or `ttlMs` passes without renewal (a crashed process).
   */
  acquire(id: string, owner: string, ttlMs: number) {
    const now = Date.now();
    return (
      this.db
        .prepare(
          `UPDATE accounts SET lock_owner=@owner, lock_until=@until,
             lock_holders=CASE WHEN lock_owner=@owner AND lock_until>@now THEN lock_holders+1 ELSE 1 END
           WHERE id=@id AND (lock_owner IS NULL OR lock_until<=@now OR lock_owner=@owner)`,
        )
        .run({ id, owner, now, until: now + ttlMs }).changes === 1
    );
  }
  release(id: string, owner: string) {
    this.db
      .prepare(
        `UPDATE accounts SET lock_holders=lock_holders-1,
           lock_owner=CASE WHEN lock_holders<=1 THEN NULL ELSE lock_owner END,
           lock_until=CASE WHEN lock_holders<=1 THEN NULL ELSE lock_until END
         WHERE id=? AND lock_owner=?`,
      )
      .run(id, owner);
  }
  /** Extend the owner's lock without adding a hold. */
  renew(id: string, owner: string, ttlMs: number) {
    this.db.prepare('UPDATE accounts SET lock_until=? WHERE id=? AND lock_owner=?').run(Date.now() + ttlMs, id, owner);
  }
  lockOwner(id: string): string | undefined {
    const row = this.db.prepare('SELECT lock_owner, lock_until FROM accounts WHERE id=?').get(id) as
      | { lock_owner: string | null; lock_until: number | null }
      | undefined;
    return row?.lock_owner && (row.lock_until ?? 0) > Date.now() ? row.lock_owner : undefined;
  }

  close() {
    this.db.close();
  }
}

const decode = (row: Row): Account => ({
  id: String(row.id),
  key: String(row.key),
  labels: JSON.parse(String(row.labels)),
  permissions: JSON.parse(String(row.permissions)),
  domains: JSON.parse(String(row.domains)),
  locale: String(row.locale),
  mobile: row.mobile === 1,
  status: row.status as AccountStatus,
  ...(row.expires_at ? { expiresAt: String(row.expires_at) } : {}),
  ...(row.verified_at ? { verifiedAt: String(row.verified_at) } : {}),
  importedAt: String(row.imported_at),
});

export const localeMatches = (account: string, wanted: string) => {
  const a = account.toLowerCase(),
    w = wanted.toLowerCase();
  return a === w || (!w.includes('-') && a.split('-')[0] === w);
};
