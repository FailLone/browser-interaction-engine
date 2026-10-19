import { hasRelevantGaps } from './evidence-dependencies.js';
import { z } from 'zod';
import type { DomNodeEvidence, Json, Rect } from './types.js';
import type { ControlRule, RuleAssessment, RuleContext } from './types.js';

export const textTruncationOptionsSchema = z
  .object({
    includeDisabled: z.boolean().default(false),
    tolerancePx: z.number().min(0).max(2).default(1),
  })
  .strict();
export type TextTruncationOptions = z.input<typeof textTruncationOptionsSchema>;
export const textTruncationDefaultPolicy = Object.freeze({
  id: 'text-truncation-default',
  version: '1.0.0',
  source: 'builtin',
  hardClipping: 'warning',
  ellipsis: 'record',
  lineClamp: 'record',
  scrolling: 'pending',
  missingEvidence: 'unknown',
  externalRequirements: 'not-integrated',
} as const);
type Mechanism = 'hard-clip' | 'ellipsis' | 'line-clamp' | 'scroll' | 'viewport';
type Cut = {
  textNodeId: string;
  subject: 'text-fragment' | 'label-box';
  fragment?: number;
  clippingNodeId: string;
  axis: 'x' | 'y';
  mechanism: Mechanism;
  rect: Rect;
  min: number;
  max: number;
};
const json = (v: unknown): Json => JSON.parse(JSON.stringify(v));
const clips = (value: string) => ['hidden', 'clip', 'auto', 'scroll'].includes(value);
const fieldRoles = ['textbox', 'spinbutton', 'checkbox', 'radio', 'switch', 'combobox'];
const labelRoles = ['button', 'tab', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option'];

/** Visible DOM labels only. Values, placeholders, accessible names and generated
 * content are not substituted for text actually captured in the layout. */
export function textLabelRoots(context: Pick<RuleContext, 'control' | 'node'>): string[] {
  const { control, node } = context;
  if (['input', 'textarea', 'select'].includes(control.tag) || fieldRoles.includes(control.role)) {
    return [...new Set([...(node.relations?.labels ?? []), ...(node.relations?.['aria-labelledby'] ?? [])])];
  }
  return labelRoles.includes(control.role) || ['button', 'summary', 'a'].includes(control.tag) ? [node.id] : [];
}

function assess(context: RuleContext, options: z.output<typeof textTruncationOptionsSchema>): RuleAssessment {
  const { control, node, dom, observation, inspection, capture } = context;
  const roots = textLabelRoots(context),
    cuts: Cut[] = [],
    issues: string[] = [],
    textIds: string[] = [];
  const evidence = [capture.id, `node:${node.id}`];
  let fragmentCount = 0;
  const result = (
    verdict: RuleAssessment['verdict'],
    severity: RuleAssessment['severity'],
    code: string,
    actual: string,
  ): RuleAssessment => ({
    verdict,
    severity,
    code,
    actual,
    expected:
      'Captured DOM label text boxes fit without unmarked clipping; configured elision is recorded separately from design compliance',
    evidence: [...evidence, ...textIds.map(id => `node:${id}`)],
    facts: {
      identityId: control.identityId ?? null,
      policy: { ...textTruncationDefaultPolicy },
      textRootIds: roots,
      textNodeIds: textIds,
      fragmentCount,
      cuts: json(cuts),
      limitations: issues,
      coverage: 'DOM-text-range-boxes; not-painted-glyphs-or-complete-readability',
      elisionMarkerPainted: 'unverified',
      alternativeReading: 'unverified',
      geometry: cuts.length
        ? 'overflow-observed'
        : verdict === 'unknown' || issues.length
          ? 'unverified'
          : fragmentCount
            ? 'fits'
            : 'no-text',
    },
  });
  if (!control.visible || (!options.includeDisabled && !control.enabled))
    return result('not-applicable', 'info', 'INACTIVE_CONTROL', 'Control is hidden or disabled');
  if (inspection.focus.confidence !== 'observed')
    return result('unknown', 'info', 'SCOPE_UNKNOWN', 'The current interaction scope is not established');
  const active = observation.overlays?.at(-1);
  if (active && !active.controlIds.includes(control.localId))
    return result(
      'not-applicable',
      'info',
      'OUTSIDE_ACTIVE_SCOPE',
      'Control is outside the active interaction boundary',
    );
  if (
    (['input', 'textarea', 'select'].includes(control.tag) || fieldRoles.includes(control.role)) &&
    hasRelevantGaps(node, ['aria-labelledby'])
  ) {
    issues.push('LABEL_RELATION_INCOMPLETE');
    return result(
      'unknown',
      'info',
      'TEXT_RECHECK_UNAVAILABLE',
      'A required DOM label relation is missing or truncated',
    );
  }
  if (!roots.length)
    return result(
      'not-applicable',
      'info',
      'NO_DOM_LABEL',
      'No supported DOM label is associated with this control; values and placeholders are outside coverage',
    );
  if (
    dom.textGeometry?.version !== 1 ||
    dom.textGeometry.coordinateSpace !== 'layout-viewport-css-px' ||
    dom.spatialVersion !== 1 ||
    !dom.environment
  ) {
    return result(
      'unknown',
      'info',
      'TEXT_GEOMETRY_UNAVAILABLE',
      'Compatible text geometry is absent from this capture',
    );
  }
  if (dom.textGeometry.fonts !== 'loaded')
    return result(
      'unknown',
      'info',
      'TEXT_FONTS_UNSETTLED',
      'Font loading was unfinished or unavailable at capture time',
    );
  const env = dom.environment,
    vv = env.visualViewport;
  if (![env.layoutViewport.clientWidth, env.layoutViewport.clientHeight].every(n => Number.isFinite(n) && n > 0))
    return result('unknown', 'info', 'TEXT_GEOMETRY_UNSUPPORTED', 'Viewport dimensions are unavailable');
  if (vv && (vv.scale !== 1 || vv.offsetLeft !== 0 || vv.offsetTop !== 0))
    return result(
      'unknown',
      'info',
      'TEXT_GEOMETRY_UNSUPPORTED',
      'Pinch zoom or visual viewport offsets require another geometry model',
    );
  const nodes = new Map(dom.nodes.map(n => [n.id, n])),
    texts: DomNodeEvidence[] = [],
    visited = new Set<string>();
  const otherControls = new Set(
    observation.controls
      .filter(c => c.localId !== control.localId && c.actions.some(a => a !== 'scroll'))
      .map(c => c.localId),
  );
  let walked = 0;
  const visit = (id: string, root = false) => {
    if (visited.has(id)) return;
    visited.add(id);
    if (++walked > 512) {
      issues.push('LABEL_NODE_BUDGET_EXCEEDED');
      return;
    }
    const n = nodes.get(id);
    if (!n) {
      issues.push('LABEL_NODE_MISSING');
      return;
    }
    if (n.nodeType === 'text') {
      if (n.text?.trim()) texts.push(n);
      return;
    }
    if (['script', 'style', 'template', 'noscript', 'input', 'textarea', 'select'].includes(n.tag ?? '')) return;
    if (
      !root &&
      (otherControls.has(id) ||
        ['dialog', 'menu', 'listbox', 'tooltip'].includes(n.attributes?.role ?? '') ||
        n.attributes?.popover !== undefined)
    )
      return;
    if (
      n.styles?.display === 'none' ||
      ['hidden', 'collapse'].includes(n.styles?.visibility ?? '') ||
      n.styles?.opacity === '0' ||
      n.attributes?.hidden !== undefined
    )
      return;
    if (hasRelevantGaps(n)) issues.push('LABEL_EVIDENCE_INCOMPLETE');
    for (const child of n.children) {
      if (walked > 512) break;
      visit(child);
    }
  };
  for (const root of roots) visit(root, true);
  if (texts.length > 64) issues.push('LABEL_TEXT_BUDGET_EXCEEDED');
  const tol = options.tolerancePx;
  for (const text of texts.slice(0, 64)) {
    textIds.push(text.id);
    if (context.signal.aborted) {
      issues.push('RULE_ABORTED');
      break;
    }
    if (hasRelevantGaps(text) || text.textLayout?.version !== 1 || text.textLayout.status !== 'captured') {
      issues.push('TEXT_FRAGMENTS_UNAVAILABLE');
      continue;
    }
    const chain: DomNodeEvidence[] = [];
    const seen = new Set<string>();
    let parent = text.parentId;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const p = nodes.get(parent);
      if (!p) break;
      chain.push(p);
      if (p.id === dom.rootId) break;
      parent = p.parentId;
    }
    if (chain.at(-1)?.id !== dom.rootId) {
      issues.push('TEXT_ANCESTOR_MISSING');
      continue;
    }
    if (
      chain.some(
        n =>
          n.styles?.display === 'none' ||
          ['hidden', 'collapse'].includes(n.styles?.visibility ?? '') ||
          n.styles?.opacity === '0' ||
          n.attributes?.inert !== undefined,
      )
    )
      continue;
    const layer = chain.findIndex(n => n.layout?.clipping?.topLayer);
    const effective = layer < 0 ? chain : chain.slice(0, layer + 1);
    let unsupported = false;
    for (const p of effective) {
      const s = p.styles,
        l = p.layout;
      if (!s || !p.rect || !l?.offset || l.clipping?.version !== 1 || hasRelevantGaps(p)) {
        issues.push('TEXT_ANCESTOR_EVIDENCE_MISSING');
        unsupported = true;
        break;
      }
      if (
        ![...Object.values(p.rect), ...Object.values(l.client)].every(Number.isFinite) ||
        p.rect.width < 0 ||
        p.rect.height < 0 ||
        l.client.width < 0 ||
        l.client.height < 0
      ) {
        issues.push('INVALID_TEXT_CLIP_RECT');
        unsupported = true;
        break;
      }
      const required = [
        'overflow-x',
        'overflow-y',
        'overflow-clip-margin',
        'text-overflow',
        '-webkit-line-clamp',
        '-webkit-box-orient',
        'position',
        'display',
        'transform',
        'translate',
        'rotate',
        'scale',
        'zoom',
        'perspective',
        'filter',
        'clip',
        'clip-path',
        'mask-image',
        'contain',
        'content-visibility',
        'will-change',
        'writing-mode',
        'direction',
        'column-count',
        'column-width',
      ];
      if (required.some(k => s[k] === undefined)) {
        issues.push('TEXT_STYLES_MISSING');
        unsupported = true;
        break;
      }
      if (
        ['transform', 'translate', 'rotate', 'scale', 'filter', 'perspective', 'clip-path', 'mask-image'].some(
          k => s[k] !== 'none',
        ) ||
        !['normal', '1'].includes(s.zoom) ||
        s.clip !== 'auto' ||
        s.contain !== 'none' ||
        s['content-visibility'] !== 'visible' ||
        s['will-change'] !== 'auto' ||
        s['writing-mode'] !== 'horizontal-tb' ||
        s['column-width'] !== 'auto' ||
        !['auto', '1'].includes(s['column-count'])
      ) {
        issues.push('COMPLEX_TEXT_GEOMETRY');
        unsupported = true;
        break;
      }
    }
    if (unsupported) continue;
    const rects = text.textLayout.rects.filter(r => r.width > 0 && r.height > 0);
    if (text.textLayout.rects.some(r => !Object.values(r).every(Number.isFinite) || r.width < 0 || r.height < 0)) {
      issues.push('INVALID_TEXT_RECT');
      continue;
    }
    if (fragmentCount + rects.length > 256) {
      issues.push('LABEL_FRAGMENT_BUDGET_EXCEEDED');
      break;
    }
    fragmentCount += rects.length;
    // Wait until the label's own box enters the viewport before diagnosing its
    // internal clipping. Do not confuse an elided text tail with an offscreen box.
    const label = chain.find(n => roots.includes(n.id)),
      labelRect = label?.rect;
    const offscreen: Cut[] = [];
    if (labelRect && labelRect.width > 0 && labelRect.height > 0)
      for (const axis of ['x', 'y'] as const) {
        const start = axis === 'x' ? labelRect.x : labelRect.y,
          end = start + (axis === 'x' ? labelRect.width : labelRect.height);
        const max = axis === 'x' ? env.layoutViewport.clientWidth : env.layoutViewport.clientHeight;
        if (start < -tol || end > max + tol)
          offscreen.push({
            textNodeId: text.id,
            subject: 'label-box',
            clippingNodeId: dom.rootId!,
            axis,
            mechanism: 'viewport',
            rect: labelRect,
            min: 0,
            max,
          });
      }
    if (offscreen.length) {
      cuts.push(...offscreen);
      continue;
    }
    // Ellipsis applies to inline content in its own line formatting container.
    const lineOwner = effective.find(n => !['inline', 'contents'].includes(n.styles!.display));
    for (let index = 0; index < rects.length; index++) {
      const r = rects[index];
      if (!Object.values(r).every(Number.isFinite)) {
        issues.push('INVALID_TEXT_RECT');
        continue;
      }
      const localCuts: Cut[] = [];
      for (let i = 0; i < effective.length; i++) {
        const p = effective[i],
          s = p.styles!,
          l = p.layout!;
        const clamp =
          Number(s['-webkit-line-clamp']) > 0 &&
          ['-webkit-box', '-webkit-inline-box', 'flow-root'].includes(s.display) &&
          s['-webkit-box-orient'] === 'vertical';
        if (p.id !== env.scrollingElement?.nodeId && (clips(s['overflow-x']) || clips(s['overflow-y']) || clamp)) {
          if (
            p.tag === 'body' ||
            s.display.startsWith('table') ||
            s.display === 'inline' ||
            s.display === 'contents' ||
            l.clipping!.fragmentCount !== 1
          ) {
            issues.push('TEXT_CLIP_BOX_UNSUPPORTED');
            unsupported = true;
            break;
          }
          // These are rectangular text bounds, not glyph or rounded-corner
          // visibility. A rectangular fit does not certify painted readability.
          for (const axis of ['x', 'y'] as const) {
            const value = s[axis === 'x' ? 'overflow-x' : 'overflow-y'];
            if (!clips(value) && !(axis === 'y' && clamp)) continue;
            const min = axis === 'x' ? p.rect!.x + l.client.left : p.rect!.y + l.client.top;
            const max = min + (axis === 'x' ? l.client.width : l.client.height);
            const start = axis === 'x' ? r.x : r.y,
              end = start + (axis === 'x' ? r.width : r.height);
            if (start >= min - tol && end <= max + tol) continue;
            if (value === 'clip' && !['0px', 'padding-box 0px'].includes(s['overflow-clip-margin'])) {
              issues.push('EXPANDED_TEXT_CLIP_UNSUPPORTED');
              unsupported = true;
              break;
            }
            const scrollable = ['auto', 'scroll'].includes(value);
            const atEnd =
              axis === 'x' &&
              (s.direction === 'rtl' ? start < min - tol && end <= max + tol : end > max + tol && start >= min - tol);
            let mechanism: Mechanism = scrollable ? 'scroll' : 'hard-clip';
            if (!scrollable && p.id === lineOwner?.id) {
              if (axis === 'x' && atEnd && s['text-overflow'] === 'ellipsis') mechanism = 'ellipsis';
              // Partial-height lines are hard clipping even with line-clamp set.
              if (axis === 'y' && clamp && start >= max - tol) mechanism = 'line-clamp';
            }
            localCuts.push({
              textNodeId: text.id,
              subject: 'text-fragment',
              fragment: index,
              clippingNodeId: p.id,
              axis,
              mechanism,
              rect: r,
              min,
              max,
            });
          }
        }
        if (unsupported) break;
        if (s.position === 'fixed') break;
        if (s.position === 'absolute' && i + 1 < effective.length && l.offset?.parentId !== effective[i + 1].id) {
          issues.push('POSITIONED_TEXT_CLIP_UNVERIFIED');
          unsupported = true;
          break;
        }
      }
      if (unsupported) break;
      // Fully elided tail fragments outside the viewport are not ordinary page
      // scrolling. A viewport cut matters only when no earlier clip explains it.
      if (!localCuts.length)
        for (const axis of ['x', 'y'] as const) {
          const start = axis === 'x' ? r.x : r.y,
            end = start + (axis === 'x' ? r.width : r.height);
          const max = axis === 'x' ? env.layoutViewport.clientWidth : env.layoutViewport.clientHeight;
          if (start < -tol || end > max + tol)
            localCuts.push({
              textNodeId: text.id,
              subject: 'text-fragment',
              fragment: index,
              clippingNodeId: dom.rootId!,
              axis,
              mechanism: 'viewport',
              rect: r,
              min: 0,
              max,
            });
        }
      cuts.push(...localCuts);
    }
  }
  // Hard clipping is evidence of a possible defect, never an invented product
  // requirement. Elision configuration cannot exempt a different clipping axis.
  if (cuts.some(c => c.mechanism === 'hard-clip'))
    return result(
      'unknown',
      'warning',
      'TEXT_HARD_CLIP_SUSPECTED',
      'A DOM text fragment crosses a non-scroll clipping edge; glyph impact and design intent remain unverified',
    );
  if (issues.length)
    return result(
      'unknown',
      'info',
      'TEXT_RECHECK_UNAVAILABLE',
      'Required text evidence or geometry is incomplete; no full-visibility claim is made',
    );
  if (cuts.some(c => c.mechanism === 'viewport' || c.mechanism === 'scroll'))
    return result(
      'unknown',
      'info',
      'TEXT_SCROLL_RECHECK_PENDING',
      'Text extends outside an ordinary viewport; later exploration may reveal it',
    );
  if (cuts.length)
    return result(
      'unknown',
      'info',
      'TEXT_ELISION_OBSERVED',
      'Text overflow coincides with ellipsis or line-clamp configuration; intended compliance and the painted marker are not established',
    );
  if (!fragmentCount)
    return result(
      'not-applicable',
      'info',
      'NO_RENDERED_DOM_TEXT',
      'No positive-area DOM label text fragments were captured',
    );
  return result(
    'pass',
    'info',
    'DOM_TEXT_BOXES_FIT',
    'Captured DOM label text boxes fit within the supported rectangular bounds; generated text and painted glyphs are outside coverage',
  );
}

export const textTruncationRule: ControlRule = {
  id: 'text-truncation',
  version: '1.0.0',
  name: 'DOM label text truncation',
  description:
    'Default passive label checks: hard clipping warns, actual overflow with elision is recorded, ordinary scrolling waits. No external requirements or agent judgments are executed.',
  requiredCapabilities: ['web.dom', 'web.layout', 'web.styles', 'web.environment'],
  optionsSchema: z.record(z.string(), z.json()).parse(z.toJSONSchema(textTruncationOptionsSchema)),
  configure(input) {
    const options = textTruncationOptionsSchema.parse(input);
    return context => assess(context, options);
  },
};
