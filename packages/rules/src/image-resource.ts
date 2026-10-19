import { z } from 'zod';
import { canonical } from './util.js';
import type { DomNodeEvidence, Json } from './types.js';
import type { DomRule, DomRuleContext, RuleAssessment } from './types.js';
import { hasRelevantGaps } from './evidence-dependencies.js';

/** Same DOM slot and declared/selected resource, not a claim about file bytes. */
export const imageSourceBindingSchema = z.object({ sourceKey: z.string().min(1).max(20000), currentSrc: z.string().max(20000) }).strict();
export const imageResourceOptionsSchema = z.object({
  requirements: z.array(z.object({
    sessionId: z.string().min(1), documentId: z.string().min(1), nodeId: z.string().min(1), resource: imageSourceBindingSchema,
    kind: z.enum(['no-image-load-error', 'allow-unavailable-image']),
    reason: z.string().trim().min(1), evidence: z.array(z.string().trim().min(1)).min(1),
  }).strict()).max(1000).default([]),
}).strict().refine(o => new Set(o.requirements.map(r => canonical([r.sessionId, r.documentId, r.nodeId, r.resource]))).size === o.requirements.length, 'Each bound image may have one requirement');
export type ImageResourceOptions = z.input<typeof imageResourceOptionsSchema>;
const json = (v: unknown): Json => JSON.parse(JSON.stringify(v));

function assess(context: DomRuleContext, options: z.output<typeof imageResourceOptionsSchema>): RuleAssessment {
  const { node, dom, capture, observation, inspection } = context, image = node.image, resource = image?.resource;
  const facts: Record<string, Json> = { label: node.attributes?.alt || node.attributes?.id || '图片', observationStatus: 'current',
    coverage: 'html-img-resource-state; not-fallback-quality-or-visual-visibility' };
  const result = (verdict: RuleAssessment['verdict'], code: string, actual: string, severity: RuleAssessment['severity'] = 'info'): RuleAssessment => ({
    verdict, severity, code, actual, expected: 'A configured image has no native load error bound to its current source; pending requests are not terminal failures',
    evidence: [capture.id, `node:${capture.documentId}:${node.id}`], facts,
  });
  const unknown = (code: string, actual: string, status = 'unavailable') => { facts.observationStatus = status; return result('unknown', code, actual); };
  const nodes = new Map(dom.nodes.map(n => [n.id, n])), chain: DomNodeEvidence[] = [], seen = new Set<string>();
  for (let n: DomNodeEvidence | undefined = node; n && !seen.has(n.id); n = n.parentId ? nodes.get(n.parentId) : undefined) {
    chain.push(n); seen.add(n.id); if (n.id === dom.rootId) break;
  }
  if (chain.at(-1)?.id !== dom.rootId || chain.some(n => !n.styles || hasRelevantGaps(n))) return unknown('IMAGE_RESOURCE_EVIDENCE_MISSING', 'Source or ancestor evidence is missing or truncated');
  if (inspection.focus.confidence !== 'observed') return unknown('SCOPE_UNKNOWN', 'The active scope has not been established');
  const active = observation.overlays?.at(-1);
  if (active) {
    if (!dom.regionRoots[active.key]) return unknown('IMAGE_RESOURCE_EVIDENCE_MISSING', 'The active overlay root is missing');
    if (!seen.has(dom.regionRoots[active.key])) return result('not-applicable', 'OUTSIDE_ACTIVE_SCOPE', 'The image is outside the active overlay');
  }
  if (chain.some(n => n.styles!.display === 'none' || n.styles!['content-visibility'] === 'hidden') || ['hidden', 'collapse'].includes(node.styles!.visibility)) {
    return result('not-applicable', 'IMAGE_NOT_RENDERED', 'The image is not rendered in the current scope');
  }
  const top = chain.findIndex(n => n.layout?.clipping?.topLayer), effective = top < 0 ? chain : chain.slice(0, top + 1);
  if (effective.some(n => Number(n.styles!.opacity) === 0)) return result('not-applicable', 'IMAGE_NOT_RENDERED', 'The image is in a fully transparent subtree');
  if (effective.some(n => ['display', 'visibility', 'opacity', 'content-visibility'].some(k => n.styles![k] === undefined)) || !node.rect || !Object.values(node.rect).every(Number.isFinite)) {
    return unknown('IMAGE_RESOURCE_EVIDENCE_MISSING', 'Required rendering evidence is missing');
  }
  if (node.rect.width <= 0 || node.rect.height <= 0) return result('not-applicable', 'IMAGE_NOT_RENDERED', 'The image has no positive-area element box');
  if (!['normal', 'none'].includes(node.styles!.content ?? '') || effective.some(n => n.styles!['content-visibility'] !== 'visible')) {
    return unknown('IMAGE_RESOURCE_RENDERING_UNSUPPORTED', 'CSS replaced content or skipped rendering requires a separate assessment', 'unsupported');
  }
  if (!image || image.version !== 1 || !resource || resource.version !== 1 || !resource.sourceKey ||
    !['load', 'error', 'unobserved'].includes(resource.event) || !Number.isInteger(resource.eventSequence) || resource.eventSequence < 0 ||
    (resource.event === 'unobserved' ? resource.eventSequence !== 0 : resource.eventSequence === 0) ||
    typeof image.complete !== 'boolean' || typeof resource.hasSource !== 'boolean' || typeof image.currentSrc !== 'string' ||
    ![image.naturalWidth, image.naturalHeight].every(n => Number.isFinite(n) && n >= 0)) {
    return unknown('IMAGE_RESOURCE_EVIDENCE_MISSING', 'Bound native resource-event metadata or image state is unavailable');
  }
  const binding = { currentSrc: image.currentSrc, sourceKey: resource.sourceKey };
  Object.assign(facts, { resource: json(binding), event: resource.event, eventSequence: resource.eventSequence,
    complete: image.complete, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
    loading: node.attributes?.loading ?? 'eager', alt: node.attributes?.alt ?? null, hasSource: resource.hasSource });
  const requirement = options.requirements.find(r => r.sessionId === inspection.sessionId && r.documentId === capture.documentId && r.nodeId === node.id && canonical(r.resource) === canonical(binding));
  if (requirement) facts.requirement = json(requirement);
  const finish = (assessment: RuleAssessment) => { if (requirement) assessment.evidence.push(...requirement.evidence); return assessment; };
  if (requirement?.kind === 'allow-unavailable-image') return finish(result('not-applicable', 'IMAGE_UNAVAILABILITY_ALLOWED', 'An explicit bound host requirement permits this unavailable image'));
  if (!resource.hasSource && !image.currentSrc) return result('not-applicable', 'IMAGE_SOURCE_ABSENT', 'No image source is configured; whether an image or fallback is required is unspecified');
  if (!image.complete) return unknown('IMAGE_RESOURCE_PENDING', 'The browser has an unfinished or deferred image request; no deadline or failure is inferred', 'current');
  if (resource.event === 'error' && image.naturalWidth === 0 && image.naturalHeight === 0) {
    return finish(result(requirement ? 'fail' : 'unknown', requirement ? 'IMAGE_RESOURCE_REQUIREMENT_FAILED' : 'IMAGE_RESOURCE_LOAD_FAILED',
      'A native error event matches the current source declarations and selected URL, and the completed image has no intrinsic dimensions; fallback adequacy is not assessed', requirement ? 'error' : 'warning'));
  }
  if (resource.event === 'error') return unknown('IMAGE_RESOURCE_STATE_UNCERTAIN', 'The native event and current intrinsic dimensions conflict');
  if (image.currentSrc && (resource.event === 'load' || (image.naturalWidth > 0 && image.naturalHeight > 0))) {
    return result('pass', 'IMAGE_RESOURCE_AVAILABLE', 'The image resource is available; this does not certify correct identity, fallback quality, visibility or image quality');
  }
  return unknown('IMAGE_RESOURCE_STATE_UNCERTAIN', 'Complete/zero dimensions alone cannot distinguish a broken request from an image without useful intrinsic dimensions');
}

export const imageResourceRule: DomRule = {
  id: 'image-resource', version: '1.0.0', name: 'Image resource state', targetKind: 'dom-element', targetTags: ['img'],
  description: 'Check bound native image load state from captures. Missing sources and pending requests are distinct from load errors; no retries or fallback judgments.',
  requiredCapabilities: ['web.dom', 'web.layout', 'web.styles'],
  optionsSchema: z.record(z.string(), z.json()).parse(z.toJSONSchema(imageResourceOptionsSchema)),
  configure: input => { const options = imageResourceOptionsSchema.parse(input); return context => assess(context, options); },
};
