import { z } from 'zod';
import { canonical } from './util.js';
import type { DomNodeEvidence, Json, Rect } from './types.js';
import type { ControlRule, RuleAssessment, RuleContext } from './types.js';
import { textLabelRoots } from './text-truncation.js';
import { hasRelevantGaps } from './evidence-dependencies.js';

export const labelTextBindingSchema = z
  .array(z.object({ nodeId: z.string().min(1), text: z.string().min(1).max(20000) }).strict())
  .min(1)
  .max(64);
export const textBackgroundOptionsSchema = z
  .object({
    includeDisabled: z.boolean().default(false),
    /** RGB channel tolerance, in the 0..255 scale. Not a contrast/accessibility standard. */
    channelTolerance: z.number().min(0).max(2).default(0),
    requirements: z
      .array(
        z
          .object({
            sessionId: z.string().min(1),
            documentId: z.string().min(1),
            nodeId: z.string().min(1),
            label: labelTextBindingSchema,
            kind: z.enum(['distinct-solid-label-colors', 'allow-matching-label-colors']),
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
    o =>
      new Set(o.requirements.map(r => canonical([r.sessionId, r.documentId, r.nodeId, r.label]))).size ===
      o.requirements.length,
    'Each bound label may have one requirement',
  );
export type TextBackgroundOptions = z.input<typeof textBackgroundOptionsSchema>;
type Color = [number, number, number, number];
const json = (v: unknown): Json => JSON.parse(JSON.stringify(v));
function color(value: string | undefined): Color | undefined {
  // Only captured legacy sRGB syntax. Wide-gamut colors need a specified color
  // space conversion; never silently reinterpret display-p3/lab as sRGB.
  const match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(value ?? '');
  if (!match) return undefined;
  const out: Color = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] === undefined ? 1 : Number(match[4]),
  ];
  return out.every(Number.isFinite) && out.slice(0, 3).every(n => n >= 0 && n <= 255) && out[3] >= 0 && out[3] <= 1
    ? out
    : undefined;
}
const over = (front: Color, back: Color): Color => {
  const a = front[3] + back[3] * (1 - front[3]);
  return a === 0
    ? [0, 0, 0, 0]
    : ([0, 1, 2].map(i => (front[i] * front[3] + back[i] * back[3] * (1 - front[3])) / a).concat(a) as Color);
};
const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inside = (a: Rect, b: Rect) =>
  a.x >= b.x - 0.01 &&
  a.y >= b.y - 0.01 &&
  a.x + a.width <= b.x + b.width + 0.01 &&
  a.y + a.height <= b.y + b.height + 0.01;
function insideBackground(rects: Rect[], p: DomNodeEvidence): boolean {
  const l = p.layout!,
    s = p.styles!,
    bounds = {
      x: p.rect!.x + l.client.left,
      y: p.rect!.y + l.client.top,
      width: l.client.width,
      height: l.client.height,
    };
  const radii = [
    'border-top-left-radius',
    'border-top-right-radius',
    'border-bottom-left-radius',
    'border-bottom-right-radius',
  ].map(k => {
    const values = (s[k] ?? '').split(/\s+/);
    return values.length <= 2 && values.every(v => /^\d+(?:\.\d+)?px$/.test(v)) ? values.map(parseFloat) : undefined;
  });
  if (radii.some(r => !r)) return false;
  const rx = Math.max(...radii.map(r => r![0])),
    ry = Math.max(...radii.map(r => r![1] ?? r![0]));
  // The central strips are safely inside all rounded corners. Large radii
  // remain conservative; this is not an approximation of corner glyph coverage.
  const vertical = { ...bounds, x: bounds.x + rx, width: bounds.width - 2 * rx };
  const horizontal = { ...bounds, y: bounds.y + ry, height: bounds.height - 2 * ry };
  return rects.every(
    r =>
      inside(r, bounds) &&
      ((vertical.width > 0 && inside(r, vertical)) || (horizontal.height > 0 && inside(r, horizontal))),
  );
}
type Sample = {
  textNodeId: string;
  foreground: Color;
  background: Color;
  compositedForeground: Color;
  channelDifference: number;
  backgroundNodeIds: string[];
};

function assess(context: RuleContext, options: z.output<typeof textBackgroundOptionsSchema>): RuleAssessment {
  const { control, node, dom, observation, inspection, capture } = context;
  const roots = textLabelRoots(context),
    nodes = new Map(dom.nodes.map(n => [n.id, n]));
  const texts: DomNodeEvidence[] = [],
    samples: Sample[] = [],
    limitations: { code: string; nodeId?: string }[] = [];
  let bindingComplete = true;
  const result = (
    verdict: RuleAssessment['verdict'],
    code: string,
    actual: string,
    severity: RuleAssessment['severity'] = 'info',
  ): RuleAssessment => ({
    verdict,
    severity,
    code,
    actual,
    expected:
      'Bound DOM label text has a distinct modeled foreground on a supported solid background; this is not a pixel-readability or WCAG assessment',
    evidence: [capture.id, `node:${node.id}`, ...texts.map(n => `node:${n.id}`)],
    facts: {
      identityId: control.identityId ?? null,
      textRootIds: roots,
      textNodeIds: texts.map(n => n.id),
      labelBinding: json(texts.map(n => ({ nodeId: n.id, text: n.text }))),
      samples: json(samples),
      limitations: json(limitations),
      coverage: 'solid-srgb-label-color-model; not-painted-glyphs-or-complete-readability',
      channelTolerance: options.channelTolerance,
      observationStatus:
        code === 'TEXT_BACKGROUND_UNSUPPORTED'
          ? 'unsupported'
          : code === 'TEXT_BACKGROUND_UNAVAILABLE'
            ? 'unavailable'
            : 'current',
    },
  });
  if (!control.visible || (!options.includeDisabled && !control.enabled))
    return result('not-applicable', 'INACTIVE_CONTROL', 'The control is hidden or disabled');
  if (inspection.focus.confidence !== 'observed')
    return result('unknown', 'TEXT_BACKGROUND_UNAVAILABLE', 'The active interaction scope is unknown');
  const active = observation.overlays?.at(-1);
  if (active && !active.controlIds.includes(control.localId))
    return result('not-applicable', 'OUTSIDE_ACTIVE_SCOPE', 'The control is outside the active overlay');
  if (hasRelevantGaps(node, ['aria-labelledby']))
    return result('unknown', 'TEXT_BACKGROUND_UNAVAILABLE', 'The control or its label relation is incomplete');
  if (!roots.length)
    return result(
      'not-applicable',
      'NO_DOM_LABEL',
      'No supported DOM label; input values, placeholders and accessible-name metadata are outside coverage',
    );
  if (dom.paintEnvironment?.version !== 1 || dom.textGeometry?.version !== 1 || dom.textGeometry.fonts !== 'loaded')
    return result('unknown', 'TEXT_BACKGROUND_UNAVAILABLE', 'Paint metadata or settled text geometry is missing');
  if (dom.paintEnvironment.forcedColors)
    return result('unknown', 'TEXT_BACKGROUND_UNSUPPORTED', 'Forced colors require a separate rendering model');
  const otherControls = new Set(
    observation.controls
      .filter(c => c.localId !== control.localId && c.actions.some(a => a !== 'scroll'))
      .map(c => c.localId),
  );
  const visited = new Set<string>();
  const visit = (id: string, root = false) => {
    if (visited.has(id)) return;
    visited.add(id);
    if (visited.size > 512 || texts.length >= 64) {
      bindingComplete = false;
      limitations.push({ code: 'LABEL_BUDGET_EXCEEDED' });
      return;
    }
    const n = nodes.get(id);
    if (!n || hasRelevantGaps(n)) {
      bindingComplete = false;
      limitations.push({ code: 'LABEL_EVIDENCE_MISSING', nodeId: id });
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
    if (n.styles?.display === 'none' || n.styles?.visibility === 'hidden' || n.styles?.opacity === '0') return;
    for (const child of n.children) {
      if (visited.size > 512) break;
      visit(child);
    }
  };
  for (const id of roots) visit(id, true);
  const issue = (code: string, n?: DomNodeEvidence) => {
    limitations.push({ code, nodeId: n?.id });
  };
  for (const text of texts) {
    if (context.signal.aborted) {
      issue('RULE_ABORTED');
      break;
    }
    const layout = text.textLayout;
    if (
      layout?.version !== 1 ||
      layout.status !== 'captured' ||
      layout.rects.some(r => !Object.values(r).every(Number.isFinite))
    ) {
      issue('TEXT_GEOMETRY_MISSING', text);
      continue;
    }
    const rects = layout.rects.filter(r => r.width > 0 && r.height > 0);
    if (!rects.length) continue;
    if (rects.length > 128) {
      issue('TEXT_GEOMETRY_MISSING', text);
      continue;
    }
    if (/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3\ufe0f]/u.test(text.text!)) {
      issue('COLOR_GLYPHS_UNSUPPORTED', text);
      continue;
    }
    const chain: DomNodeEvidence[] = [],
      seen = new Set<string>();
    for (
      let p = text.parentId ? nodes.get(text.parentId) : undefined;
      p && !seen.has(p.id);
      p = p.parentId ? nodes.get(p.parentId) : undefined
    ) {
      chain.push(p);
      seen.add(p.id);
      if (p.id === dom.rootId) break;
    }
    if (chain.at(-1)?.id !== dom.rootId) {
      issue('ANCESTOR_EVIDENCE_MISSING', text);
      continue;
    }
    if (active && (!dom.regionRoots[active.key] || !seen.has(dom.regionRoots[active.key]))) {
      issue('LABEL_SCOPE_UNSUPPORTED', text);
      continue;
    }
    if (
      chain.some(p => p.styles?.display === 'none' || p.styles?.opacity === '0' || p.attributes?.inert !== undefined) ||
      chain[0].styles?.visibility !== 'visible'
    )
      continue;
    const top = chain.findIndex(p => p.layout?.clipping?.topLayer),
      effective = top < 0 ? chain : chain.slice(0, top + 1);
    let unsupported = false;
    for (const p of effective) {
      const s = p.styles;
      const required = [
        'opacity',
        'filter',
        'backdrop-filter',
        'mix-blend-mode',
        'transform',
        'translate',
        'rotate',
        'scale',
        'perspective',
        'zoom',
        'clip-path',
        'mask-image',
        'clip',
        'content-visibility',
        'offset-path',
        'text-shadow',
        '-webkit-text-stroke-width',
        'appearance',
        'box-shadow',
      ];
      if (
        !s ||
        required.some(k => s[k] === undefined) ||
        p.paint?.version !== 1 ||
        !p.layout?.offset ||
        !p.rect ||
        hasRelevantGaps(p)
      ) {
        issue('ANCESTOR_EVIDENCE_MISSING', p);
        unsupported = true;
        break;
      }
      if (p.paint.motion !== 'idle') {
        issue('PAINT_MOTION_UNSETTLED', p);
        unsupported = true;
        break;
      }
      if (
        p.paint.pseudoElements.length ||
        Number(s.opacity) !== 1 ||
        s['mix-blend-mode'] !== 'normal' ||
        s.clip !== 'auto' ||
        [
          'filter',
          'backdrop-filter',
          'transform',
          'translate',
          'rotate',
          'scale',
          'perspective',
          'clip-path',
          'mask-image',
          'offset-path',
          'text-shadow',
          'box-shadow',
        ].some(k => s[k] !== 'none') ||
        !['normal', '1'].includes(s.zoom) ||
        s['content-visibility'] !== 'visible' ||
        parseFloat(s['-webkit-text-stroke-width']) !== 0 ||
        !['none', 'contents'].includes(s.appearance) ||
        p.layout.clipping?.fragmentCount !== 1
      ) {
        issue('PAINT_EFFECT_UNSUPPORTED', p);
        unsupported = true;
        break;
      }
    }
    if (unsupported) continue;
    let background: Color = [0, 0, 0, 0];
    const backgroundNodeIds: string[] = [];
    for (const p of effective) {
      const s = p.styles!,
        bg = color(s['background-color']);
      if (
        !bg ||
        s['background-image'] === undefined ||
        s['background-clip'] === undefined ||
        s['background-blend-mode'] === undefined
      ) {
        issue('BACKGROUND_COLOR_UNSUPPORTED', p);
        unsupported = true;
        break;
      }
      if (
        s['background-image'] !== 'none' ||
        s['background-blend-mode'] !== 'normal' ||
        !['border-box', 'padding-box'].includes(s['background-clip'])
      ) {
        issue('BACKGROUND_PAINT_UNSUPPORTED', p);
        unsupported = true;
        break;
      }
      if (bg[3] > 0) {
        if (
          !insideBackground(rects, p) ||
          ['inline', 'contents'].includes(s.display) ||
          s.display.startsWith('table')
        ) {
          issue('BACKGROUND_BOUNDS_UNSUPPORTED', p);
          unsupported = true;
          break;
        }
        backgroundNodeIds.push(p.id);
        background = over(background, bg);
      }
      if (background[3] === 1) break;
    }
    if (unsupported) continue;
    if (background[3] !== 1) {
      issue('OPAQUE_BACKGROUND_MISSING', text);
      continue;
    }
    // Ancestor colors alone cannot describe an intervening sibling or generated
    // layer. Do not use hit testing: pointer-events:none layers can still paint.
    for (const p of dom.nodes) {
      if (top >= 0) {
        // Native top-layer contents paint above document siblings. An ordinary
        // z-index or role=dialog alone does not establish that guarantee.
        let ancestor: DomNodeEvidence | undefined = p;
        const walked = new Set<string>();
        while (ancestor && ancestor.id !== effective.at(-1)!.id && !walked.has(ancestor.id)) {
          walked.add(ancestor.id);
          ancestor = ancestor.parentId ? nodes.get(ancestor.parentId) : undefined;
        }
        if (ancestor?.id !== effective.at(-1)!.id) continue;
      }
      if (
        p.nodeType === 'text' &&
        p.id !== text.id &&
        p.text?.trim() &&
        p.textLayout?.rects.some(r => rects.some(t => intersects(r, t)))
      ) {
        issue('INTERVENING_TEXT_UNSUPPORTED', p);
        unsupported = true;
        break;
      }
      if (
        p.nodeType !== 'element' ||
        seen.has(p.id) ||
        !p.rect ||
        !p.styles ||
        p.styles.display === 'none' ||
        p.styles.visibility !== 'visible' ||
        p.styles.opacity === '0'
      )
        continue;
      const crosses = rects.some(r => intersects(r, p.rect!));
      if (
        p.paint?.pseudoElements.some(x => x.position === 'absolute' || x.position === 'fixed') ||
        (crosses &&
          (!p.paint ||
            p.paint.pseudoElements.length ||
            ['img', 'svg', 'canvas', 'video', 'iframe'].includes(p.tag ?? '') ||
            p.styles['background-image'] !== 'none' ||
            (color(p.styles['background-color'])?.[3] ?? 1) > 0 ||
            p.styles['box-shadow'] !== 'none'))
      ) {
        issue('INTERVENING_PAINT_UNSUPPORTED', p);
        unsupported = true;
        break;
      }
    }
    if (unsupported) continue;
    if (chain[0].styles!['-webkit-text-fill-color'] === undefined) {
      issue('FOREGROUND_EVIDENCE_MISSING', text);
      continue;
    }
    const foreground = color(chain[0].styles!['-webkit-text-fill-color']);
    if (!foreground) {
      issue('FOREGROUND_COLOR_UNSUPPORTED', text);
      continue;
    }
    const rendered = over(foreground, background),
      difference = Math.max(...[0, 1, 2].map(i => Math.abs(rendered[i] - background[i])));
    samples.push({
      textNodeId: text.id,
      foreground,
      background,
      compositedForeground: rendered,
      channelDifference: difference,
      backgroundNodeIds,
    });
  }
  const label = texts.map(n => ({ nodeId: n.id, text: n.text! }));
  const requirement = bindingComplete
    ? options.requirements.find(
        r =>
          r.sessionId === inspection.sessionId &&
          r.documentId === capture.documentId &&
          r.nodeId === node.id &&
          canonical(r.label) === canonical(label),
      )
    : undefined;
  const matched = samples.filter(s => s.channelDifference <= options.channelTolerance + 1e-7);
  let assessment: RuleAssessment;
  if (requirement?.kind === 'allow-matching-label-colors')
    assessment = result(
      'not-applicable',
      'TEXT_BACKGROUND_MATCH_ALLOWED',
      'An explicit bound host requirement allows matching label colors',
    );
  else if (matched.length)
    assessment = result(
      requirement ? 'fail' : 'unknown',
      requirement ? 'TEXT_BACKGROUND_REQUIREMENT_FAILED' : 'TEXT_BACKGROUND_MATCH',
      'At least one DOM label fragment has matching foreground and background in the supported solid-color model; actual glyph visibility and product necessity are separate questions',
      requirement ? 'error' : 'warning',
    );
  else if (limitations.length)
    assessment = result(
      'unknown',
      limitations.some(i => i.code.endsWith('UNSUPPORTED'))
        ? 'TEXT_BACKGROUND_UNSUPPORTED'
        : 'TEXT_BACKGROUND_UNAVAILABLE',
      'The solid-color model cannot evaluate every label fragment; see the recorded limitations',
    );
  else if (!samples.length)
    assessment = result('not-applicable', 'NO_RENDERED_DOM_TEXT', 'No positive-area DOM label text was measured');
  else
    assessment = result(
      'pass',
      'TEXT_BACKGROUND_DISTINCT',
      'Modeled label foreground differs from its solid background; no minimum contrast or general readability claim is made',
    );
  if (requirement) {
    assessment.facts!.requirement = json(requirement);
    assessment.evidence.push(...requirement.evidence);
  }
  return assessment;
}

export const textBackgroundRule: ControlRule = {
  id: 'text-background',
  version: '1.0.0',
  name: 'Label text matching its solid background',
  description:
    'Compare captured DOM label foreground with a bounded solid sRGB background model. No WCAG verdict, pixel analysis or live browser operations.',
  requiredCapabilities: ['web.dom', 'web.layout', 'web.styles', 'web.environment'],
  optionsSchema: z.record(z.string(), z.json()).parse(z.toJSONSchema(textBackgroundOptionsSchema)),
  configure: input => {
    const options = textBackgroundOptionsSchema.parse(input);
    return context => assess(context, options);
  },
};
