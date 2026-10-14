import type { Control as CoreControl, Observation as CoreObservation, Session as CoreSession, EngineHooks as CoreHooks, HookContext as CoreHookContext, ControlIdentity as CoreIdentity } from '@interaction/core';
import type { ID, Context, ActionKind, ActionBasis, ActionEvidence, Gap, Json } from '@interaction/core';
import type { BrowserEvidenceManifest, EvidenceOptions } from './evidence-types.js';
export * from './evidence-types.js';
export * from '@interaction/core';
export interface Rect { x: number; y: number; width: number; height: number }
export interface Region { key: string; label: string; role: string; selector: string; parentKey?: string; rect: Rect; text: string }
export interface Overlay { key: string; name: string; kind: 'modal' | 'dialog' | 'popover' | 'menu' | 'listbox'; selector: string; parentKey?: string; parentRegion: string; evidence: string[]; controlIds: string[]; exitControlIds: string[] }
/** Browser navigation evidence; not a claim that the page/business state is equal. */
export interface BrowserHistory {
  browserSessionId: string; currentIndex: number;
  entries: { id: number; url: string; method?: string }[];
}
export interface Control extends CoreControl {
  localId: ID; instanceId: ID; identityId?: ID; hypothesisId?: ID;
  tag: string; role: string; name: string; label: string; stableKey?: string;
  region: string; form: string; selector: string; rect: Rect;
  value: string; displayedText: string; checked: boolean | null; selected: string[];
  visible: boolean; enabled: boolean; editable: boolean; readOnly?: boolean;
  expanded: boolean | null; controls: string | null;
  constraints: { type: string; required: boolean; min?: string; max?: string; step?: string; pattern?: string; minLength?: number; maxLength?: number; valid: boolean };
  options: { value: string; label: string; disabled: boolean }[];
  actions: ActionKind[]; discovery: string[];
  /** Native element scroll viewport; document scrolling is recorded separately. */
  scroll?: { x: number; y: number; maxX: number; maxY: number; width: number; height: number };
  /** Keyed by action kind. Optional only for observations written by older adapters. */
  actionBasis?: Record<ActionKind, ActionBasis>;
  interactionHints?: ActionEvidence[];
  actionable: { visible: boolean; enabled: boolean; editable: boolean; hitTarget: boolean | null; clickPoint?: { x: number; y: number }; occludedBy?: string; outsideScrollableArea?: boolean; unknown: string[] };
}
export interface Observation extends CoreObservation<Control> {
  id: ID; sessionId: ID; capturedAt: string; screenshotAt?: string;
  url: string; title: string; text: string; viewport: { width: number; height: number }; scroll: { x: number; y: number; maxY: number };
  documentId: string; controls: Control[]; regions: Region[]; context: Context;
  overlays?: Overlay[];
  navigation?: BrowserHistory;
  actionDiscovery?: { version: 'dom-actions-v2'; documentHints: ActionEvidence[] };
  screenshot?: string; gaps: Gap[]; stable: boolean;
  evidence?: BrowserEvidenceManifest;
  stateId: ID; visitId: ID; fingerprint: string; canonical: string; ruleVersion: 'observable-v1' | 'observable-v2' | 'observable-v3';
  cause: 'initial' | 'action' | 'inspection' | 'recovery' | 'external';
}
export interface ContextRule { key: string; selector: string; attribute?: string; required?: boolean }
export interface MatchRule { role?: string; name?: string; stableKey?: string; kind?: ActionKind; urlIncludes?: string }
export interface SessionOptions {
  url: string; headless: boolean; viewport: { width: number; height: number };
  maxActions: number; maxDepth: number; maxDurationMs: number;
  actionTimeoutMs: number; settleMs: number; observeTimeoutMs: number;
  evidence: EvidenceOptions;
  inspection?: import('./inspection-contract.js').InspectionOptions;
  evidenceRetention?: import('@interaction/core').EvidenceRetentionPolicy;
  exclude: MatchRule[]; replayable: MatchRule[]; context: Record<string, Json>; contextRules: ContextRule[];
  exploration?: 'controls' | 'representative' | 'stateful';
  /** Application declarations; never inferred from button labels. */
  interfaceActions?: MatchRule[];
  reversible?: MatchRule[];
  /** Caller asserts all relevant business state lives in this document. */
  environmentReset?: 'none' | 'document-reload';
  storageState?: string | { cookies: unknown[]; origins: unknown[] };
}

export type Session = CoreSession<SessionOptions>;
export type ControlIdentity = CoreIdentity<Control>;
export type HookContext = CoreHookContext<Observation, SessionOptions>;
export interface EngineHooks extends CoreHooks<Observation, SessionOptions> {
  samples?: (control: Control, ctx: HookContext) => Promise<(string | boolean)[] | undefined> | (string | boolean)[] | undefined;
}
