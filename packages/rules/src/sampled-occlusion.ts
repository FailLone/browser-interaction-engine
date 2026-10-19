import { z } from 'zod';
import type { DomNodeEvidence } from './types.js';
import type { ControlRule, RuleAssessment, RuleContext } from './types.js';

function ancestors(node: DomNodeEvidence, nodes: Map<string, DomNodeEvidence>) {
  const result = [node];
  const seen = new Set([node.id]);
  while (node.parentId && !seen.has(node.parentId)) {
    const parent = nodes.get(node.parentId);
    if (!parent) break;
    seen.add(parent.id);
    result.push(parent);
    node = parent;
  }
  return result;
}
/**
 * A covering element that is ordinary layered page UI rather than an obstruction defect:
 * - page chrome: a sticky/fixed bar spanning (nearly) the whole viewport width, such as a
 *   header or bottom bar, that ordinary content scrolls beneath;
 * - an open popup: the covering element belongs to an overlay the capture recorded
 *   (a menu, picker or dialog opened by an earlier action);
 * - a side panel: a fixed, layered panel docked to the left or right edge and spanning most of
 *   the viewport height, such as a chat or drawer opened by an earlier action;
 * - a dropdown: a layered absolute/fixed box that extends well outside its parent, i.e. it drops
 *   out of the control that opened it (header menus, search suggestions) without popup markup.
 * A small positioned box over a static control is not excluded: that is the defect itself.
 */
function transientCover(
  blockerChain: DomNodeEvidence[],
  targetChain: DomNodeEvidence[],
  viewport: { width: number; height: number },
  overlayRoots: Set<string>,
  nodes: Map<string, DomNodeEvidence>,
) {
  const targetIds = new Set(targetChain.map(n => n.id));
  for (const n of blockerChain) {
    if (targetIds.has(n.id)) break; // shared ancestor: from here up, both are in the same layer
    if (overlayRoots.has(n.id))
      return { code: 'COVERED_BY_OPEN_POPUP', actual: 'An open popup layered above the page covers the sampled point' };
    const position = n.styles?.position ?? '';
    if (
      (position === 'sticky' || position === 'fixed') &&
      n.rect &&
      n.rect.width >= viewport.width * 0.9 &&
      n.rect.height < 400
    )
      return {
        code: 'COVERED_BY_PAGE_CHROME',
        actual: `A full-width ${position} bar the page scrolls beneath covers the sampled point`,
      };
    if (
      position === 'fixed' &&
      n.rect &&
      Number(n.styles?.['z-index']) > 0 &&
      n.rect.height >= viewport.height * 0.6 &&
      n.rect.width <= viewport.width * 0.5 &&
      (n.rect.x <= viewport.width * 0.1 || n.rect.x + n.rect.width >= viewport.width * 0.9)
    )
      return {
        code: 'COVERED_BY_SIDE_PANEL',
        actual: 'An open panel docked to the side of the viewport covers the sampled point',
      };
    // The opener is the parent: a real, small box (not the page body) the panel extends below.
    const opener = n.parentId ? nodes.get(n.parentId) : undefined;
    const parent = opener && !['body', 'html'].includes(opener.tag ?? '') ? opener.rect : undefined;
    if (
      (position === 'absolute' || position === 'fixed') &&
      n.rect &&
      parent &&
      parent.width > 0 &&
      parent.height > 0 &&
      Number(n.styles?.['z-index']) > 0 &&
      n.rect.height > parent.height * 2 &&
      n.rect.y >= parent.y + parent.height * 0.5
    )
      return {
        code: 'COVERED_BY_OPEN_POPUP',
        actual: 'A layered panel dropped from the control that opened it covers the sampled point',
      };
  }
  return undefined;
}

function assess(context: RuleContext, includeDisabled: boolean): RuleAssessment {
  const { capture, dom, observation, control, node } = context;
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
      'The captured viewport-intersection center hits the control or its descendant; this is not a full visibility or operability check',
    actual,
    evidence,
    ...extra,
  });
  const nodes = new Map(dom.nodes.map(n => [n.id, n]));
  const chain = ancestors(node, nodes);
  if (
    !control.visible ||
    (!includeDisabled && !control.enabled) ||
    chain.some(n => n.attributes?.inert !== undefined)
  ) {
    return result('not-applicable', 'INACTIVE_CONTROL', 'Control is hidden, disabled or inside an inert subtree');
  }
  // Preserve the modal-specific explanation. Other active boundaries are
  // capture-scoped exclusions below, never proof of background health.
  // Tooltip roles and fixed/sticky positioning alone confer no exemption.
  if (context.inspection.focus.confidence !== 'observed')
    return result('unknown', 'SCOPE_UNKNOWN', 'Current interaction scope is not established');
  const overlays = observation.overlays ?? [];
  const modal = overlays.filter(o => o.kind === 'modal').at(-1);
  const containingOverlays = overlays.filter(
    o => o.controlIds.includes(node.id) || chain.some(n => n.id === dom.regionRoots[o.key]),
  );
  const belongsToModal = containingOverlays.some(o => {
    const seen = new Set<string>();
    for (
      let current: typeof o | undefined = o;
      current && !seen.has(current.key);
      current = overlays.find(p => p.key === current!.parentKey)
    ) {
      if (current.key === modal?.key) return true;
      seen.add(current.key);
    }
    return false;
  });
  if (modal && dom.regionRoots[modal.key] && !belongsToModal)
    return result('not-applicable', 'MODAL_BACKGROUND', 'Control belongs to the background of an observed modal', {
      evidence: [...evidence, `overlay:${modal.key}`],
    });
  const active = overlays.at(-1);
  if (active && !active.controlIds.includes(control.localId))
    return result('not-applicable', 'OUTSIDE_ACTIVE_SCOPE', 'Control is outside the active interaction boundary');
  const viewport = dom.environment?.layoutViewport;
  const rect = node.rect;
  if (!viewport || !rect || dom.spatialVersion !== 1)
    return result('unknown', 'GEOMETRY_UNAVAILABLE', 'Compatible geometry is missing');
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.x >= viewport.width ||
    rect.y >= viewport.height ||
    rect.x + rect.width <= 0 ||
    rect.y + rect.height <= 0
  ) {
    return result(
      'not-applicable',
      'OUTSIDE_VIEWPORT',
      'No positive-area viewport intersection was captured; offscreen reachability is a separate check',
    );
  }
  const hit = node.layout?.hitSample;
  if (!hit) return result('unknown', 'HIT_SAMPLE_UNAVAILABLE', 'The historical hit sample is unavailable');
  if (hit.withinSubtree)
    return result('pass', 'SAMPLE_REACHABLE', 'The one captured sample hits this control or a descendant', {
      facts: { sample: { x: hit.x, y: hit.y }, coverage: 'one-point-only' },
    });
  const blocker = hit.topNodeId ? nodes.get(hit.topNodeId) : undefined;
  if (!blocker)
    return result(
      'unknown',
      'HIT_TARGET_UNAVAILABLE',
      'The sample misses the target, but the hit node was not captured',
    );
  const blockerChain = ancestors(blocker, nodes);
  const positioned = blockerChain.filter(n => ['sticky', 'fixed'].includes(n.styles?.position ?? ''));
  const blockerOverlays = overlays.filter(o => blockerChain.some(n => n.id === dom.regionRoots[o.key])).map(o => o.key);
  const tooltip = blockerChain.some(n => n.attributes?.role === 'tooltip');
  // Transient UI over page content is expected, not a defect: an open popup, or full-width
  // sticky/fixed page chrome the page scrolls beneath.
  const transient = transientCover(
    blockerChain,
    chain,
    viewport,
    new Set(overlays.map(o => dom.regionRoots[o.key]).filter(Boolean)),
    nodes,
  );
  if (transient)
    return result('not-applicable', transient.code, transient.actual, {
      evidence: [...evidence, `node:${capture.documentId}:${blocker.id}`],
      facts: { sample: { x: hit.x, y: hit.y }, blockerNodeId: blocker.id, coverage: 'one-point-only' },
    });
  return result(
    'unknown',
    'SAMPLE_INTERCEPTED',
    'Another node receives the sampled point; design intent, whole-control impact and recovery have not been verified',
    {
      severity: 'warning',
      evidence: [...evidence, `node:${capture.documentId}:${blocker.id}`],
      facts: {
        sample: { x: hit.x, y: hit.y },
        blockerNodeId: blocker.id,
        positionedAncestors: positioned.map(n => ({ nodeId: n.id, position: n.styles!.position })),
        overlayKeys: blockerOverlays,
        tooltip,
        recovery: 'unverified',
        coverage: 'one-point-only',
      },
      nextSteps: [
        'Confirm whether this control must be operable in the current interaction scope',
        'Check more hit points or visual evidence to establish actual impact',
        'Use ObservedOcclusionTracker to recheck saved captures as normal exploration continues; a scroll endpoint alone is not proof of irrecoverability',
      ],
    },
  );
}

const optionsSchema = z.object({ includeDisabled: z.boolean().default(false) }).strict();
export const sampledOcclusionRule: ControlRule = {
  id: 'sampled-occlusion',
  version: '1.0.0',
  name: 'Sampled pointer occlusion',
  description:
    'Inspect one historical pointer sample per control. Interception produces an unresolved warning, never an inferred visual defect or permanent blockage.',
  requiredCapabilities: ['web.dom', 'web.layout', 'web.styles', 'web.environment'],
  optionsSchema: z.record(z.string(), z.json()).parse(z.toJSONSchema(optionsSchema)),
  configure(input) {
    const options = optionsSchema.parse(input);
    return context => assess(context, options.includeDisabled);
  },
};
