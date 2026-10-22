import type { DomEvidence, DomNodeEvidence, EvidenceOptions } from './evidence-types.js';
import type { Region } from './types.js';

/** Runs in the same evaluation as the control observation. Never executes page markup. */
export function collectEvidence(limits: EvidenceOptions, regions: Region[]): DomEvidence {
  const tracker = (window as any).__interactionEvidenceTracker;
  // A reload of the same URL and dimensions can contain a different picture.
  // Observe native resource completion without fetching or modifying the page.
  if (!tracker.imageLoadEpochs) {
    tracker.imageLoadEpochs = new WeakMap<HTMLImageElement, number>();
    const loaded = (event: Event) => {
      if (event.target instanceof HTMLImageElement)
        tracker.imageLoadEpochs.set(event.target, (tracker.imageLoadEpochs.get(event.target) ?? 0) + 1);
    };
    document.addEventListener('load', loaded, { capture: true, passive: true });
    document.addEventListener('error', loaded, { capture: true, passive: true });
  }
  const id = (node: Node): string => {
    if (!tracker.ids.has(node)) tracker.ids.set(node, `${tracker.documentId}:${++tracker.counter}`);
    return tracker.ids.get(node);
  };
  const result: DomEvidence = {
    documentId: tracker.documentId,
    capturedAt: new Date().toISOString(),
    nodes: [],
    html: '',
    htmlTruncated: false,
    nodesTruncated: false,
    gaps: [],
    regionRoots: {},
    page: {
      url: location.href,
      title: document.title,
      baseURI: document.baseURI,
      language: document.documentElement?.lang || '',
      characterSet: document.characterSet,
      readyState: document.readyState,
      doctype: document.doctype ? new XMLSerializer().serializeToString(document.doctype) : '',
      activeNodeId: document.activeElement ? id(document.activeElement) : undefined,
      metadata: [],
    },
  };
  if (!document.documentElement) {
    result.gaps.push({ code: 'DOM_ROOT_UNAVAILABLE', message: 'No document element for detailed evidence' });
    return result;
  }
  result.rootId = id(document.documentElement);
  result.spatialVersion = 1;
  result.paintEnvironment = { version: 1, forcedColors: matchMedia('(forced-colors: active)').matches };
  result.textGeometry = {
    version: 1,
    coordinateSpace: 'layout-viewport-css-px',
    fonts: document.fonts?.status ?? 'unavailable',
    maxFragments: 4096,
    maxFragmentsPerNode: 128,
    fragments: 0,
    truncated: false,
  };
  const viewport = window.visualViewport;
  const scrolling = document.scrollingElement;
  result.environment = {
    layoutViewport: {
      width: innerWidth,
      height: innerHeight,
      clientWidth: document.documentElement.clientWidth,
      clientHeight: document.documentElement.clientHeight,
    },
    visualViewport: viewport
      ? {
          width: viewport.width,
          height: viewport.height,
          offsetLeft: viewport.offsetLeft,
          offsetTop: viewport.offsetTop,
          pageLeft: viewport.pageLeft,
          pageTop: viewport.pageTop,
          scale: viewport.scale,
        }
      : undefined,
    scroll: { x: scrollX, y: scrollY },
    devicePixelRatio,
    scrollingElement: scrolling
      ? {
          nodeId: id(scrolling),
          clientWidth: scrolling.clientWidth,
          clientHeight: scrolling.clientHeight,
          scrollWidth: scrolling.scrollWidth,
          scrollHeight: scrolling.scrollHeight,
          scrollLeft: scrolling.scrollLeft,
          scrollTop: scrolling.scrollTop,
        }
      : undefined,
    coordinateSpace: 'layout-viewport-css-px',
    zoom: 'visual-viewport-scale-and-dpr-only',
  };
  for (const region of regions) {
    const el = document.querySelector(region.selector);
    if (el) result.regionRoots[region.key] = id(el);
  }
  const html = `${result.page.doctype}\n${document.documentElement.outerHTML}`;
  result.html = html.slice(0, limits.maxHtmlLength);
  result.htmlTruncated = html.length > limits.maxHtmlLength;
  if (result.htmlTruncated)
    result.gaps.push({ code: 'HTML_TRUNCATED', message: `HTML exceeds ${limits.maxHtmlLength} characters` });
  const stack: { node: Node; parentId?: string }[] = [{ node: document.documentElement }];
  const byId = new Map<string, DomNodeEvidence>();
  let characters = 0;
  let sizeLimited = false;
  const essential = [
    'display',
    'visibility',
    'opacity',
    'position',
    'z-index',
    'pointer-events',
    'overflow',
    'overflow-x',
    'overflow-y',
    'color',
    'background-color',
    'font-size',
    'font-weight',
    'cursor',
    'transform',
    'direction',
    'writing-mode',
    'white-space',
    'width',
    'height',
    'min-width',
    'max-width',
    'min-height',
    'max-height',
    'box-sizing',
    'contain',
    'clip-path',
    'overflow-wrap',
    'text-overflow',
    'font-family',
    'line-height',
    'background-image',
    'outline',
    'filter',
    'isolation',
    'flex',
    'flex-direction',
    'align-items',
    'justify-content',
    'gap',
    'grid-template-columns',
    'translate',
    'rotate',
    'scale',
    'zoom',
    'perspective',
    'clip',
    'mask-image',
    'content-visibility',
    'will-change',
    'overflow-clip-margin',
    'object-fit',
    'object-position',
    'content',
    'image-orientation',
    'object-view-box',
    'offset-path',
    'background-clip',
    'background-blend-mode',
    'mix-blend-mode',
    'backdrop-filter',
    'box-shadow',
    'text-shadow',
    '-webkit-text-fill-color',
    '-webkit-text-stroke-width',
    'text-decoration-line',
    'appearance',
    'border-top-left-radius',
    'border-top-width',
    'border-top-style',
    'border-top-color',
    'border-top-right-radius',
    'border-bottom-left-radius',
    'border-bottom-right-radius',
    '-webkit-line-clamp',
    '-webkit-box-orient',
    'line-clamp',
    'text-indent',
    'text-transform',
    'column-count',
    'column-width',
    'scrollbar-width',
  ];
  while (stack.length && result.nodes.length < limits.maxNodes) {
    const { node, parentId } = stack.pop()!;
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE) continue;
    const record: DomNodeEvidence = {
      id: id(node),
      parentId,
      children: [],
      nodeType: node.nodeType === Node.TEXT_NODE ? 'text' : 'element',
      gaps: [],
    };
    const trim = (value: string, max: number, field: string) => {
      if (value.length > max)
        record.gaps.push({
          code: 'FIELD_TRUNCATED',
          message: `${field} exceeds ${max} characters`,
          reference: record.id,
        });
      return value.slice(0, max);
    };
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      record.text = trim(text, limits.maxTextLength, 'text');
      const start = text.search(/\S/),
        end = text.trimEnd().length;
      const geometry = result.textGeometry;
      record.textLayout = { version: 1, status: 'skipped', start: Math.max(0, start), end, rects: [] };
      if (start >= 0 && !node.parentElement?.closest('head,script,style,noscript,template,input,textarea,select')) {
        if (text.length > limits.maxTextLength || geometry.fragments >= geometry.maxFragments) {
          record.textLayout.status = 'truncated';
          record.textLayout.reason = 'Text or fragment budget exceeded';
          geometry.truncated = true;
        } else
          try {
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, end);
            const rects = range.getClientRects(),
              budget = Math.min(geometry.maxFragmentsPerNode, geometry.maxFragments - geometry.fragments);
            for (let i = 0; i < Math.min(rects.length, budget); i++) {
              const r = rects[i];
              record.textLayout.rects.push({ x: r.x, y: r.y, width: r.width, height: r.height });
            }
            geometry.fragments += record.textLayout.rects.length;
            record.textLayout.status = rects.length > budget ? 'truncated' : 'captured';
            if (rects.length > budget) {
              geometry.truncated = true;
              record.textLayout.reason = 'Text fragment budget exceeded';
            }
          } catch {
            record.textLayout.status = 'unavailable';
            record.textLayout.reason = 'Range geometry could not be read';
          }
      }
    } else {
      const el = node as HTMLElement;
      record.tag = el.tagName.toLowerCase();
      record.attributes = {};
      for (const attr of el.attributes)
        record.attributes[attr.name] = trim(attr.value, limits.maxAttributeLength, `attribute:${attr.name}`);
      const r = el.getBoundingClientRect();
      record.rect = { x: r.x, y: r.y, width: r.width, height: r.height };
      const style = getComputedStyle(el);
      record.styles = {};
      for (const key of limits.styles === 'all' ? Array.from(style) : limits.styles === 'essential' ? essential : [])
        record.styles[key] = trim(style.getPropertyValue(key), limits.maxAttributeLength, `style:${key}`);
      record.paint = {
        version: 1,
        motion: el.getAnimations().some(a => a.playState === 'running' || a.pending) ? 'running' : 'idle',
        pseudoElements: (['before', 'after'] as const).flatMap(kind => {
          const pseudo = getComputedStyle(el, `::${kind}`);
          return !['none', 'normal'].includes(pseudo.content) &&
            pseudo.display !== 'none' &&
            pseudo.visibility === 'visible'
            ? [{ kind, position: pseudo.position }]
            : [];
        }),
      };
      const scrollAncestorIds: string[] = [];
      const clipAncestorIds: string[] = [];
      // These are DOM ancestor chains, not logical overlay ownership. Hit testing
      // is one visible center sample, never a claim of complete pixel visibility.
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        const ps = getComputedStyle(parent);
        const overflow = `${ps.overflowX} ${ps.overflowY}`;
        if (/(auto|scroll|hidden)/.test(overflow) || parent === scrolling) scrollAncestorIds.push(id(parent));
        if (/(auto|scroll|hidden|clip)/.test(overflow) || ps.clipPath !== 'none' || /paint/.test(ps.contain))
          clipAncestorIds.push(id(parent));
      }
      const x = Math.max(0, r.left) + (Math.min(innerWidth, r.right) - Math.max(0, r.left)) / 2;
      const y = Math.max(0, r.top) + (Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) / 2;
      const inView =
        r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
      const hit = inView ? document.elementFromPoint(x, y) : null;
      record.layout = {
        coordinateSpace: 'layout-viewport-css-px',
        clipping: {
          version: 1,
          topLayer: el.matches(':modal, :popover-open, :fullscreen'),
          fragmentCount: el.getClientRects().length,
        },
        client: { width: el.clientWidth, height: el.clientHeight, left: el.clientLeft, top: el.clientTop },
        scroll: { width: el.scrollWidth, height: el.scrollHeight, left: el.scrollLeft, top: el.scrollTop },
        offset:
          el instanceof HTMLElement
            ? {
                width: el.offsetWidth,
                height: el.offsetHeight,
                left: el.offsetLeft,
                top: el.offsetTop,
                parentId: el.offsetParent ? id(el.offsetParent) : undefined,
              }
            : undefined,
        box: {
          padding: ['top', 'right', 'bottom', 'left'].map(side => style.getPropertyValue(`padding-${side}`)),
          border: ['top', 'right', 'bottom', 'left'].map(side => style.getPropertyValue(`border-${side}-width`)),
          margin: ['top', 'right', 'bottom', 'left'].map(side => style.getPropertyValue(`margin-${side}`)),
        },
        scrollAncestorIds,
        clipAncestorIds,
        hitSample: inView
          ? { x, y, topNodeId: hit ? id(hit) : undefined, withinSubtree: !!hit && el.contains(hit) }
          : undefined,
        hitSamples: inView
          ? [
              [0.5, 0.5],
              [0.2, 0.2],
              [0.8, 0.2],
              [0.2, 0.8],
              [0.8, 0.8],
            ].map(([fx, fy]) => {
              const px = Math.max(0, r.left) + (Math.min(innerWidth, r.right) - Math.max(0, r.left)) * fx;
              const py = Math.max(0, r.top) + (Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) * fy;
              const top = document.elementFromPoint(px, py);
              return { x: px, y: py, topNodeId: top ? id(top) : undefined, withinSubtree: !!top && el.contains(top) };
            })
          : undefined,
      };
      record.properties = {};
      if (el instanceof HTMLImageElement) {
        const resource = (window as any).__interactionImageResources?.read(el);
        if (resource)
          resource.sourceKey = trim(resource.sourceKey, Math.min(20000, limits.maxTextLength), 'image:sourceKey');
        const edges = (axis: string[]) =>
          axis.reduce(
            (sum, side) =>
              sum +
              parseFloat(style.getPropertyValue(`padding-${side}`)) +
              parseFloat(style.getPropertyValue(`border-${side}-width`)),
            0,
          );
        const width = parseFloat(style.width) - (style.boxSizing === 'border-box' ? edges(['left', 'right']) : 0);
        const height = parseFloat(style.height) - (style.boxSizing === 'border-box' ? edges(['top', 'bottom']) : 0);
        let moving = false;
        for (let ancestor: Element | null = el; ancestor; ancestor = ancestor.parentElement) {
          moving ||= ancestor.getAnimations().some(a => a.playState === 'running' || a.pending);
        }
        record.image = {
          version: 1,
          currentSrc: trim(el.currentSrc, limits.maxAttributeLength, 'image:currentSrc'),
          ...(resource ? { resource } : {}),
          complete: el.complete,
          naturalWidth: el.naturalWidth,
          naturalHeight: el.naturalHeight,
          loadEpoch: tracker.imageLoadEpochs.get(el) ?? 0,
          ...(Number.isFinite(width) && Number.isFinite(height) ? { contentBox: { width, height } } : {}),
          motion: moving ? 'running' : 'idle',
        };
      }
      for (const key of [
        'value',
        'checked',
        'indeterminate',
        'selected',
        'selectedIndex',
        'disabled',
        'readOnly',
        'required',
        'type',
        'tabIndex',
        'contentEditable',
        'href',
        'action',
        'method',
        'target',
        'validationMessage',
      ]) {
        const value = (el as any)[key];
        if (typeof value === 'string') record.properties[key] = trim(value, limits.maxTextLength, `property:${key}`);
        else if (typeof value === 'boolean' || typeof value === 'number') record.properties[key] = value;
      }
      if ((el as HTMLInputElement).validity) {
        const validity = (el as HTMLInputElement).validity;
        record.properties.validity = Object.fromEntries(
          [
            'valid',
            'valueMissing',
            'typeMismatch',
            'patternMismatch',
            'tooLong',
            'tooShort',
            'rangeUnderflow',
            'rangeOverflow',
            'stepMismatch',
            'badInput',
            'customError',
          ].map(key => [key, (validity as any)[key]]),
        );
      }
      record.relations = {};
      for (const attr of [
        'aria-labelledby',
        'aria-describedby',
        'aria-controls',
        'aria-owns',
        'aria-details',
        'aria-errormessage',
        'for',
        'list',
        'popovertarget',
      ]) {
        const targets = (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean);
        if (targets.length)
          record.relations[attr] = targets.flatMap(target => {
            const element = document.getElementById(target);
            if (!element) {
              record.gaps.push({ code: 'UNRESOLVED_DOM_RELATION', message: `${attr} references missing #${target}` });
              return [];
            }
            return [id(element)];
          });
      }
      const input = el as HTMLInputElement;
      if (input.labels?.length) record.relations.labels = Array.from(input.labels).map(id);
      if (input.form) record.relations.form = [id(input.form)];
      if (el.shadowRoot)
        record.gaps.push({
          code: 'SHADOW_CONTENT_NOT_CAPTURED',
          message: 'Shadow root contents are not part of this DOM tree',
        });
      if (el.tagName === 'IFRAME')
        record.gaps.push({
          code: 'FRAME_CONTENT_NOT_CAPTURED',
          message: 'Frame metadata is available; child document is not captured',
        });
    }
    const parent = parentId ? byId.get(parentId) : undefined;
    characters +=
      JSON.stringify(record).length +
      (parent ? JSON.stringify(record.id).length + (parent.children.length ? 1 : 0) : 0);
    if (characters > limits.maxDomCharacters) {
      sizeLimited = true;
      break;
    }
    if (record.tag === 'meta') result.page.metadata.push(record.attributes!);
    result.nodes.push(record);
    byId.set(record.id, record);
    if (parentId) byId.get(parentId)?.children.push(record.id);
    for (let child = node.lastChild; child; child = child.previousSibling)
      stack.push({ node: child, parentId: record.id });
  }
  result.nodesTruncated = stack.length > 0 || sizeLimited;
  // Reading layout can start a previously unused font load. Keep either end's
  // unsettled state rather than reporting the initial "loaded" value as settled.
  if (document.fonts?.status === 'loading') result.textGeometry.fonts = 'loading';
  if (result.nodesTruncated)
    result.gaps.push({
      code: 'DOM_TREE_TRUNCATED',
      message: `DOM exceeded its node (${limits.maxNodes}) or character (${limits.maxDomCharacters}) budget; missing children and relationship targets may be outside the captured range`,
    });
  return result;
}
