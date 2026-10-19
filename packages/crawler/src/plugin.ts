import type { Page } from 'playwright';
import type { DOMSnapshot } from './browser/driver.js';
import type { RuntimeEvidence } from './browser/types.js';

/** A problem a plugin observed in one crawled state. */
export interface Finding {
  /** Plugin-defined rule identifier, e.g. 'text-truncation'. */
  rule: string;
  severity: 'info' | 'warning' | 'error';
  /** CSS selector or node reference of the affected element. */
  selector: string;
  text: string;
  detail: string;
  /** Plugin-specific structured facts, kept as-is in the run record. */
  facts?: unknown;
}

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
  onState(context: CrawlStateContext): Promise<Finding[]> | Finding[];
  /** Called once when the crawl ends, e.g. to report findings that resolved. */
  onEnd?(): Promise<Finding[]> | Finding[];
}

/** Unique key so the same issue on a recurring element is reported once. */
export const findingKey = (plugin: string, f: Finding) => `${plugin}|${f.rule}|${f.selector}|${f.text}`;
