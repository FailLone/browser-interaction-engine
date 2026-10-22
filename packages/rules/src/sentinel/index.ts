import type { CrawlPlugin } from '@interaction/crawler';
import { rulesPlugin, type RulesPluginOptions } from '../crawl-plugin.js';
import { makeSentinelPlugins, sentinelReasons, type SentinelOptions } from './core.js';
import { overlapRule } from './overlap.js';
import { reachabilityRule } from './reachability.js';
import { transientStateRule } from './transient-state.js';
import { selectionRule } from './selection.js';
import { chartRule } from './chart.js';
import { decorationRule } from './decoration.js';
import { tokenRule } from './tokens.js';
import { typographyRule, componentConsistencyRule } from './consistency.js';
import { alignmentRule } from './alignment.js';
import { themeRule } from './theme.js';
import { imageFallbackRule } from './image-fallback.js';
import { feedbackRule } from './feedback.js';
import { navigationRule } from './navigation.js';
import { continuityRule } from './continuity.js';
import { affordanceRule } from './affordance.js';
import { focusRule } from './focus.js';
import { scrollCueRule } from './scroll-cue.js';
import { imageClarityRule } from './image-clarity.js';

export * from './core.js';
export * from './overlap.js';
export * from './reachability.js';
export * from './transient-state.js';
export * from './selection.js';
export * from './chart.js';
export * from './decoration.js';
export * from './tokens.js';
export * from './consistency.js';
export * from './alignment.js';
export * from './theme.js';
export * from './image-fallback.js';
export * from './feedback.js';
export * from './navigation.js';
export * from './continuity.js';
export * from './affordance.js';
export * from './focus.js';
export * from './scroll-cue.js';
export * from './image-clarity.js';

const definitions = [
  overlapRule,
  reachabilityRule,
  transientStateRule,
  selectionRule,
  chartRule,
  decorationRule,
  tokenRule,
  typographyRule,
  componentConsistencyRule,
  alignmentRule,
  themeRule,
  imageFallbackRule,
  feedbackRule,
  navigationRule,
  continuityRule,
  affordanceRule,
  focusRule,
  scrollCueRule,
  imageClarityRule,
];
/** Documentation IDs remain stable. Four entries reuse bounded existing measurements, without duplicating findings. */
export const sentinelCatalog = [
  {
    id: 'UIK-D001',
    name: '必要内容裁切',
    kind: 'defect',
    plugin: 'rules',
    rules: ['observed-clipping', 'observed-text-truncation'],
    coverage: 'control/text clipping; semantic necessity and alternative paths still require host evidence',
  },
  {
    id: 'UIK-D004',
    name: '图像保形',
    kind: 'defect',
    plugin: 'rules',
    rules: ['image-aspect-ratio'],
    coverage: 'raster scaling with exact resource-bound requirements; not intrinsic artwork quality',
  },
  {
    id: 'UIK-D005',
    name: '必要前景可见性',
    kind: 'defect',
    plugin: 'rules',
    rules: ['observed-text-background'],
    coverage: 'control-label foreground/background; not arbitrary chart graphics',
  },
  {
    id: 'UIK-D010',
    name: '指针拦截',
    kind: 'defect',
    plugin: 'rules',
    rules: ['observed-occlusion'],
    coverage: 'sampled pointer reachability; not whole-control event delivery',
  },
  ...definitions.map(d => ({
    id: d.id,
    name: d.name,
    kind: d.kind,
    plugin: 'sentinel',
    rules: [d.id],
    coverage: 'current host-bound semantic and recorded observation evidence',
  })),
]
  .map(entry => ({ ...entry, documentRevision: 1 }))
  .sort((a, b) => a.id.localeCompare(b.id));

/** Individual RulePlugin instances can also be composed directly into rulesPlugin({ rules }). */
export const createSentinelRulePlugins = (options: SentinelOptions = {}) => makeSentinelPlugins(definitions, options);
export function sentinelPlugin(
  options: SentinelOptions & Pick<RulesPluginOptions, 'pixels' | 'report'> = {},
): CrawlPlugin {
  return rulesPlugin({
    id: 'sentinel',
    rules: createSentinelRulePlugins(options),
    reasons: sentinelReasons,
    pixels: options.pixels,
    report: options.report,
  });
}
