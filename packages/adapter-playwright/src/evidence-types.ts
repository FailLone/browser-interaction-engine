import type { Gap, Json, Rect } from './types.js';

export interface EvidenceOptions {
  enabled: boolean; maxNodes: number; maxTextLength: number; maxHtmlLength: number; maxDomCharacters: number;
  maxAttributeLength: number; maxRuntimeEntries: number; styles: 'none' | 'essential' | 'all';
  accessibility: boolean; fullPageScreenshot: boolean;
}
export interface DomNodeEvidence {
  id: string; parentId?: string; children: string[]; nodeType: 'element' | 'text';
  tag?: string; text?: string; attributes?: Record<string, string>; rect?: Rect;
  styles?: Record<string, string>; properties?: Record<string, Json>;
  relations?: Record<string, string[]>;
  gaps: Gap[];
}
export interface DomEvidence {
  documentId: string; capturedAt: string; rootId?: string; nodes: DomNodeEvidence[];
  html: string; htmlTruncated: boolean; nodesTruncated: boolean; gaps: Gap[];
  regionRoots: Record<string, string>;
  page: { url: string; title: string; baseURI: string; language: string; characterSet: string; readyState: string; doctype: string; activeNodeId?: string; metadata: Record<string, string>[] };
}
export interface NetworkEvidence {
  id: string; url: string; method: string; resourceType: string; startedAt: string;
  finishedAt?: string; status?: number; statusText?: string; contentType?: string; failure?: string;
  redirectedFrom?: string;
}
export interface ConsoleEvidence { at: string; type: string; text: string; location?: { url: string; lineNumber: number; columnNumber: number } }
export interface RuntimeEvidence {
  since: string; capturedAt: string; network: NetworkEvidence[]; console: ConsoleEvidence[];
  errors: { at: string; message: string; stack?: string }[];
  dropped: { network: number; console: number; errors: number };
  truncatedFields: number;
  frames: { url: string; name: string; main: boolean; parentUrl?: string }[];
}
export interface DetailSnapshot {
  schemaVersion: 1; observationId: string; documentId: string;
  dom?: DomEvidence;
  accessibility: { status: 'captured' | 'disabled' | 'unavailable'; capturedAt?: string; format: 'playwright-aria-yaml'; text?: string; truncated?: boolean; gaps: Gap[] };
  runtime: RuntimeEvidence;
  gaps: Gap[];
  limits: EvidenceOptions;
  semantics: { businessIntent: 'not_inferred'; textTrust: 'page_content'; execution: 'inert_evidence'; consistency: 'components_have_individual_timestamps' };
}
export interface EvidenceArtifact { key: string; mediaType: string; capturedAt: string; bytes: number; sha256: string }
export interface BrowserEvidenceManifest {
  schemaVersion: 1; status: 'captured' | 'partial' | 'disabled';
  artifacts: { details?: EvidenceArtifact; screenshot?: EvidenceArtifact; fullPageScreenshot?: EvidenceArtifact };
  gaps: Gap[];
}
export const evidenceCapabilities = {
  version: 1,
  stored: ['page-metadata', 'controls', 'text', 'dom-tree', 'html', 'attributes', 'live-properties', 'label-and-aria-relations', 'computed-styles', 'viewport-screenshot', 'aria-snapshot', 'network-metadata', 'console', 'page-errors', 'frame-inventory'],
  optional: ['full-page-screenshot', 'all-computed-styles'],
  unsupported: ['shadow-dom-contents', 'iframe-dom', 'javascript-heap', 'complete-event-listeners', 'network-bodies', 'business-intent-inference'],
  queriesChangePage: false,
} as const;
