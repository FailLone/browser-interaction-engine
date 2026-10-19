import type { Control, Overlay, Region } from './types.js';

/** Serialized into the page. Semantic evidence is preferred to styling heuristics. */
export function collectOverlays(controls: Control[], regions: Region[], describeControls?: (roots: Element[]) => void, popupRelations: { content: Element; panel: Element; trigger?: Element }[] = []) {
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && !el.closest('[hidden]');
  };
  const selector = (el: Element): string => {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parts: string[] = [];
    for (let p: Element | null = el; p && p !== document.documentElement; p = p.parentElement) {
      let index = 1; for (let sibling = p.previousElementSibling; sibling; sibling = sibling.previousElementSibling) if (sibling.tagName === p.tagName) index++;
      parts.unshift(`${p.tagName.toLowerCase()}:nth-of-type(${index})`);
    }
    return `html > ${parts.join(' > ')}`;
  };
  const elements = new Map(controls.map(c => [c.localId, document.querySelector(c.selector)!]));
  const tracker = (window as any).__interactionEvidenceTracker;
  const candidates = new Map<Element, { kind: Overlay['kind']; evidence: string[] }>();
  const add = (el: Element, kind: Overlay['kind'], evidence: string) => {
    if (!visible(el)) return;
    const prior = candidates.get(el);
    if (prior) { prior.evidence.push(evidence); if (kind === 'modal') prior.kind = kind; }
    else candidates.set(el, { kind, evidence: [evidence] });
  };
  for (const el of document.querySelectorAll('dialog,[role=dialog],[role=alertdialog],[aria-modal=true],[popover],[role=menu],[role=listbox]')) {
    if (el.matches(':modal')) add(el, 'modal', 'native-modal');
    else if (el.getAttribute('aria-modal') === 'true') add(el, 'modal', 'aria-modal');
    else if (el.matches('dialog[open],[role=dialog],[role=alertdialog]')) add(el, 'dialog', 'dialog-semantics');
    else if (el.matches(':popover-open')) add(el, 'popover', 'native-popover-open');
    else if (el.matches('[role=menu],[role=listbox]')) {
      const positioned = ['absolute', 'fixed'].includes(getComputedStyle(el).position);
      const owned = [...document.querySelectorAll('[aria-expanded=true]')].some(c => [c.getAttribute('aria-controls'), c.getAttribute('aria-owns')].some(ids => el.id && ids?.split(/\s+/).includes(el.id)));
      if (positioned || owned) add(el, el.getAttribute('role') as 'menu' | 'listbox', owned ? 'expanded-owner' : 'positioned-popup-role');
    }
  }
  // Expanded controls can own portalled popups without a popup role. Inline accordions
  // are deliberately excluded: expanded alone does not establish an overlay.
  for (const opener of document.querySelectorAll('[aria-expanded=true]')) {
    const ids = `${opener.getAttribute('aria-controls') || ''} ${opener.getAttribute('aria-owns') || ''}`.trim().split(/\s+/);
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el && (['absolute', 'fixed'].includes(getComputedStyle(el).position) || opener.hasAttribute('aria-haspopup'))) add(el, 'popover', 'expanded-popup-owner');
    }
  }
  // A searchable popup can put its semantic list inside a virtual scroll viewport,
  // with the search/close controls as siblings. Use their shared floating panel,
  // not the absolutely positioned list filler, as the interaction boundary.
  // Do not cross an existing semantic boundary or absorb a page landmark.
  const floatingPanel = (el: Element) => {
    const r = el.getBoundingClientRect();
    return visible(el) && ['absolute', 'fixed'].includes(getComputedStyle(el).position)
      && r.width < innerWidth && r.height < innerHeight;
  };
  const containsRect = (panel: Element, el: Element) => {
    const p = panel.getBoundingClientRect(), r = el.getBoundingClientRect();
    return r.left >= p.left && r.right <= p.right && r.top >= p.top && r.bottom <= p.bottom;
  };
  const compositePanels = new Map<Element, Overlay['kind']>();
  for (const [list, details] of [...candidates]) {
    if (!['menu', 'listbox'].includes(details.kind)) continue;
    for (let panel = list.parentElement; panel && panel !== document.body; panel = panel.parentElement) {
      if (candidates.has(panel) || panel.matches('main,nav,header,footer,aside,form,dialog,[role=dialog],[role=alertdialog],[role=main],[role=navigation],[role=complementary],[aria-modal=true],[popover]')) break;
      if (!floatingPanel(panel)) continue;
      const lists = [...panel.querySelectorAll('[role=menu],[role=listbox]')].filter(visible);
      const chrome = controls.some(c => {
        const e = elements.get(c.localId);
        // An external opener is not chrome of the floating panel. Promoting its
        // positioned owner would keep a false boundary after the child closes.
        const opensList = e && !!list.id && ['aria-controls', 'aria-owns', 'popovertarget'].some(a => e.getAttribute(a)?.split(/\s+/).includes(list.id));
        return c.visible && c.actions.length && e && !opensList && panel.contains(e) && !list.contains(e) && !e.contains(list) && containsRect(panel, e);
      });
      if (lists.length === 1 && lists[0] === list && chrome) {
        candidates.delete(list); add(panel, details.kind, 'composite-popup-panel');
        candidates.get(panel)!.evidence.push(...details.evidence);
        compositePanels.set(panel, details.kind);
      }
      break;
    }
  }
  // Filtering may temporarily empty/remove the list. The same visible floating
  // panel still owns its search field; it has not exited merely because no options
  // match. Forget this association as soon as the panel disappears or is replaced.
  for (const prior of (tracker.compositePopupPanels || []) as { element: Element; kind: Overlay['kind'] }[]) {
    if (prior.element.isConnected && floatingPanel(prior.element)) {
      add(prior.element, prior.kind, 'observed-composite-popup-continuity');
      compositePanels.set(prior.element, prior.kind);
    }
  }
  for (const relation of popupRelations) {
    const { content, panel } = relation;
    // An outer dialog does not absorb an independently observed child popup.
    // Only avoid a second boundary when composite discovery already replaced
    // this content with its panel; preserve explicitly nested popup candidates.
    const alreadyCombined = [...compositePanels.keys()].some(root => root.contains(content));
    if (panel !== content && visible(content) && visible(panel) && (candidates.has(content) || !alreadyCombined)) {
      candidates.delete(content);
      const kind = content.getAttribute('role') as 'listbox' | 'menu';
      add(panel, kind, 'positioned-choice-panel'); compositePanels.set(panel, kind);
    }
  }
  tracker.compositePopupPanels = [...compositePanels].map(([element, kind]) => ({ element, kind }));
  // Conservative fallback for custom dialogs: require a fixed viewport backdrop and
  // a visible interactive panel. Do not infer a modal from a class name or z-index alone.
  for (const mask of document.querySelectorAll('body *')) {
    const s = getComputedStyle(mask); const r = mask.getBoundingClientRect();
    if (s.position !== 'fixed' || !visible(mask) || r.width < innerWidth * .9 || r.height < innerHeight * .9 || s.pointerEvents === 'none') continue;
    if ([...candidates.keys()].some(el => el === mask || mask.contains(el))) continue;
    const alpha = s.backgroundColor.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/)?.[1];
    if (!(alpha && Number(alpha) > 0 && Number(alpha) < 1) && (!s.backdropFilter || s.backdropFilter === 'none')) continue;
    const panels = [...mask.children].filter(el => {
      const rect = el.getBoundingClientRect();
      return visible(el) && rect.width < r.width * .95 && rect.height < r.height * .95 && el.querySelector('button,input,select,textarea,[role=button]');
    });
    if (panels.length === 1) add(panels[0], 'modal', 'fixed-backdrop-with-interactive-panel');
  }
  const prior: Element[] = tracker.visibleOverlays || [];
  const roots = [...candidates.keys()];
  const order = [...prior.filter(el => candidates.has(el)), ...roots.filter(el => !prior.includes(el))];
  const zIndex = (el: Element) => { let z = 0; for (let p: Element | null = el; p; p = p.parentElement) z = Math.max(z, Number(getComputedStyle(p).zIndex) || 0); return z; };
  const owns = (parent: Element, child: Element) => !!child.id && controls.some(c => {
    const el = elements.get(c.localId);
    return c.visible && el && parent.contains(el) && [el.getAttribute('aria-controls'), el.getAttribute('aria-owns'), el.getAttribute('popovertarget')].some(ids => ids?.split(/\s+/).includes(child.id));
  });
  order.sort((a, b) => {
    if (a.contains(b) || owns(a, b)) return -1; if (b.contains(a) || owns(b, a)) return 1;
    // Native top-layer elements render above ordinary stacking contexts.
    const top = Number(a.matches(':modal,:popover-open')) - Number(b.matches(':modal,:popover-open'));
    if (top) return top;
    return zIndex(a) - zIndex(b);
  });
  // At equal stacking levels a newly observed layer follows the existing one.
  // Retaining this order avoids DOM order reversing portalled nested popups.
  tracker.visibleOverlays = order;
  // Finalize ancestor names with the observed independent scopes before using
  // those names to recognize exits. This does not alter any DOM evidence.
  describeControls?.(order);
  const keys = new Map<Element, string>();
  for (const el of order) {
    const path = selector(el); let region = regions.find(r => r.selector === path);
    if (!region) {
      const key = `overlay:${el.getAttribute('data-testid') || el.id || path}`;
      const r = el.getBoundingClientRect();
      region = { key, label: el.getAttribute('aria-label') || el.getAttribute('role') || 'Popup', role: candidates.get(el)!.kind, selector: path, parentKey: 'document', rect: { x: r.x, y: r.y, width: r.width, height: r.height }, text: (el as HTMLElement).innerText || '' };
      regions.push(region);
    }
    keys.set(el, region.key);
  }
  const overlays: Overlay[] = order.map(el => {
    const key = keys.get(el)!; const details = candidates.get(el)!;
    const relation = popupRelations.find(p => p.panel === el || p.content === el);
    const opener = controls.find(c => {
      const e = elements.get(c.localId);
      return c.visible && e && !el.contains(e) && (e === relation?.trigger || !!el.id && e.getAttribute('popovertargetaction') !== 'hide' && [e.getAttribute('aria-controls'), e.getAttribute('aria-owns'), e.getAttribute('popovertarget')].some(ids => ids?.split(/\s+/).includes(el.id)));
    });
    const openerEl = opener && elements.get(opener.localId);
    const parent = [...order].reverse().find(p => p !== el && (p.contains(el) || !!openerEl && p.contains(openerEl)));
    const controlIds = controls.filter(c => {
      const e = elements.get(c.localId); if (!e) return false;
      const ownsList = relation?.content.id && e.matches('input,[role=combobox]') && e.getAttribute('aria-controls')?.split(/\s+/).includes(relation.content.id);
      return el.contains(e) || ownsList;
    }).map(c => c.localId);
    const exitControlIds = controls.filter(c => {
      const e = elements.get(c.localId); if (!e) return false;
      if (e === relation?.trigger && c.actions.includes('click')) return true;
      if (e.getAttribute('popovertarget') === el.id && ['hide', 'toggle'].includes(e.getAttribute('popovertargetaction') || 'toggle')) return true;
      if (e.getAttribute('commandfor') === el.id && ['close', 'request-close', 'hide-popover', 'toggle-popover'].includes(e.getAttribute('command') || '')) return true;
      if (!controlIds.includes(c.localId) || !c.actions.includes('click')) return false;
      const button = e as HTMLButtonElement | HTMLInputElement;
      const formMethod = button.hasAttribute('formmethod') ? button.formMethod : button.form?.method;
      if (button.form && ['submit', 'image'].includes(button.type) && formMethod === 'dialog') return true;
      return /^(?:close|dismiss|done|cancel|关闭|取消|完成)(?:\b|\s|$)|^[×✕✖]$/i.test(c.name.trim());
    }).map(c => c.localId);
    return { key, name: regions.find(r => r.key === key)!.label, kind: details.kind, selector: selector(el), parentKey: parent ? keys.get(parent) : undefined, parentRegion: opener?.region || (parent ? keys.get(parent)! : 'document'), evidence: [...details.evidence, ...(opener ? ['opener-relationship'] : []), ...(prior.includes(el) ? [] : ['newly-visible'])], controlIds, exitControlIds };
  });
  // Point sampling records blockers separately from visibility. A visually present
  // control behind a backdrop must not enter the executable frontier.
  for (const c of controls) {
    const el = elements.get(c.localId); if (!el || !c.visible) continue;
    const r = el.getBoundingClientRect();
    const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right), top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
    c.actionable.outsideScrollableArea = r.right <= 0 && scrollX === 0 || r.bottom <= 0 && scrollY === 0;
    if (right > left && bottom > top) {
      const points = [[.5, .5], [.2, .2], [.8, .2], [.2, .8], [.8, .8]];
      const hits = points.map(([x, y]) => document.elementFromPoint(left + (right - left) * x, top + (bottom - top) * y));
      const index = hits.findIndex(hit => hit === el || !!hit && el.contains(hit));
      c.actionable.hitTarget = index >= 0;
      if (index >= 0) c.actionable.clickPoint = { x: left + (right - left) * points[index][0] - r.left, y: top + (bottom - top) * points[index][1] - r.top };
      if (!c.actionable.hitTarget && hits[0]) c.actionable.occludedBy = selector(hits[0]);
    }
  }
  return { overlays, boundaries: overlays.map(o => ({ key: o.key, name: o.name, parentKey: o.parentKey, region: o.parentRegion, evidence: o.evidence })) };
}
