import type { Page } from 'playwright';
import type { DOMSnapshot } from './browser/driver.js';
import type { Rect, RuntimeEvidence } from './browser/types.js';

/**
 * Where an element was on screen when a plugin measured it: its box in viewport CSS pixels,
 * with the page's scroll offset and viewport size, so a screenshot of the state can outline it.
 */
export interface FindingTarget {
  box: Rect;
  scroll: { x: number; y: number };
  viewport: { width: number; height: number };
}

/** A problem a plugin observed in one crawled state. */
export interface Finding {
  /** Plugin-defined rule identifier, e.g. 'text-truncation'. */
  rule: string;
  severity: 'info' | 'warning' | 'error';
  /** CSS selector or node reference of the affected element. */
  selector: string;
  text: string;
  detail: string;
  /** Plugin-defined result code, explained by the plugin's `reasons()`. */
  code?: string;
  /** Where the affected element was on screen in this state. */
  target?: FindingTarget;
  /** Plugin-specific structured facts, kept as-is in the run record. */
  facts?: unknown;
}

/**
 * What one check of a plugin concluded on a state, in a shape the crawler and the debug page
 * read without knowing what was checked. Only counts are kept: problems are reported as findings.
 */
export interface CheckSummary {
  /** Plugin-defined check identifier, e.g. a rule id. */
  id: string;
  verdict: 'pass' | 'fail' | 'unknown' | 'not-applicable';
  /** How many targets (controls, elements) were checked. */
  targets: number;
  /** Targets by verdict, when more than one verdict occurred. */
  counts?: Partial<Record<CheckSummary['verdict'], number>>;
  ms: number;
  /**
   * Why targets did not pass: the most frequent result codes per verdict, with how many targets
   * each covers. Explained by the plugin's `reasons()`.
   */
  codes?: { code: string; verdict: Exclude<CheckSummary['verdict'], 'pass'>; count: number }[];
}
/** A check a plugin can run, named once per crawl so per-state summaries carry only ids. */
export interface CheckInfo {
  id: string;
  name: string;
  description?: string;
}
export type PluginResult = Finding[] | { findings: Finding[]; checks?: CheckSummary[] };

/** What a plugin sees for each newly discovered state. Reads only; plugins never act on the page. */
export interface CrawlStateContext {
  /** Abstract state key and its order of discovery in this crawl (1-based). */
  state: string;
  sequence: number;
  url: string;
  /** The capture the crawler used to choose actions. */
  snapshot: DOMSnapshot;
  /** The live page, for plugins that evaluate in the page themselves. */
  page: Page;
  /** Detailed capture (full DOM evidence with styles, layout and text geometry), taken on first call. */
  detail(): Promise<DOMSnapshot>;
  /** Network, console and error records so far. */
  runtime(): RuntimeEvidence;
  /** Record a partial failure (as a plugin_error event) while still returning other findings. */
  reportError(message: string): void;
}

/**
 * Crawl plugins observe states; they are composed in by the host (server, script) and the
 * crawler core knows nothing about what they check. Findings with the same rule, selector
 * and text are reported once per crawl.
 */
export interface CrawlPlugin {
  id: string;
  /**
   * Findings, optionally with a summary of each check run, passed or not. A check of `checks()`
   * left out of the summary had nothing to check on the state.
   */
  onState(context: CrawlStateContext): Promise<PluginResult> | PluginResult;
  /** The checks this plugin runs, for naming them in summaries. */
  checks?(): CheckInfo[];
  /** Plain-words explanation of result codes; each is recorded once, the first time a summary uses it. */
  reasons?(): Record<string, string>;
  /** Called once when the crawl ends, e.g. to report findings that resolved. */
  onEnd?(): Promise<Finding[]> | Finding[];
}

/** Unique key so the same issue on a recurring element is reported once. */
export const findingKey = (plugin: string, f: Finding) => `${plugin}|${f.rule}|${f.selector}|${f.text}`;
