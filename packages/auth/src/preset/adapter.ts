import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { hostMatches } from '@interaction/crawler';
import type { Page } from 'playwright';
import type { AccountCheck, AuthAdapter, Verifier, VerifyResult } from '../adapter.js';
import { keyFrom, seal, unseal } from '../codec.js';
import type { SessionSnapshot } from '../snapshot.js';
import { type Account, localeMatches } from '../store.js';
import { parsePresetName, type PresetIdentity, type PresetNameParser } from './names.js';
import { heartbeat, type HeartbeatResult, type SiteProfile, tradeUrlOf } from './sites.js';

/**
 * Turns an exported preset file into a session snapshot. The format belongs to the tool that
 * exported it (e.g. a playwright-auth `preset.enc`); hosts plug in a decoder for theirs.
 * The result is validated, so a decoder may return loosely typed JSON.
 */
export type PresetDecoder = (data: Buffer, key: Buffer) => unknown | Promise<unknown>;

/**
 * Reference preset format: AES-256-GCM over the snapshot JSON (`seal`). Replace with the
 * exporting tool's own decoder when it differs.
 */
export const sealedJsonPreset: PresetDecoder = (data, key) => JSON.parse(unseal(data, key).toString('utf8'));
export const encodeSealedJsonPreset = (snapshot: SessionSnapshot, key: Buffer) =>
  seal(Buffer.from(JSON.stringify(snapshot)), key);

export interface PresetAdapterOptions {
  /** The exporter's key, used only to read preset files. */
  presetKey: string | Buffer;
  /** Reads the exporter's preset format; default `sealedJsonPreset`. */
  decode?: PresetDecoder;
  parseName?: PresetNameParser;
  sites: SiteProfile[];
  /** Timeout for opening the trade page during verification. */
  navigationTimeoutMs?: number;
}

export interface PresetInput {
  /** File to read, or `data` with the preset `name` (a file name works). */
  file?: string;
  data?: Buffer;
  name?: string;
}

/** The identity an account was imported with, read back from its labels. */
const identityOf = (account: Account): PresetIdentity => ({
  preset: account.key,
  site: account.labels.site!,
  market: account.labels.market!,
  entity: account.labels.entity!,
});

/**
 * Accounts from exported preset files, for sites with a login heartbeat: preset names map to a
 * registered site, market and entity; verification wants the logged-in heartbeat accepted and an
 * anonymous one explicitly refused; crawls re-check heartbeat, domain, login route and language.
 * One way to write an `AuthAdapter`; hosts with other sources or checks write their own.
 */
export class PresetAdapter implements AuthAdapter<PresetInput> {
  readonly id = 'preset-auth';
  private readonly presetKey: Buffer;
  private readonly decode: PresetDecoder;
  private readonly parseName: PresetNameParser;
  constructor(readonly options: PresetAdapterOptions) {
    this.presetKey = keyFrom(options.presetKey);
    this.decode = options.decode ?? sealedJsonPreset;
    this.parseName = options.parseName ?? parsePresetName;
  }

  site(name: string) {
    return this.options.sites.find(s => s.site === name);
  }

  /** The preset name, checked against the site registry and the account it would replace. */
  identify(name: string, existing?: Account): { identity: PresetIdentity; profile: SiteProfile } {
    const identity = this.parseName(name);
    const profile = this.site(identity.site);
    if (!profile) throw new Error(`Preset ${identity.preset}: unknown site "${identity.site}"`);
    if (!(profile.markets ?? [profile.site]).includes(identity.market))
      throw new Error(`Preset ${identity.preset}: site ${identity.site} has no market "${identity.market}"`);
    if (profile.entities && !profile.entities.includes(identity.entity))
      throw new Error(`Preset ${identity.preset}: site ${identity.site} has no entity "${identity.entity}"`);
    const was = existing && identityOf(existing);
    if (was && (was.site !== identity.site || was.market !== identity.market || was.entity !== identity.entity))
      throw new Error(`Preset ${identity.preset} is mapped to ${was.site}/${was.market}/${was.entity} already`);
    return { identity, profile };
  }

  async acquire(input: PresetInput, existing: (key: string) => Account | undefined) {
    const name = input.name ?? (input.file && basename(input.file));
    if (!name) throw new Error('A preset needs a name');
    const preset = this.parseName(name).preset;
    const { identity, profile } = this.identify(name, existing(preset));
    const data = input.data ?? (input.file ? await readFile(input.file) : undefined);
    if (!data) throw new Error('A preset needs a file or data');
    let snapshot: SessionSnapshot;
    try {
      snapshot = (await this.decode(data, this.presetKey)) as SessionSnapshot;
    } catch (error) {
      throw new Error(`Preset ${identity.preset} could not be read: ${String((error as Error).message).slice(0, 200)}`);
    }
    const hosts = [
      ...(snapshot?.cookies ?? []).map(c => c.domain.replace(/^\./, '')),
      ...(snapshot?.origins ?? []).map(o => new URL(o.origin).hostname),
    ];
    if (!hosts.some(h => hostMatches(h, profile.domains) || profile.domains.some(d => d.endsWith(`.${h}`))))
      throw new Error(`Preset ${identity.preset} holds no storage for ${profile.domains.join(', ')}`);
    return {
      key: identity.preset,
      labels: {
        site: identity.site,
        market: identity.market,
        entity: identity.entity,
        ...(profile.environment ? { environment: profile.environment } : {}),
      },
      domains: profile.domains,
      snapshot,
    };
  }

  /**
   * Open the trade page with the session: the heartbeat must be accepted on an allowed host, off
   * the login route. Then open it without the session: its heartbeat must be explicitly refused.
   * Network failures and unexpected responses fail either side.
   */
  async verify(account: Account, verifier: Verifier) {
    const { profile, identity } = this.identify(account.key, account);
    const url = tradeUrlOf(profile, identity);
    const logged = await this.probe(await verifier.open(), profile, url, true);
    if (logged.result.outcome !== 'accepted')
      return fail(logged.reason ?? 'logged_in_rejected', { loggedIn: logged.result });
    const anonymous = await this.probe(await verifier.open({ withSession: false }), profile, url, false);
    if (anonymous.result.outcome !== 'rejected')
      // An accepted anonymous heartbeat proves nothing about the session; an unreadable one is not a refusal.
      return fail(anonymous.result.outcome === 'accepted' ? 'anonymous_accepted' : 'anonymous_invalid', {
        loggedIn: logged.result,
        anonymous: anonymous.result,
      });
    return { ok: true, facts: { loggedIn: logged.result, anonymous: anonymous.result } };
  }

  private async probe(page: Page, profile: SiteProfile, url: string, withSession: boolean) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.options.navigationTimeoutMs ?? 30_000 });
    } catch (error) {
      return {
        result: { outcome: 'invalid', error: String(error).slice(0, 200) } as HeartbeatResult,
        reason: 'trade_page_unreachable',
      };
    }
    let reason: string | undefined;
    if (!hostMatches(new URL(page.url()).hostname, profile.domains)) reason = 'off_domain';
    else if (profile.loginRoute?.test(page.url())) reason = 'login_route';
    const result = await heartbeat(page, page.context(), profile.heartbeat, url);
    // With a session, landing on the login page or another host is a failure whatever the heartbeat said.
    if (reason && withSession && result.outcome === 'accepted')
      return { result: { ...result, outcome: 'invalid' as const }, reason };
    return { result, reason };
  }

  /** The open page still runs in the account: right host, not the login route, its language, heartbeat accepted. */
  async check(page: Page, account: Account): Promise<AccountCheck> {
    const profile = this.site(account.labels.site!);
    if (!profile) return { ok: false, reason: 'unknown_site', facts: { site: account.labels.site } };
    const url = page.url();
    const host = new URL(url).hostname;
    if (!hostMatches(host, account.domains)) return { ok: false, reason: 'off_domain', facts: { host } };
    if (profile.loginRoute?.test(url)) return { ok: false, reason: 'login_route', facts: { url }, invalidate: true };
    const lang = await page.evaluate(() => document.documentElement.lang).catch(() => '');
    // Compared by language, not region (en-GB pages on an en-US account pass); an undeclared language passes.
    if (lang && !localeMatches(account.locale, lang.split('-')[0]!))
      return { ok: false, reason: 'language_mismatch', facts: { lang, locale: account.locale } };
    const result = await heartbeat(page, page.context(), profile.heartbeat, tradeUrlOf(profile, identityOf(account)));
    if (result.outcome === 'accepted') return { ok: true, facts: { host, lang, heartbeat: result.status } };
    return result.outcome === 'rejected'
      ? { ok: false, reason: 'heartbeat_rejected', facts: { ...result }, invalidate: true }
      : { ok: false, reason: 'heartbeat_invalid', facts: { ...result } };
  }
}

const fail = (reason: string, facts: Record<string, unknown>): VerifyResult => ({ ok: false, reason, facts });
