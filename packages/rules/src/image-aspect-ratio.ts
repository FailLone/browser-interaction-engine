import { z } from 'zod';
import type { DomNodeEvidence, Json } from './types.js';
import type { DomRule, DomRuleContext, RuleAssessment } from './types.js';
import { hasRelevantGaps } from './evidence-dependencies.js';

export const imageResourceBindingSchema = z.object({
  currentSrc: z.string().min(1).max(16000), naturalWidth: z.number().positive(), naturalHeight: z.number().positive(),
  loadEpoch: z.number().int().nonnegative(),
}).strict();
export const imageAspectRatioOptionsSchema = z.object({
  /** Measurement tolerance, not a product-design requirement. */
  relativeTolerance: z.number().min(0).max(.25).default(.02),
  requirements: z.array(z.object({
    sessionId: z.string().min(1), documentId: z.string().min(1), nodeId: z.string().min(1),
    resource: imageResourceBindingSchema,
    kind: z.enum(['preserve-aspect-ratio', 'allow-distortion']),
    reason: z.string().trim().min(1), evidence: z.array(z.string().trim().min(1)).min(1),
  }).strict()).max(1000).default([]),
}).strict().refine(o => new Set(o.requirements.map(r => JSON.stringify([r.sessionId, r.documentId, r.nodeId, r.resource]))).size === o.requirements.length, 'Each bound image may have one requirement');
export type ImageAspectRatioOptions = z.input<typeof imageAspectRatioOptionsSchema>;
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value));
type Matrix = [number, number, number, number];
const identity = (): Matrix => [1, 0, 0, 1];
const multiply = ([a, b, c, d]: Matrix, [e, f, g, h]: Matrix): Matrix => [a * e + c * f, b * e + d * f, a * g + c * h, b * g + d * h];
function matrix(value: string): Matrix | undefined {
  if (value === 'none') return identity();
  const match = /^matrix\(([^)]+)\)$/.exec(value);
  const parts = match?.[1].split(',').map(Number);
  return parts?.length === 6 && parts.every(Number.isFinite) ? parts.slice(0, 4) as Matrix : undefined;
}
function stretchRatio(m: Matrix): number {
  // Singular-value ratio detects shear as well as axis stretching, while pure
  // rotation/reflection and mutually cancelling ancestor transforms stay equal.
  const size = Math.max(...m.map(Math.abs));
  if (!size || !Number.isFinite(size)) return NaN;
  const [a, b, c, d] = m.map(v => v / size);
  const trace = a * a + b * b + c * c + d * d, determinant = (a * d - b * c) ** 2;
  const largest = (trace + Math.sqrt(Math.max(0, trace * trace - 4 * determinant))) / 2;
  return determinant > 0 ? largest / Math.sqrt(determinant) : NaN;
}

function assess(context: DomRuleContext, options: z.output<typeof imageAspectRatioOptionsSchema>): RuleAssessment {
  const { node, dom, capture, observation, inspection, snapshot } = context;
  const image = node.image;
  const facts: Record<string, Json> = { observationStatus: 'current', coverage: 'raster-layout-scaling-only',
    label: node.attributes?.alt || node.attributes?.id || '图片', relativeTolerance: options.relativeTolerance,
    ...(image ? { resource: json({ currentSrc: image.currentSrc, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, loadEpoch: image.loadEpoch }) } : {}) };
  const result = (verdict: RuleAssessment['verdict'], code: string, actual: string, severity: RuleAssessment['severity'] = 'info'): RuleAssessment => ({
    verdict, severity, code, expected: 'The captured raster image is scaled equally in every direction within the configured tolerance',
    actual, evidence: [capture.id, `node:${capture.documentId}:${node.id}`], facts,
  });
  const unknown = (code: string, actual: string, status = 'unavailable') => {
    facts.observationStatus = status;
    return result('unknown', code, actual);
  };
  const nodes = new Map(dom.nodes.map(n => [n.id, n])), chain: DomNodeEvidence[] = [], seen = new Set<string>();
  for (let n: DomNodeEvidence | undefined = node; n; n = n.parentId ? nodes.get(n.parentId) : undefined) {
    if (seen.has(n.id)) return unknown('IMAGE_EVIDENCE_UNAVAILABLE', 'The ancestor chain contains a cycle');
    chain.push(n); seen.add(n.id); if (n.id === dom.rootId) break;
  }
  if (chain.at(-1)?.id !== dom.rootId) return unknown('IMAGE_EVIDENCE_UNAVAILABLE', 'A required ancestor is missing');
  if (inspection.focus.confidence !== 'observed') return unknown('SCOPE_UNKNOWN', 'The active scope has not been established');
  const active = observation.overlays?.at(-1);
  if (active) {
    const rootId = dom.regionRoots[active.key];
    if (!rootId) return unknown('IMAGE_EVIDENCE_UNAVAILABLE', 'The active overlay root was not captured');
    if (!seen.has(rootId)) return result('not-applicable', 'OUTSIDE_ACTIVE_SCOPE', 'The image is outside the active overlay');
  }
  if (chain.some(n => n.styles?.display === 'none' || n.styles?.['content-visibility'] === 'hidden') || node.styles?.visibility === 'hidden' || node.styles?.visibility === 'collapse') {
    return result('not-applicable', 'IMAGE_NOT_RENDERED', 'The image has no currently rendered content');
  }
  if (!image || image.version !== 1 || !Number.isInteger(image.loadEpoch) || image.loadEpoch < 0 || !node.rect || !node.layout?.clipping || chain.some(n => !n.styles || hasRelevantGaps(n))) {
    return unknown('IMAGE_EVIDENCE_UNAVAILABLE', 'Image metrics, styles or ancestor evidence is missing or truncated');
  }
  if (!image.complete) return unknown('IMAGE_LOADING', 'The captured image has not finished loading');
  if (!image.currentSrc || ![image.naturalWidth, image.naturalHeight].every(v => Number.isFinite(v) && v > 0)) {
    return unknown('IMAGE_RESOURCE_UNAVAILABLE', 'No loaded image with finite intrinsic dimensions was captured');
  }
  if (image.motion !== 'idle') return unknown('IMAGE_MOTION_UNSETTLED', 'An image or ancestor animation was running at capture time');
  const box = image.contentBox;
  if (!box || ![box.width, box.height, node.rect.width, node.rect.height].every(Number.isFinite)) return unknown('IMAGE_EVIDENCE_UNAVAILABLE', 'The used content box is unavailable');
  if (box.width <= 0 || box.height <= 0 || node.rect.width <= 0 || node.rect.height <= 0) return result('not-applicable', 'IMAGE_NOT_RENDERED', 'The image has no positive-area content box');
  // SVG can apply its own preserveAspectRatio inside an img. Neither an URL
  // extension nor its outer dimensions prove raster stretching.
  const network = snapshot.runtime.network.filter(n => n.url === image.currentSrc && n.resourceType === 'image').at(-1);
  const mime = (/^data:([^;,]+)/i.exec(image.currentSrc)?.[1] ?? network?.contentType?.split(';')[0] ?? '').trim().toLowerCase();
  facts.resourceMimeType = mime || null;
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon'].includes(mime)) {
    return unknown('IMAGE_FORMAT_UNSUPPORTED', 'Vector or untyped resources require additional rendering evidence', 'unsupported');
  }
  const top = chain.findIndex(n => n.layout?.clipping?.topLayer);
  const effective = top < 0 ? chain : chain.slice(0, top + 1);
  let transform = identity();
  for (const n of effective) {
    const s = n.styles!;
    if (!n.layout?.offset) return unknown('IMAGE_RENDERING_UNSUPPORTED', 'Non-HTML ancestor coordinate systems require additional evidence', 'unsupported');
    const required = ['transform', 'translate', 'rotate', 'scale', 'perspective', 'zoom', 'filter', 'content-visibility', 'opacity', 'offset-path'];
    if (required.some(k => s[k] === undefined)) return unknown('IMAGE_EVIDENCE_UNAVAILABLE', 'Required ancestor rendering styles were not captured');
    if (Number(s.opacity) === 0) return result('not-applicable', 'IMAGE_NOT_RENDERED', 'The image is in a fully transparent subtree');
    const m = matrix(s.transform);
    if (!m || s.rotate !== 'none' || s.scale !== 'none' || s.perspective !== 'none' || s.filter !== 'none' || s['offset-path'] !== 'none' ||
      s['content-visibility'] !== 'visible' || !(s.zoom === 'normal' || Number(s.zoom) > 0) || (n.layout?.clipping?.fragmentCount ?? 1) > 1) {
      return unknown('IMAGE_RENDERING_UNSUPPORTED', '3D, independent rotate/scale, filters or skipped/fragmented layout need additional evidence', 'unsupported');
    }
    transform = multiply(m, transform);
  }
  if (!['normal', 'none'].includes(node.styles!.content ?? '')) return unknown('IMAGE_RENDERING_UNSUPPORTED', 'CSS replaced content may differ from the selected image resource', 'unsupported');
  if (node.styles!['image-orientation'] !== 'from-image' || !['', 'none'].includes(node.styles!['object-view-box'] ?? 'missing')) {
    return unknown('IMAGE_RENDERING_UNSUPPORTED', 'Overridden image orientation or source view-box needs additional resource geometry', 'unsupported');
  }
  const fit = node.styles!['object-fit'];
  let sx = box.width / image.naturalWidth, sy = box.height / image.naturalHeight;
  if (fit === 'contain') sx = sy = Math.min(sx, sy);
  else if (fit === 'cover') sx = sy = Math.max(sx, sy);
  else if (fit === 'none') sx = sy = 1;
  else if (fit === 'scale-down') sx = sy = Math.min(1, sx, sy);
  else if (fit !== 'fill') return unknown('IMAGE_RENDERING_UNSUPPORTED', 'The object-fit mode is missing or unsupported', 'unsupported');
  const composed = multiply(transform, [sx, 0, 0, sy]), ratio = stretchRatio(composed);
  if (!Number.isFinite(ratio)) return unknown('IMAGE_RENDERING_UNSUPPORTED', 'The composed scaling is degenerate or non-finite', 'unsupported');
  Object.assign(facts, { contentBox: json(box), objectFit: fit, objectPosition: node.styles!['object-position'] ?? null,
    objectSize: { width: image.naturalWidth * sx, height: image.naturalHeight * sy }, transform: json(composed), stretchRatio: ratio });
  const requirement = options.requirements.find(r => r.sessionId === inspection.sessionId && r.documentId === capture.documentId && r.nodeId === node.id &&
    r.resource.currentSrc === image.currentSrc && r.resource.naturalWidth === image.naturalWidth && r.resource.naturalHeight === image.naturalHeight && r.resource.loadEpoch === image.loadEpoch);
  if (requirement) facts.requirement = json(requirement);
  if (requirement?.kind === 'allow-distortion') return result('not-applicable', 'IMAGE_DISTORTION_ALLOWED', 'An explicit bound host requirement permits distortion');
  if (ratio <= 1 + options.relativeTolerance + 1e-9) return result('pass', 'IMAGE_ASPECT_RATIO_PRESERVED', 'The captured scaling preserves shape within tolerance; cropping, visibility and source-file quality are not assessed');
  return result(requirement ? 'fail' : 'unknown', requirement ? 'IMAGE_ASPECT_RATIO_REQUIREMENT_FAILED' : 'IMAGE_NON_UNIFORM_SCALING',
    `The largest and smallest scale factors differ by ${((ratio - 1) * 100).toFixed(2)}%; ${requirement ? 'this violates the explicit preserve-aspect-ratio requirement' : 'whether this distortion is intended has not been specified'}`,
    requirement ? 'error' : 'warning');
}

export const imageAspectRatioRule: DomRule = {
  id: 'image-aspect-ratio', version: '1.0.0', name: 'Raster image aspect ratio', targetKind: 'dom-element', targetTags: ['img'],
  description: 'Measure captured raster image scaling, including object-fit and 2D ancestor transforms. Product intent is explicit; no live page operations.',
  requiredCapabilities: ['web.dom', 'web.layout', 'web.styles', 'web.runtime'],
  optionsSchema: z.record(z.string(), z.json()).parse(z.toJSONSchema(imageAspectRatioOptionsSchema)),
  configure: input => { const options = imageAspectRatioOptionsSchema.parse(input); return context => assess(context, options); },
};
