import type { RulePage, RuleReport } from './types.js';
import { ObservedOcclusionTracker, observedOcclusionRule } from './observed-occlusion.js';
import { ClippedControlTracker, observedClippingRule } from './observed-clipping.js';
import { TextTruncationTracker, observedTextTruncationRule } from './observed-text-truncation.js';
import { imageAspectRatioRule } from './image-aspect-ratio.js';
import { ImageAspectRatioTracker } from './observed-image-aspect-ratio.js';
import { TextBackgroundTracker, observedTextBackgroundRule } from './observed-text-background.js';
import { imageResourceRule } from './image-resource.js';
import { wantsPixels } from './text-background.js';
import { ImageResourceTracker } from './observed-image-resource.js';
import { HorizontalOverflowTracker, horizontalOverflowRule } from './horizontal-overflow.js';

export interface RulePluginInfo {
  id: string;
  version: string;
  name: string;
  description: string;
  effects: 'read-history';
}
/** One rule with cross-capture history. A fresh instance consumes one crawl's pages in sequence. */
export interface RulePlugin extends RulePluginInfo {
  create(): { run(page: RulePage): Promise<RuleReport> };
  /** Passive/bound DOM rules also inspect swept views with no interactive controls. */
  sweepTargets?: 'controls' | 'dom';
  /**
   * Whether a screenshot of this capture would let the rule decide something it otherwise cannot.
   * Run on the capture before any screenshot exists, so it must be cheap and read only the DOM.
   */
  wantsPixels?(page: RulePage): boolean;
}

export const builtinRulePlugins: readonly RulePlugin[] = [
  {
    ...observedOcclusionRule,
    name: '控件遮盖',
    description: '检查点击采样点是否被遮挡，结合探索记录复核。',
    create: () => new ObservedOcclusionTracker(),
  },
  {
    ...observedClippingRule,
    name: '控件裁切',
    description: '检查控件边界是否被容器裁切，区分可滚动范围。',
    create: () => new ClippedControlTracker(),
  },
  {
    ...observedTextTruncationRule,
    name: '文字截断',
    description: '检查控件文字的裁切与省略；省略号本身不判为错误。',
    create: () => new TextTruncationTracker(),
  },
  {
    ...imageAspectRatioRule,
    effects: 'read-history',
    name: '图片拉伸',
    description: '检查图片是否被非等比拉伸，区分等比裁切与明确允许的变形。',
    create: () => new ImageAspectRatioTracker(),
  },
  {
    ...observedTextBackgroundRule,
    name: '文字与背景同色',
    description: '检查控件文字是否与纯色背景相同；复杂绘制单独标明范围限制。',
    create: () => new TextBackgroundTracker(),
    wantsPixels: page => wantsPixels(page),
  },
  {
    ...imageResourceRule,
    effects: 'read-history',
    name: '图片资源加载',
    description: '区分原生加载失败、加载中和未配置资源；替代图是否合理另行判断。',
    create: () => new ImageResourceTracker(),
  },
  {
    ...horizontalOverflowRule,
    name: '横向溢出',
    description: '检查页面能否被横向滑动、内容是否超出左侧无法到达，或被不能滚动的容器裁掉；只读布局，不滚动。',
    create: () => new HorizontalOverflowTracker(),
  },
];
