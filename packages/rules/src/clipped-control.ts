import { hasRelevantGaps } from './evidence-dependencies.js';
import { z } from 'zod';
import type { DomNodeEvidence, Json, Rect } from './types.js';
import type { ControlRule, RuleAssessment, RuleContext } from './types.js';

export const clippedControlOptionsSchema = z
  .object({
    includeDisabled: z.boolean().default(false),
    tolerancePx: z.number().min(0).max(2).default(1),
    /** Explicit host requirements only; provider proposals remain separate data. */
    requirements: z
      .array(
        z
          .object({
            identityId: z.string().min(1),
            kind: z.literal('unclipped-by-nonscroll-container'),
            reason: z.string().trim().min(1),
            evidence: z.array(z.string().trim().min(1)).min(1),
          })
          .strict(),
      )
      .max(1000)
      .default([]),
  })
  .strict()
  .refine(
    o => new Set(o.requirements.map(r => r.identityId)).size === o.requirements.length,
    'Each identity may have one requirement',
  );
export type ClippedControlOptions = z.input<typeof clippedControlOptionsSchema>;

type Bounds = { left: number; top: number; right: number; bottom: number };
const bounds = (r: Rect): Bounds => ({ left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height });
const area = (b: Bounds) => Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
const intersect = (a: Bounds, b: Bounds): Bounds => ({
  left: Math.max(a.left, b.left),
  top: Math.max(a.top, b.top),
  right: Math.min(a.right, b.right),
  bottom: Math.min(a.bottom, b.bottom),
});
const overflow = (v: string) => ['auto', 'scroll', 'hidden', 'clip'].includes(v);
const json = (v: unknown): Json => JSON.parse(JSON.stringify(v));

function assess(context: RuleContext, options: z.output<typeof clippedControlOptionsSchema>): RuleAssessment {
  const { capture, control, node, dom, observation, inspection } = context;
  const evidence = [capture.id, `node:${capture.documentId}:${node.id}`];
  const result = (
    verdict: RuleAssessment['verdict'],
    code: string,
    actual: string,
    extra: Partial<RuleAssessment> = {},
  ): RuleAssessment => ({
    verdict,
    severity: 'info',
    code,
    expected:
      'The control border box fits the captured rectangular clipping bounds; text and pixel visibility are outside this rule',
    actual,
    evidence,
    ...extra,
  });
  if (!control.visible || (!options.includeDisabled && !control.enabled) || !control.actions.length)
    return result('not-applicable', 'INACTIVE_CONTROL', 'Control is hidden, disabled or has no observed operation');
  if (inspection.focus.confidence !== 'observed')
    return result('unknown', 'SCOPE_UNKNOWN', 'The current interaction scope is not established');
  // Inspect only the active interaction boundary, including logically owned portals.
  const active = observation.overlays?.at(-1);
  if (active && !active.controlIds.includes(control.localId))
    return result('not-applicable', 'OUTSIDE_ACTIVE_SCOPE', 'Control is outside the active interaction boundary');
  const nodes = new Map(dom.nodes.map(n => [n.id, n]));
  const chain: DomNodeEvidence[] = [];
  const seen = new Set<string>();
  for (let n: DomNodeEvidence | undefined = node; n; ) {
    if (seen.has(n.id))
      return result('unknown', 'ANCESTOR_CHAIN_INCOMPLETE', 'The captured ancestor chain contains a cycle');
    seen.add(n.id);
    chain.push(n);
    if (n.id === dom.rootId) break;
    n = n.parentId ? nodes.get(n.parentId) : undefined;
  }
  if (chain.at(-1)?.id !== dom.rootId)
    return result('unknown', 'ANCESTOR_CHAIN_INCOMPLETE', 'A required ancestor is absent');
  if (chain.some(n => n.attributes?.inert !== undefined))
    return result('not-applicable', 'INACTIVE_CONTROL', 'Control is in an inert subtree');
  const env = dom.environment;
  if (dom.spatialVersion !== 1 || !env || !node.rect || env.coordinateSpace !== 'layout-viewport-css-px')
    return result('unknown', 'GEOMETRY_UNAVAILABLE', 'Compatible captured geometry is missing');
  // Old captures remain readable, but cannot certify the newer geometry contract.
  if (
    chain.some(
      n => !n.layout?.clipping || n.layout.clipping.version !== 1 || !n.styles || !n.rect || hasRelevantGaps(n),
    )
  )
    return result(
      'unknown',
      'CLIP_EVIDENCE_UNAVAILABLE',
      'Clipping metadata, ancestor styles or geometry is missing or truncated',
    );
  const visual = env.visualViewport;
  if (visual && (visual.scale !== 1 || visual.offsetLeft !== 0 || visual.offsetTop !== 0))
    return result(
      'unknown',
      'VISUAL_VIEWPORT_UNSUPPORTED',
      'Pinch zoom or an offset visual viewport requires a different geometry model',
    );
  // Native modal/popover/fullscreen roots escape ancestor clipping. Their own
  // overflow still clips descendants. A role or z-index alone is not top-layer proof.
  const topLayer = chain.findIndex(n => n.layout!.clipping!.topLayer);
  const effective = topLayer < 0 ? chain : chain.slice(0, topLayer + 1);
  for (const n of effective) {
    if (!n.layout!.offset)
      return result('unknown', 'CLIP_BOX_UNSUPPORTED', 'Non-HTML box geometry is outside this rule');
    if (
      ![
        n.rect!.x,
        n.rect!.y,
        n.rect!.width,
        n.rect!.height,
        n.layout!.client.left,
        n.layout!.client.top,
        n.layout!.client.width,
        n.layout!.client.height,
      ].every(Number.isFinite)
    ) {
      return result('unknown', 'GEOMETRY_UNAVAILABLE', 'A required box has non-finite metrics');
    }
    const s = n.styles!;
    const required = [
      'transform',
      'translate',
      'rotate',
      'scale',
      'zoom',
      'filter',
      'perspective',
      'clip',
      'clip-path',
      'mask-image',
      'contain',
      'content-visibility',
      'will-change',
      'overflow-x',
      'overflow-y',
      'position',
      'display',
    ];
    if (required.some(k => s[k] === undefined))
      return result('unknown', 'CLIP_EVIDENCE_UNAVAILABLE', 'Required computed styles were not captured');
    if (
      ['transform', 'translate', 'rotate', 'scale', 'filter', 'perspective', 'clip-path', 'mask-image'].some(
        k => s[k] !== 'none',
      ) ||
      !['1', 'normal'].includes(s.zoom) ||
      s.clip !== 'auto' ||
      s.contain !== 'none' ||
      s['content-visibility'] !== 'visible' ||
      s['will-change'] !== 'auto' ||
      n.layout!.clipping!.fragmentCount > 1
    ) {
      return result(
        'unknown',
        'COMPLEX_CLIP_UNVERIFIED',
        'Transforms, containment, masks, fragmented boxes or custom clipping require additional evidence',
      );
    }
  }
  const r = node.rect,
    original = bounds(r),
    tolerance = options.tolerancePx;
  if (!Number.isFinite(r.x + r.y + r.width + r.height) || r.width <= 0 || r.height <= 0)
    return result('unknown', 'GEOMETRY_UNAVAILABLE', 'No finite positive-area target box');
  const viewport: Bounds = {
    left: 0,
    top: 0,
    right: env.layoutViewport.clientWidth,
    bottom: env.layoutViewport.clientHeight,
  };
  const outside = (a: Bounds, b: Bounds) =>
    a.left < b.left - tolerance ||
    a.top < b.top - tolerance ||
    a.right > b.right + tolerance ||
    a.bottom > b.bottom + tolerance;
  // No selector/tag exemption: even a genuine interactive target may be larger
  // than the viewport. This rule cannot certify it, and scrolling cannot make
  // its whole box fit. Keep the limitation explicit rather than waiting forever.
  if (r.width > viewport.right + 2 * tolerance || r.height > viewport.bottom + 2 * tolerance)
    return result(
      'unknown',
      'TARGET_EXCEEDS_VIEWPORT',
      'The target is larger than the captured viewport; scrolling alone cannot satisfy full-view coverage',
      {
        facts: {
          identityId: control.identityId ?? null,
          observationStatus: 'unsupported',
          recheck: 'requires-viewport-or-layout-change',
          targetRect: json(r),
          viewportBounds: json(viewport),
          coverage: 'full-view-control-box-check-unavailable',
        },
        nextSteps: ['Use a rule that supports partial-view targets, or reassess after a viewport or layout change'],
      },
    );
  if (outside(original, viewport))
    return result(
      'unknown',
      'VIEWPORT_RECHECK_PENDING',
      'The control extends outside the viewport; wait for an ordinary exploration observation',
      {
        facts: {
          identityId: control.identityId ?? null,
          geometry: 'viewport-partial-or-outside',
          viewportIntersectionRatio: area(intersect(original, viewport)) / area(original),
        },
      },
    );
  let visible = { ...original };
  const clips: { nodeId: string; axis: 'x' | 'y'; overflow: string; scrollable: boolean; bounds: Bounds }[] = [];
  for (let i = 0; i < effective.length; i++) {
    const n = effective[i],
      s = n.styles!,
      l = n.layout!;
    if (i > 0 && n.id !== env.scrollingElement?.nodeId) {
      const ox = s['overflow-x'],
        oy = s['overflow-y'];
      if (overflow(ox) || overflow(oy)) {
        // Body overflow can propagate to the viewport, rather than its own box.
        if (n.tag === 'body')
          return result(
            'unknown',
            'ROOT_OVERFLOW_UNVERIFIED',
            'Body overflow propagation requires separate viewport evidence',
          );
        if (s.display === 'inline' || s.display === 'contents' || s.display.startsWith('table'))
          return result(
            'unknown',
            'CLIP_BOX_UNSUPPORTED',
            'This ancestor does not have a supported block clipping box',
          );
        if (
          [
            'border-top-left-radius',
            'border-top-right-radius',
            'border-bottom-left-radius',
            'border-bottom-right-radius',
          ].some(k => !s[k] || s[k].split(/\s+/).some(v => parseFloat(v) !== 0)) ||
          ([ox, oy].includes('clip') && !['0px', 'padding-box 0px'].includes(s['overflow-clip-margin']))
        )
          return result(
            'unknown',
            'COMPLEX_CLIP_UNVERIFIED',
            'Rounded clipping or an expanded overflow clip edge is outside rectangular coverage',
          );
        const b = {
          left: n.rect!.x + l.client.left,
          top: n.rect!.y + l.client.top,
          right: n.rect!.x + l.client.left + l.client.width,
          bottom: n.rect!.y + l.client.top + l.client.height,
        };
        for (const axis of ['x', 'y'] as const) {
          const value = axis === 'x' ? ox : oy;
          if (!overflow(value)) continue;
          const lo = axis === 'x' ? 'left' : 'top',
            hi = axis === 'x' ? 'right' : 'bottom';
          if (original[lo] < b[lo] - tolerance || original[hi] > b[hi] + tolerance)
            clips.push({
              nodeId: n.id,
              axis,
              overflow: value,
              scrollable: ['auto', 'scroll'].includes(value),
              bounds: b,
            });
          visible[lo] = Math.max(visible[lo], b[lo]);
          visible[hi] = Math.min(visible[hi], b[hi]);
        }
      }
    }
    if (s.position === 'fixed') break; // Ancestor transforms/containing blocks were screened above.
    if (s.position === 'absolute' && i + 1 < effective.length && l.offset?.parentId !== effective[i + 1].id) {
      // offsetParent is not a complete containing-block model. Never treat DOM
      // ancestors escaped by positioned content as proven clipping ancestors.
      return result(
        'unknown',
        'POSITIONED_CLIP_UNVERIFIED',
        'An absolute descendant may escape intervening overflow ancestors',
      );
    }
  }
  const facts = {
    identityId: control.identityId ?? null,
    geometry: clips.length ? 'clipped' : 'unclipped',
    targetRect: json(r),
    visibleBounds: json(visible),
    rectangularIntersectionRatio: area(visible) / area(original),
    clips: json(clips),
    tolerancePx: tolerance,
    coverage: 'rectangular-border-box; not-text-or-pixels',
  };
  const extra = {
    facts,
    evidence: [...evidence, ...new Set(clips.map(c => `node:${capture.documentId}:${c.nodeId}`))],
  };
  if (!clips.length)
    return result(
      'pass',
      'CONTROL_BOX_UNCLIPPED',
      'No clipping of the control border box was established within rectangular coverage',
      extra,
    );
  const hardClip = clips.some(c => !c.scrollable);
  if (!hardClip) {
    const oversized = clips.some(c =>
      c.axis === 'x'
        ? r.width > c.bounds.right - c.bounds.left + 2 * tolerance
        : r.height > c.bounds.bottom - c.bounds.top + 2 * tolerance,
    );
    if (oversized)
      return result(
        'unknown',
        'TARGET_EXCEEDS_SCROLLPORT',
        'The target is larger than a scrolling container; scrolling alone cannot reveal its full box',
        {
          ...extra,
          facts: { ...facts, observationStatus: 'unsupported', recheck: 'requires-viewport-or-layout-change' },
          nextSteps: [
            'Use a rule that supports partial-view targets, or reassess after a container or target layout change',
          ],
        },
      );
    return result(
      'unknown',
      'SCROLL_CLIP_RECHECK_PENDING',
      'The control intersects a scrolling viewport edge; ordinary scrolling may reveal it',
      extra,
    );
  }
  const requirement =
    !control.hypothesisId && observation.controls.filter(c => c.identityId === control.identityId).length === 1
      ? options.requirements.find(r => r.identityId === control.identityId)
      : undefined;
  if (requirement)
    return result(
      'fail',
      'CLIPPING_REQUIREMENT_FAILED',
      'A non-scroll-UI overflow edge clips the control at this observation; permanent unreachability is not established',
      {
        ...extra,
        severity: 'error',
        expected: requirement.reason,
        evidence: [...extra.evidence, ...requirement.evidence],
        facts: { ...facts, requirement: json(requirement) },
      },
    );
  return result(
    'unknown',
    'CONTROL_CLIPPING_SUSPECTED',
    'A hidden/clip overflow edge cuts the control; design intent and recovery remain unverified',
    {
      ...extra,
      severity: 'warning',
      nextSteps: [
        'Recheck the same control in subsequent exploration captures',
        'Provide a sourced, identity-scoped requirement if non-scroll-container clipping is forbidden',
      ],
    },
  );
}

export const clippedControlRule: ControlRule = {
  id: 'clipped-control',
  version: '1.0.0',
  name: 'Control box clipping',
  description:
    'Passive rectangular clipping evidence. Normal scrolling stays pending; non-scroll clipping warns unless a sourced requirement is violated.',
  requiredCapabilities: ['web.dom', 'web.layout', 'web.styles', 'web.environment'],
  optionsSchema: z.record(z.string(), z.json()).parse(z.toJSONSchema(clippedControlOptionsSchema)),
  configure(input) {
    const options = clippedControlOptionsSchema.parse(input);
    return context => assess(context, options);
  },
};
