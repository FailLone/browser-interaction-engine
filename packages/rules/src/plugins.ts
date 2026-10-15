import type { Inspection } from '@interaction/browser';
import type { CaptureReader, RuleReport } from './types.js';
import { ObservedOcclusionTracker, observedOcclusionRule } from './observed-occlusion.js';
import { ClippedControlTracker, observedClippingRule } from './observed-clipping.js';
import { TextTruncationTracker, observedTextTruncationRule } from './observed-text-truncation.js';

export interface RulePluginInfo {
  id: string;
  version: string;
  name: string;
  description: string;
  effects: 'read-history';
}
/** Trusted, installed host code. A fresh instance consumes one session in sequence. */
export interface RulePlugin extends RulePluginInfo {
  create(): { run(reader: CaptureReader, inspection: Inspection): Promise<RuleReport> };
}
export interface RulePluginSelection { id: string; version: string }
export interface RulePluginRunRequest { requestId: string; plugins: RulePluginSelection[] }
export type RulePluginResult = {
  plugin: RulePluginInfo;
} & ({ status: 'completed'; report: RuleReport; targetLabels: Record<string, string> } | { status: 'failed'; error: string });
export interface RulePluginRun {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  inspectionId: string;
  captureId: string;
  request: RulePluginRunRequest;
  startedAt: string;
  completedAt: string;
  history: { count: number; firstSequence: number; lastSequence: number };
  results: RulePluginResult[];
  origin?: 'manual' | 'automatic';
  automationRevision?: number;
}

export interface RuleAutomationInput { enabled: boolean; plugins: RulePluginSelection[] }
export interface RuleAutomation extends RuleAutomationInput {
  id: string;
  sessionId: string;
  revision: number;
  status: 'watching' | 'checking' | 'paused' | 'failed';
  completedCount: number;
  lastSequence: number;
  updatedAt: string;
  error?: string;
}
export interface RuleRunSummary {
  inspectionId: string;
  sequence: number;
  errors: number;
  warnings: number;
  unknown: number;
  failedPlugins: number;
  runId: string;
  origin?: 'manual' | 'automatic';
}

export const builtinRulePlugins: readonly RulePlugin[] = [
  { ...observedOcclusionRule, name: '控件遮盖', description: '检查点击采样点是否被遮挡，结合探索记录复核。', create: () => new ObservedOcclusionTracker() },
  { ...observedClippingRule, name: '控件裁切', description: '检查控件边界是否被容器裁切，区分可滚动范围。', create: () => new ClippedControlTracker() },
  { ...observedTextTruncationRule, name: '文字截断', description: '检查控件文字的裁切与省略；省略号本身不判为错误。', create: () => new TextTruncationTracker() },
];
