import type {
  Control as CrawlControl,
  DomEvidence,
  DomNodeEvidence,
  Json,
  Overlay,
  RuntimeEvidence,
} from '@interaction/crawler';
export type { DomEvidence, DomNodeEvidence, Json, Rect } from '@interaction/crawler';

/**
 * Rules read one frozen page capture. These shapes are what the crawler plugin builds from a
 * detailed capture; field names follow the original inspection protocol so rule logic and
 * reports stay unchanged.
 */
export interface Control extends CrawlControl {
  /** Same logical control across states in one crawl (the crawler's component class). */
  identityId?: string;
  /** Set when the control's identity is ambiguous; rules then skip cross-state history. */
  hypothesisId?: string;
}
export interface Observation {
  id: string;
  documentId: string;
  url: string;
  stable: boolean;
  context: Record<string, Json>;
  controls: Control[];
  overlays?: Overlay[];
  boundaries?: { key: string; name: string }[];
}
export interface Capture {
  id: string;
  sessionId: string;
  observationId: string;
  documentId: string;
  capturedAt: string;
  quality: { status: 'complete' | 'incomplete'; missingRequired: string[] };
}
export interface Inspection {
  id: string;
  sessionId: string;
  captureId: string;
  observationId: string;
  sequence: number;
  protocolVersion: 1;
  focus: { regionKey: string; scopeId?: string; kind: 'document' | 'overlay'; confidence: 'observed' | 'unknown' };
}
export interface DetailSnapshot {
  observationId: string;
  documentId: string;
  dom?: DomEvidence;
  runtime: RuntimeEvidence;
}
/** One capture as rules read it. */
export interface RulePage {
  inspection: Inspection;
  capture: Capture;
  observation: Observation;
  snapshot: DetailSnapshot;
}

export type RuleVerdict = 'pass' | 'fail' | 'unknown' | 'not-applicable';
export type RuleSeverity = 'info' | 'warning' | 'error';
export interface RuleAssessment {
  verdict: RuleVerdict;
  severity: RuleSeverity;
  code: string;
  expected: string;
  actual: string;
  evidence: string[];
  facts?: Record<string, Json>;
  nextSteps?: string[];
}
export interface DomRuleContext {
  readonly inspection: Inspection;
  readonly capture: Capture;
  readonly observation: Observation;
  readonly dom: DomEvidence;
  readonly snapshot: DetailSnapshot;
  readonly node: DomNodeEvidence;
  readonly signal: AbortSignal;
}
export interface RuleContext extends DomRuleContext {
  readonly control: Control;
}
export interface RuleMetadata {
  id: string;
  version: string;
  name: string;
  description: string;
  requiredCapabilities: string[];
  /** JSON Schema for config/agent discovery; configure() remains the validator. */
  optionsSchema?: Record<string, Json>;
  targetKind?: 'control' | 'dom-element';
  targetTags?: string[];
}
/** Trusted host code only. Context contains frozen historical facts, never a live page. */
export interface ControlRule extends RuleMetadata {
  targetKind?: 'control';
  configure(options: unknown): (context: RuleContext) => RuleAssessment | Promise<RuleAssessment>;
}
/** Passive DOM targets such as images need not be interactive controls. */
export interface DomRule extends RuleMetadata {
  targetKind: 'dom-element';
  targetTags: string[];
  configure(options: unknown): (context: DomRuleContext) => RuleAssessment | Promise<RuleAssessment>;
}
export interface RuleSelection {
  ruleId: string;
  ruleVersion: string;
  enabled?: boolean;
  options?: Record<string, Json>;
  /** Omit to inspect the rule's default targets. An explicit empty list selects none. */
  targets?: { captureId: string; nodeId: string }[];
}
export interface RuleCheck extends RuleAssessment {
  target?: { captureId: string; documentId: string; nodeId: string };
}
export interface RuleReport {
  schemaVersion: 1;
  inspectionId: string;
  captureId: string;
  documentId: string;
  ruleId: string;
  ruleVersion: string;
  selection: RuleSelection;
  verdict: RuleVerdict;
  severity: RuleSeverity;
  checks: RuleCheck[];
}
