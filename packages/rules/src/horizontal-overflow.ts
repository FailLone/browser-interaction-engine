import { z } from 'zod';
import type { DomEvidence, DomNodeEvidence, Json, Rect, RuleCheck, RulePage, RuleReport } from './types.js';

export const horizontalOverflowOptionsSchema = z
  .object({
    /** Sub-pixel rounding is not overflow. */
    tolerancePx: z.number().min(0).max(8).default(1),
  })
  .strict();
export type HorizontalOverflowOptions = z.input<typeof horizontalOverflowOptionsSchema>;

export const horizontalOverflowRule = {
  id: 'observed-horizontal-overflow',
  version: '1.0.0',
  name: 'Horizontal overflow',
  effects: 'read-history' as const,
  description:
    'From one frozen capture: content that makes the page scroll sideways, sits left of the page where no scroll reaches it, or is cut off by a container that cannot scroll. Never scrolls or clicks.',
  optionsSchema: z.record(z.string(), z.json()).parse(z.toJSONSchema(horizontalOverflowOptionsSchema)),
};

type Node = DomNodeEvidence;
const hidden = ['hidden', 'clip'];
const scrollable = ['auto', 'scroll'];

/**
 * What a user loses sideways, read from one capture. Three cases are defects: the page scrolls
 * sideways (`PAGE_SCROLLS_HORIZONTALLY`), content sits left of the page where no scroll reaches
 * (`CONTENT_UNREACHABLE_LEFT`), and text or images are cut off by a container that does not scroll
 * (`CONTENT_CUT_OFF`). Overflow inside a scrollable container, a fixed or invisible layer, a
 * carousel track and decoration without content are by design. Controls are left to the
 * clipping rule. Each culprit is reported once: the outermost element that sticks out.
 */
export class HorizontalOverflowTracker {
  private readonly options;
  constructor(input: HorizontalOverflowOptions = {}) {
    this.options = horizontalOverflowOptionsSchema.parse(input);
  }

  async run(page: RulePage): Promise<RuleReport> {
    const dom = page.snapshot.dom,
      env = dom?.environment,
      root = env?.scrollingElement;
    const report = (checks: RuleCheck[]): RuleReport => ({
      schemaVersion: 1,
      inspectionId: page.inspection.id,
      captureId: page.capture.id,
      documentId: page.capture.documentId,
      ruleId: horizontalOverflowRule.id,
      ruleVersion: horizontalOverflowRule.version,
      selection: { ruleId: horizontalOverflowRule.id, ruleVersion: horizontalOverflowRule.version },
      verdict: checks.some(c => c.verdict === 'fail')
        ? 'fail'
        : checks.some(c => c.verdict === 'unknown')
          ? 'unknown'
          : checks.length
            ? 'pass'
            : 'not-applicable',
      severity: checks.some(c => c.severity === 'warning') ? 'warning' : 'info',
      checks,
    });
    if (!dom || !env || !root) return report([]);
    const nodes = new Map(dom.nodes.map(n => [n.id, n]));
    const tolerance = this.options.tolerancePx;
    const viewportWidth = root.clientWidth;
    const pageScrolls = root.scrollWidth > viewportWidth + tolerance;
    // The root clips sideways when html or body hides x-overflow (body's value propagates to the viewport).
    const rootNode = nodes.get(root.nodeId);
    const body = rootNode?.children.map(id => nodes.get(id)).find(n => n?.tag === 'body');
    const rootClips = [rootNode, body].some(n => hidden.includes(n?.styles?.['overflow-x'] ?? ''));
    // A right-to-left or vertical page scrolls from the other side; an RTL element in an LTR page is fine.
    if (
      [rootNode, body].some(n => n?.styles?.direction === 'rtl' || /vertical/.test(n?.styles?.['writing-mode'] ?? ''))
    )
      return report([
        this.check(
          page,
          dom,
          undefined,
          'unknown',
          'info',
          'OVERFLOW_UNSUPPORTED_DIRECTION',
          'Right-to-left or vertical pages are not assessed',
          {},
        ),
      ]);

    const ancestors = (n: Node) => {
      const out: Node[] = [];
      for (let p = n.parentId && nodes.get(n.parentId); p; p = p.parentId && nodes.get(p.parentId)) out.push(p);
      return out;
    };
    const isRoot = (n: Node) => n.id === root.nodeId || n === body;
    const seen = (n: Node) => {
      const s = n.styles ?? {};
      return (
        s.display !== 'none' &&
        s.visibility === 'visible' &&
        s.opacity !== '0' &&
        !!n.rect &&
        n.rect.width > 0 &&
        n.rect.height > 0 &&
        n.attributes?.hidden === undefined &&
        n.attributes?.inert === undefined &&
        n.attributes?.['aria-hidden'] !== 'true'
      );
    };
    // With a dialog or popup open, only it is in front of the user; the page behind it is not
    // assessed (OKX locks the page under its region dialog, so what sticks out there is not seen).
    const active = page.observation.overlays?.at(-1);
    const scopeRoot = active ? dom.regionRoots[active.key] : undefined;
    if (active && !scopeRoot)
      return report([
        this.check(page, dom, undefined, 'unknown', 'info', 'SCOPE_UNKNOWN', 'The open overlay was not captured', {}),
      ]);
    const inScope = (n: Node) => !scopeRoot || n.id === scopeRoot || ancestors(n).some(a => a.id === scopeRoot);
    /** Why this element's overflow is not a defect, or undefined when nothing excuses it. */
    const excuse = (n: Node, chain: Node[]): string | undefined => {
      if (!seen(n)) return 'invisible';
      // The open dialog is itself fixed; it is the surface under test, not an off-canvas layer.
      if (n.id === scopeRoot) return undefined;
      if (n.styles?.position === 'fixed') return 'fixed-layer';
      for (const a of chain) {
        if (isRoot(a) || a.id === scopeRoot) break;
        if (!seen(a)) return 'invisible';
        if (a.styles?.position === 'fixed') return 'fixed-layer';
        if (scrollable.includes(a.styles?.['overflow-x'] ?? '')) return 'scroll-container';
        if (hidden.includes(a.styles?.['overflow-x'] ?? '') && carousel(a)) return 'carousel';
      }
      return undefined;
    };
    /** A clipping track whose children are a row of same-sized slides. */
    const carousel = (clip: Node) => {
      const track = [clip, ...clip.children.map(id => nodes.get(id)!).filter(Boolean)].find(
        n => n.children.filter(id => nodes.get(id)?.nodeType === 'element').length >= 2,
      );
      const slides = track?.children
        .map(id => nodes.get(id))
        .filter((n): n is Node => n?.nodeType === 'element' && !!n.rect && n.rect.width > 0);
      if (!slides || slides.length < 2) return /carousel|slider|swiper|slick|marquee|ticker/i.test(classes(clip));
      const w = slides[0].rect!.width;
      const sameSize = slides.every(s => Math.abs(s.rect!.width - w) <= 2);
      const row = new Set(slides.map(s => Math.round(s.rect!.y))).size === 1;
      return (sameSize && row) || /carousel|slider|swiper|slick|marquee|ticker/i.test(classes(clip));
    };
    const controlIds = new Set(page.observation.controls.map(c => c.localId));
    /** Visible text and images inside `n` that lie outside [left, right]; a control and its label are counted, not inspected. */
    const lost = (n: Node, left: number, right: number) => {
      const out = { text: [] as string[], images: 0, controls: 0 };
      const stack = [n];
      while (stack.length) {
        const c = stack.pop()!;
        if (c.nodeType === 'element' && !seen(c)) continue;
        if (controlIds.has(c.id)) {
          // The clipping and text-truncation rules own controls and their labels.
          if (c.rect && (c.rect.x < left - tolerance || c.rect.x + c.rect.width > right + tolerance)) out.controls++;
          continue;
        }
        if (c.nodeType === 'text' && c.textLayout?.status === 'captured') {
          if (c.textLayout.rects.some(r => r.x < left - tolerance || r.x + r.width > right + tolerance))
            out.text.push((c.text ?? '').trim().slice(0, 60));
        } else if (c.rect && (c.rect.x < left - tolerance || c.rect.x + c.rect.width > right + tolerance)) {
          if (['img', 'svg', 'video', 'canvas', 'picture'].includes(c.tag ?? '')) out.images++;
        }
        for (const id of c.children) {
          const child = nodes.get(id);
          if (child) stack.push(child);
        }
      }
      return out;
    };
    const decorative = (n: Node) => n.styles?.['pointer-events'] === 'none';

    const checks: RuleCheck[] = [];
    const claimed = new Set<string>();
    const elements = dom.nodes.filter(
      n => n.nodeType === 'element' && n.rect && !isRoot(n) && n.tag !== 'head' && inScope(n),
    );
    // Document order: an element is reached before its descendants, so the outermost culprit wins.
    for (const n of elements) {
      if (ancestors(n).some(a => claimed.has(a.id))) continue;
      const r = n.rect!,
        chain = ancestors(n);
      // Overflow at the page edge: past the right edge (scrolls) or left of 0 (unreachable).
      const clipper = chain.find(a => !isRoot(a) && hidden.includes(a.styles?.['overflow-x'] ?? ''));
      const bounds = clipper?.rect
        ? { left: clipper.rect.x, right: clipper.rect.x + clipper.rect.width, by: clipper }
        : { left: 0, right: viewportWidth, by: undefined };
      const overRight = r.x + r.width - bounds.right,
        overLeft = bounds.left - r.x;
      if (overRight <= tolerance && overLeft <= tolerance) continue;
      // Only an element whose own box crosses the edge is a culprit, not one merely inside one that does.
      const parent = n.parentId ? nodes.get(n.parentId) : undefined;
      if (parent && !isRoot(parent) && parent.rect) {
        const pr = parent.rect;
        if (r.x >= pr.x - tolerance && r.x + r.width <= pr.x + pr.width + tolerance && parent !== bounds.by) continue;
      }
      const why = excuse(n, chain);
      if (why) continue;
      const content = lost(n, bounds.left, bounds.right);
      // Past the page edge, a control counts as content: no rule but this one sees the page scroll.
      // Inside a clipping container, controls are the clipping rule's.
      const hasContent =
        content.text.length > 0 || content.images > 0 || (!bounds.by && !rootClips && content.controls > 0);
      const facts: Record<string, Json> = {
        rect: rect(r),
        overflowLeftPx: round(Math.max(0, overLeft)),
        overflowRightPx: round(Math.max(0, overRight)),
        lostText: content.text.slice(0, 5),
        lostImages: content.images,
        lostControls: content.controls,
        viewportWidth,
        scrollWidth: root.scrollWidth,
      };
      if (bounds.by) {
        // Cut off inside a container that cannot scroll. Controls are the clipping rule's.
        if (!hasContent || decorative(n)) continue;
        claimed.add(n.id);
        checks.push(
          this.check(
            page,
            dom,
            n,
            'fail',
            'warning',
            'CONTENT_CUT_OFF',
            `Content is cut off by a container that hides overflow and cannot scroll${content.text[0] ? `: "${content.text[0]}"` : ''}`,
            { ...facts, clipContainerId: bounds.by.id, clipContainer: describe(bounds.by) },
          ),
        );
        continue;
      }
      if (rootClips) {
        // The page hides sideways overflow: nothing scrolls, but content past either edge is lost.
        if (!hasContent || decorative(n)) continue;
        claimed.add(n.id);
        checks.push(
          this.check(
            page,
            dom,
            n,
            'fail',
            'warning',
            'CONTENT_CUT_OFF',
            `Content runs past the page edge, which hides overflow, and cannot be reached${content.text[0] ? `: "${content.text[0]}"` : ''}`,
            { ...facts, clipContainer: 'page' },
          ),
        );
        continue;
      }
      if (overLeft > tolerance && hasContent) {
        claimed.add(n.id);
        checks.push(
          this.check(
            page,
            dom,
            n,
            'fail',
            'warning',
            'CONTENT_UNREACHABLE_LEFT',
            `Content sits ${round(overLeft)}px left of the page, where no scroll reaches${content.text[0] ? `: "${content.text[0]}"` : ''}`,
            facts,
          ),
        );
        continue;
      }
      if (overRight > tolerance && pageScrolls) {
        claimed.add(n.id);
        checks.push(
          this.check(
            page,
            dom,
            n,
            'fail',
            hasContent ? 'warning' : 'info',
            'PAGE_SCROLLS_HORIZONTALLY',
            `The page scrolls sideways by ${root.scrollWidth - viewportWidth}px because this element is ${round(overRight)}px wider than the viewport${hasContent ? '; content past the edge is only seen by scrolling sideways' : '; nothing but empty space is past the edge'}`,
            facts,
          ),
        );
      }
    }
    // The page scrolls sideways but no visible element accounts for it (e.g. a margin or pseudo-element).
    if (!active && pageScrolls && !checks.some(c => Number(c.facts?.overflowRightPx) > tolerance))
      checks.push(
        this.check(
          page,
          dom,
          undefined,
          'fail',
          'info',
          'PAGE_SCROLLS_HORIZONTALLY',
          `The page scrolls sideways by ${root.scrollWidth - viewportWidth}px; no visible element was found past the edge`,
          { viewportWidth, scrollWidth: root.scrollWidth },
        ),
      );
    // Scrollable containers with no visible hint that they scroll: recorded, not reported.
    for (const n of elements) {
      if (!scrollable.includes(n.styles?.['overflow-x'] ?? '') || !n.layout || !seen(n)) continue;
      if (n.layout.scroll.width <= n.layout.client.width + tolerance) continue;
      if (n.styles?.['scrollbar-width'] !== 'none') continue;
      checks.push(
        this.check(
          page,
          dom,
          n,
          'unknown',
          'info',
          'HIDDEN_SCROLLBAR',
          'Scrolls sideways with its scrollbar hidden; whether anything hints at more content is not assessed',
          {
            clientWidth: n.layout.client.width,
            scrollWidth: n.layout.scroll.width,
          },
        ),
      );
    }
    // The crawler reports the same rule, selector and text once per crawl.
    return report(checks);
  }

  private check(
    page: RulePage,
    dom: DomEvidence,
    node: Node | undefined,
    verdict: RuleCheck['verdict'],
    severity: RuleCheck['severity'],
    code: string,
    actual: string,
    facts: Record<string, Json>,
  ): RuleCheck {
    return {
      verdict,
      severity,
      code,
      expected: 'Content fits the viewport sideways, or sits in a container the user can scroll',
      actual,
      evidence: [page.capture.id, ...(node ? [`node:${dom.documentId}:${node.id}`] : [])],
      ...(node ? { target: { captureId: page.capture.id, documentId: dom.documentId, nodeId: node.id } } : {}),
      facts: {
        ...facts,
        element: node ? describe(node) : 'page',
        selector: node ? selectorOf(node, new Map(dom.nodes.map(n => [n.id, n]))) : 'html',
      },
    };
  }
}

/** nth-of-type path from the captured tree, as the crawler builds control selectors. */
const selectorOf = (n: Node, nodes: Map<string, Node>) => {
  const parts: string[] = [];
  for (let c: Node | undefined = n; c?.tag && c.tag !== 'html'; c = c.parentId ? nodes.get(c.parentId) : undefined) {
    const parent = c.parentId ? nodes.get(c.parentId) : undefined;
    const same = parent ? parent.children.map(id => nodes.get(id)).filter(s => s?.tag === c!.tag) : [c];
    parts.unshift(`${c.tag}:nth-of-type(${same.indexOf(c) + 1})`);
  }
  return `html > ${parts.join(' > ')}`;
};
const round = (v: number) => Math.round(v * 10) / 10;
const rect = (r: Rect) => ({ x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) });
const classes = (n: Node) => n.attributes?.class ?? '';
/** A short, stable description: tag, id or first classes. Volatile hashes in class names are kept; they are the page's own. */
const describe = (n: Node) =>
  `${n.tag ?? 'node'}${n.attributes?.id ? `#${n.attributes.id}` : ''}${classes(n)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(c => `.${c}`)
    .join('')}`;
