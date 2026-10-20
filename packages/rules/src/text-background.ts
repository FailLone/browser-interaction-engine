import { z } from 'zod';
import { canonical } from './util.js';
import type { DomNodeEvidence, Json, Rect, RulePage, ViewportPixels } from './types.js';
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
    /**
     * Where the background is read from the screenshot, a contrast ratio below this means the
     * label does not stand out from it. Not WCAG's 4.5: it marks text hard to tell from its
     * background at all, the defect this rule names.
     */
    pixelContrast: z.number().min(1).max(21).default(1.5),
    /** Only say whether a screenshot would be read (`facts.wantsPixels`); used to decide whether to take one. */
    probe: z.boolean().default(false),
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
  /** 'pixels' when the background was read from the screenshot, not modeled from styles. */
  source?: 'pixels';
  contrast?: number;
  glyphShare?: number;
  foreground: Color;
  background: Color;
  compositedForeground: Color;
  channelDifference: number;
  backgroundNodeIds: string[];
};

const luminance = (c: Color) => {
  const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const contrast = (a: Color, b: Color) => {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/**
 * The background a label is painted on, read from the screenshot instead of modeled: pixels in the
 * text's own boxes that are not the glyphs. A pixel within `glyph` of the known text color is a
 * glyph; one far from it (beyond half the farthest pixel's distance) is background, and the
 * antialiased edge in between is left out. The text color must show (some glyph pixels) or the
 * screenshot does not show this text as modeled: covered, recolored, not painted.
 */
function pixelBackground(
  pixels: ViewportPixels,
  rects: Rect[],
  foreground: Color,
): { background: Color; difference: number; contrast: number; glyphShare: number } | string {
  const { width, height, scale, data } = pixels;
  const distance = (i: number) =>
    Math.max(
      Math.abs(data[i] - foreground[0]),
      Math.abs(data[i + 1] - foreground[1]),
      Math.abs(data[i + 2] - foreground[2]),
    );
  const all: number[] = [];
  for (const r of rects) {
    const x0 = Math.round(r.x * scale),
      y0 = Math.round(r.y * scale),
      x1 = Math.round((r.x + r.width) * scale),
      y1 = Math.round((r.y + r.height) * scale);
    if (x0 < 0 || y0 < 0 || x1 > width || y1 > height) return 'PIXELS_OUTSIDE_VIEWPORT';
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) all.push((y * width + x) * 4);
  }
  if (all.length < 16) return 'PIXELS_TOO_FEW';
  const glyph = 24;
  let far = 0,
    glyphs = 0;
  const d = all.map(i => {
    const v = distance(i);
    if (v <= glyph) glyphs++;
    if (v > far) far = v;
    return v;
  });
  const glyphShare = glyphs / all.length;
  // Same color as the text everywhere: the label does not stand out from what is behind it.
  if (far <= glyph) return { background: foreground, difference: far, contrast: 1, glyphShare };
  if (glyphShare < 0.02) return 'PIXELS_TEXT_COLOR_ABSENT';
  // Glyphs cover a minority of their own box. When most of it is the text color, the box shows
  // something else (a layer over it, a background partly the text color): not a settled reading.
  if (glyphShare > 0.4) return 'PIXELS_TEXT_COLOR_DOMINANT';
  const back = all.filter((_, k) => d[k] >= far / 2);
  // The background is what lies behind most of the box; take its least distinct tenth.
  const ranked = back
    .map(i => [data[i], data[i + 1], data[i + 2], 1] as Color)
    .sort((a, b) => contrast(a, foreground) - contrast(b, foreground));
  const worst = ranked[Math.floor(ranked.length * 0.1)];
  return {
    background: worst,
    difference: Math.max(...[0, 1, 2].map(i => Math.abs(worst[i] - foreground[i]))),
    contrast: contrast(worst, foreground),
    glyphShare,
  };
}

function assess(context: RuleContext, options: z.output<typeof textBackgroundOptionsSchema>): RuleAssessment {
  const { control, node, dom, observation, inspection, capture } = context;
  const roots = textLabelRoots(context),
    nodes = new Map(dom.nodes.map(n => [n.id, n]));
  const texts: DomNodeEvidence[] = [],
    samples: Sample[] = [],
    limitations: { code: string; nodeId?: string; textNodeId?: string }[] = [];
  let bindingComplete = true;
  /** In a probe: some fragment would be read from a screenshot. */
  let wanted = false;
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
          : code === 'TEXT_BACKGROUND_UNAVAILABLE' || code === 'TEXT_BACKGROUND_OFFSCREEN'
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
  // Each limitation is about the label fragment being judged when it was found.
  let current: string | undefined;
  const issue = (code: string, n?: DomNodeEvidence) => {
    limitations.push({ code, nodeId: n?.id, textNodeId: current });
  };
  const offscreen = new Set<string>();
  for (const text of texts) {
    current = text.id;
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
    // Off this screen. The color model still judges it; only when that cannot is it left for a
    // capture that shows it, rather than counted as unsupported here.
    const view = dom.environment?.layoutViewport;
    if (
      view &&
      rects.some(r => r.x < 0 || r.y < 0 || r.x + r.width > view.clientWidth || r.y + r.height > view.clientHeight)
    )
      offscreen.add(text.id);
    // Deciding whether to take a screenshot: text off it cannot be read from it.
    if (options.probe && offscreen.has(text.id)) continue;
    /**
     * When the style model gives up on this fragment, read its background from the screenshot
     * instead: allowed only while the text's own color is what reaches the screen (nothing on the
     * text's ancestors recolors or hides glyphs), so the known text color can find the glyphs.
     */
    const fromPixels = (chain: DomNodeEvidence[]) => {
      const pixels = context.snapshot.pixels;
      if (!pixels && !options.probe) return false;
      // Off this screenshot: the screen that shows it reads it.
      if (offscreen.has(text.id)) return false;
      // The screenshot shows whatever is on top. Where the control's own hit points land on
      // something else (a layer, a backdrop), its pixels are that layer, not the label's background.
      const hits = node.layout?.hitSamples;
      if (!hits?.length || hits.some(h => !h.withinSubtree)) {
        limitations.push({ code: hits?.length ? 'PIXELS_COVERED' : 'PIXELS_HIT_UNKNOWN', nodeId: text.id });
        return false;
      }
      const fill = color(chain[0]?.styles?.['-webkit-text-fill-color']);
      if (!fill || fill[3] !== 1) return false;
      const recolors = chain.some(p => {
        const s = p.styles;
        return (
          !s ||
          p.paint?.motion !== 'idle' ||
          Number(s.opacity) !== 1 ||
          s.filter !== 'none' ||
          s['mix-blend-mode'] !== 'normal' ||
          s['text-shadow'] !== 'none' ||
          parseFloat(s['-webkit-text-stroke-width'] ?? '0') !== 0 ||
          s['clip-path'] !== 'none' ||
          s['mask-image'] !== 'none'
        );
      });
      if (recolors) return false;
      // Asked only whether a screenshot would be read here: it would.
      if (!pixels) {
        wanted = true;
        return false;
      }
      const read = pixelBackground(pixels, rects, fill);
      if (typeof read === 'string') {
        limitations.push({ code: read, nodeId: text.id });
        return false;
      }
      samples.push({
        textNodeId: text.id,
        source: 'pixels',
        contrast: Math.round(read.contrast * 100) / 100,
        glyphShare: Math.round(read.glyphShare * 100) / 100,
        foreground: fill,
        background: read.background,
        compositedForeground: fill,
        channelDifference: read.difference,
        backgroundNodeIds: [],
      });
      return true;
    };
    /** Drop the style model's limitation for this fragment when pixels settled it. */
    const settle = (chain: DomNodeEvidence[]) => {
      const before = limitations.length;
      if (!fromPixels(chain)) return;
      // The model's limitation was the last pushed before the attempt.
      limitations.splice(before - 1, 1);
    };
    if (rects.length > 128) {
      issue('TEXT_GEOMETRY_MISSING', text);
      continue;
    }
    if (/[\p{Extended_Pictographic}\p{Regional_Indicator}]|\u20e3|\ufe0f/u.test(text.text!)) {
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
    if (unsupported) {
      settle(chain);
      continue;
    }
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
    if (unsupported) {
      settle(chain);
      continue;
    }
    if (background[3] !== 1) {
      issue('OPAQUE_BACKGROUND_MISSING', text);
      settle(chain);
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
    if (unsupported) {
      settle(chain);
      continue;
    }
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
  const matched = samples.filter(s =>
    s.source === 'pixels'
      ? s.contrast! < options.pixelContrast
      : s.channelDifference <= options.channelTolerance + 1e-7,
  );
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
  else if (limitations.length && limitations.every(i => i.textNodeId && offscreen.has(i.textNodeId)))
    assessment = result(
      'unknown',
      'TEXT_BACKGROUND_OFFSCREEN',
      'Label text is not wholly on screen in this capture; a capture that shows it judges it',
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
  if (wanted) assessment.facts!.wantsPixels = true;
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

/**
 * Whether a screenshot of this capture would let the rule read a background the color model cannot:
 * some active, on-screen control whose label the model gives up on, with nothing on it or its
 * label that hides or recolors glyphs. Reads only the DOM; decides whether to take a screenshot.
 */
export function wantsPixels(page: RulePage): boolean {
  const dom = page.snapshot.dom;
  if (!dom || page.snapshot.pixels) return false;
  const nodes = new Map(dom.nodes.map(n => [n.id, n]));
  const options = textBackgroundOptionsSchema.parse({ probe: true });
  const signal = new AbortController().signal;
  const view = dom.environment?.layoutViewport;
  for (const control of page.observation.controls) {
    // Only what this screenshot would show: active controls wholly on screen.
    const r = control.rect;
    if (!control.visible || !control.enabled || !view) continue;
    if (r.x < 0 || r.y < 0 || r.x + r.width > view.clientWidth || r.y + r.height > view.clientHeight) continue;
    const node = nodes.get(control.localId);
    if (!node) continue;
    const result = assess(
      {
        inspection: page.inspection,
        capture: page.capture,
        observation: page.observation,
        snapshot: page.snapshot,
        dom,
        control,
        node,
        signal,
      },
      options,
    );
    if (result.facts?.wantsPixels) return true;
  }
  return false;
}
