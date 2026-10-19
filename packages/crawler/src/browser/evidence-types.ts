import type { Gap, Json, Rect } from './types.js';

export interface EvidenceOptions {
  enabled: boolean;
  maxNodes: number;
  maxTextLength: number;
  maxHtmlLength: number;
  maxDomCharacters: number;
  maxAttributeLength: number;
  maxRuntimeEntries: number;
  styles: 'none' | 'essential' | 'all';
  accessibility: boolean;
  fullPageScreenshot: boolean;
}
export interface LayoutEvidence {
  coordinateSpace: 'layout-viewport-css-px';
  /** Additive geometry evidence; absence in historical captures means unverified. */
  clipping?: { version: 1; topLayer: boolean; fragmentCount: number };
  client: { width: number; height: number; left: number; top: number };
  scroll: { width: number; height: number; left: number; top: number };
  offset?: { width: number; height: number; left: number; top: number; parentId?: string };
  box: { padding: string[]; border: string[]; margin: string[] };
  scrollAncestorIds: string[];
  clipAncestorIds: string[];
  hitSample?: { x: number; y: number; topNodeId?: string; withinSubtree: boolean };
  /** Center plus four inset corners; sampled pointer reachability, not pixel occlusion. */
  hitSamples?: { x: number; y: number; topNodeId?: string; withinSubtree: boolean }[];
}
export interface PageEnvironment {
  layoutViewport: { width: number; height: number; clientWidth: number; clientHeight: number };
  visualViewport?: {
    width: number;
    height: number;
    offsetLeft: number;
    offsetTop: number;
    pageLeft: number;
    pageTop: number;
    scale: number;
  };
  scroll: { x: number; y: number };
  devicePixelRatio: number;
  scrollingElement?: {
    nodeId: string;
    clientWidth: number;
    clientHeight: number;
    scrollWidth: number;
    scrollHeight: number;
    scrollLeft: number;
    scrollTop: number;
  };
  coordinateSpace: 'layout-viewport-css-px';
  zoom: 'visual-viewport-scale-and-dpr-only';
}
export interface DomNodeEvidence {
  id: string;
  parentId?: string;
  children: string[];
  nodeType: 'element' | 'text';
  tag?: string;
  text?: string;
  attributes?: Record<string, string>;
  rect?: Rect;
  styles?: Record<string, string>;
  properties?: Record<string, Json>;
  layout?: LayoutEvidence;
  paint?: { version: 1; motion: 'running' | 'idle'; pseudoElements: { kind: 'before' | 'after'; position: string }[] };
  /** Browser intrinsic dimensions are density-corrected CSS px, not file pixels. */
  image?: {
    version: 1;
    currentSrc: string;
    complete: boolean;
    naturalWidth: number;
    naturalHeight: number;
    loadEpoch: number;
    resource?: {
      version: 1;
      sourceKey: string;
      hasSource: boolean;
      event: 'load' | 'error' | 'unobserved';
      eventSequence: number;
    };
    contentBox?: { width: number; height: number };
    motion: 'running' | 'idle';
  };
  /** Range boxes of non-whitespace DOM text; layout evidence, not painted glyphs. */
  textLayout?: {
    version: 1;
    status: 'captured' | 'truncated' | 'unavailable' | 'skipped';
    start: number;
    end: number;
    rects: Rect[];
    reason?: string;
  };
  relations?: Record<string, string[]>;
  gaps: Gap[];
}
export interface DomEvidence {
  documentId: string;
  capturedAt: string;
  rootId?: string;
  nodes: DomNodeEvidence[];
  html: string;
  htmlTruncated: boolean;
  nodesTruncated: boolean;
  gaps: Gap[];
  regionRoots: Record<string, string>;
  spatialVersion?: 1;
  environment?: PageEnvironment;
  paintEnvironment?: { version: 1; forcedColors: boolean };
  textGeometry?: {
    version: 1;
    coordinateSpace: 'layout-viewport-css-px';
    fonts: 'loaded' | 'loading' | 'unavailable';
    maxFragments: number;
    maxFragmentsPerNode: number;
    fragments: number;
    truncated: boolean;
  };
  page: {
    url: string;
    title: string;
    baseURI: string;
    language: string;
    characterSet: string;
    readyState: string;
    doctype: string;
    activeNodeId?: string;
    metadata: Record<string, string>[];
  };
}
export interface NetworkEvidence {
  id: string;
  url: string;
  method: string;
  resourceType: string;
  startedAt: string;
  finishedAt?: string;
  status?: number;
  statusText?: string;
  contentType?: string;
  failure?: string;
  redirectedFrom?: string;
}
export interface ConsoleEvidence {
  at: string;
  type: string;
  text: string;
  location?: { url: string; lineNumber: number; columnNumber: number };
}
export interface RuntimeEvidence {
  since: string;
  capturedAt: string;
  network: NetworkEvidence[];
  console: ConsoleEvidence[];
  errors: { at: string; message: string; stack?: string }[];
  dropped: { network: number; console: number; errors: number };
  truncatedFields: number;
  frames: { url: string; name: string; main: boolean; parentUrl?: string }[];
}
export interface DetailSnapshot {
  schemaVersion: 1;
  observationId: string;
  documentId: string;
  dom?: DomEvidence;
  accessibility: {
    status: 'captured' | 'disabled' | 'unavailable';
    capturedAt?: string;
    format: 'playwright-aria-yaml';
    text?: string;
    truncated?: boolean;
    gaps: Gap[];
  };
  runtime: RuntimeEvidence;
  gaps: Gap[];
  limits: EvidenceOptions;
  semantics: {
    businessIntent: 'not_inferred';
    textTrust: 'page_content';
    execution: 'inert_evidence';
    consistency: 'components_have_individual_timestamps';
  };
}
export interface EvidenceArtifact {
  key: string;
  mediaType: string;
  capturedAt: string;
  bytes: number;
  sha256: string;
}
export interface BrowserEvidenceManifest {
  schemaVersion: 1;
  status: 'captured' | 'partial' | 'disabled';
  artifacts: { details?: EvidenceArtifact; screenshot?: EvidenceArtifact; fullPageScreenshot?: EvidenceArtifact };
  gaps: Gap[];
}
export const evidenceCapabilities = {
  version: 1,
  stored: [
    'page-metadata',
    'controls',
    'component-groups',
    'text',
    'dom-tree',
    'html',
    'attributes',
    'live-properties',
    'label-and-aria-relations',
    'computed-styles',
    'page-environment',
    'box-and-scroll-metrics',
    'ancestor-chains',
    'sampled-hit-targets',
    'viewport-screenshot',
    'aria-snapshot',
    'network-metadata',
    'console',
    'page-errors',
    'frame-inventory',
  ],
  optional: ['full-page-screenshot', 'all-computed-styles'],
  textGeometry: {
    version: 1,
    kind: 'bounded-dom-text-range-boxes',
    maxFragments: 4096,
    maxFragmentsPerNode: 128,
    paintedGlyphs: false,
  },
  imageGeometry: { version: 1, kind: 'html-image-intrinsic-and-content-box', pixelAnalysis: false },
  imageResource: { version: 1, kind: 'native-image-events-and-source-binding', activeRequests: false },
  textPaint: { version: 1, kind: 'computed-colors-and-paint-guards', pixelAnalysis: false },
  unsupported: [
    'shadow-dom-contents',
    'iframe-dom',
    'javascript-heap',
    'complete-event-listeners',
    'network-bodies',
    'business-intent-inference',
  ],
  queriesChangePage: false,
  explicitProbes: ['hover', 'focus', 'scroll'],
  probeEffects: 'unknown',
} as const;
