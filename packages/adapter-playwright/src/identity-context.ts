import type { Control } from './types.js';

/** Serialized into the page. All evidence is observable DOM, without framework internals. */
export function collectIdentityContexts(elements: Element[], controls: Control[]) {
  const text = (value: string | null | undefined, limit = 200) => {
    const normalized = (value || '').replace(/\s+/g, ' ').trim();
    return normalized.length <= limit ? normalized : '';
  };
  const label = (el: Element) => {
    const ids = el.getAttribute('aria-labelledby');
    return text(ids ? ids.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ') : el.getAttribute('aria-label'));
  };
  const headingSelector = 'h1,h2,h3,h4,h5,h6,[role=heading]';
  const itemSelector = '[data-row-key],[data-item-key],li,tr,[role=row],[role=listitem],[role=treeitem],[role=option]';
  const collectionSelector = 'ul,ol,table,[role=list],[role=listbox],[role=grid],[role=tree],[data-list-key]';
  const scopes = new Map<Element, string | undefined>();
  const scopeFor = (el: Element) => {
    if (scopes.has(el)) return scopes.get(el);
    // The existing list matcher owns record identity. A slot's ancestor ID or
    // description must not override missing/changing record evidence.
    if (el.closest(itemSelector)) return undefined;
    let scope: string | undefined;
    // Headings and named groups survive wrapper changes. No nth-child, coordinates,
    // CSS class names, generated IDs, current input values or DOM instance IDs.
    for (let parent = el.parentElement, depth = 0; parent && parent !== document.body && depth < 10; parent = parent.parentElement, depth++) {
      const role = parent.getAttribute('role') || parent.tagName.toLowerCase();
      const name = label(parent) || (parent.tagName === 'FIELDSET' ? text(parent.querySelector(':scope > legend')?.textContent) : '');
      if (name) { scope = JSON.stringify(['named-ancestor', role, name]); break; }
      // Descriptive, unique IDs can distinguish repeated banners. Exclude common
      // generated IDs and numeric slots; never use an ancestor from a list row.
      if (!el.closest(collectionSelector) && /^[a-z][a-z_-]{2,}$/i.test(parent.id) && document.querySelectorAll(`#${CSS.escape(parent.id)}`).length === 1) {
        scope = JSON.stringify(['ancestor-id', parent.id]); break;
      }
      const children = Array.from(parent.children);
      const containing = children.findIndex(child => child.contains(el));
      const headings = children.slice(0, containing).flatMap(child => child.matches(headingSelector) ? [child]
        : Array.from(child.children).filter(grandchild => grandchild.matches(headingSelector)));
      if (headings.length === 1) {
        const title = text(headings[0].textContent);
        if (title) { scope = JSON.stringify(['heading', title]); break; }
      }
      if (['HEADER', 'FOOTER', 'ASIDE'].includes(parent.tagName)) { scope = JSON.stringify(['landmark', parent.tagName.toLowerCase()]); break; }
    }
    scopes.set(el, scope); return scope;
  };
  const popup = (node: Element) => node.matches('[role=listbox],[role=menu],[role=dialog],[popover]') ||
    ['absolute', 'fixed'].includes(getComputedStyle(node).position) && !!node.querySelector('input,select,textarea,[role=option]');
  const fieldText = (el: Element) => {
    if (!el.matches('input:not([type=hidden]),textarea,select,[contenteditable=true]')) return '';
    // A search result/option list is mutable content, not the search field's label.
    for (let parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) if (popup(parent)) return '';
    // A local field wrapper must contain just this editable field. Hidden search
    // fields inside a popup are not peers of its visible amount input.
    for (let parent = el.parentElement, depth = 0; parent && parent !== document.body && depth < 3; parent = parent.parentElement, depth++) {
      // A region/form heading describes its scope, not whichever field happens
      // to remain after a sibling disappears. Stay inside a local field wrapper;
      // scopeFor already records named owners independently of their child count.
      if (label(parent) || parent.matches('main,header,footer,aside,nav,section,article,form,fieldset,[role=region],[role=group],[role=dialog]')) break;
      const peers = Array.from(parent.querySelectorAll('input:not([type=hidden]),textarea,select,[contenteditable=true]'))
        .filter(field => {
          if (field === el) return true;
          for (let node = field.parentElement; node && node !== parent; node = node.parentElement) if (popup(node)) return false;
          return field.getClientRects().length > 0;
        });
      if (peers.length !== 1) break;
      const fragments: string[] = []; let visited = 0; let incomplete = false;
      const walk = (node: Node) => {
        if (++visited > 100) { incomplete = true; return; }
        if (node === el) return;
        if (node.nodeType === Node.TEXT_NODE) { if (node.textContent?.trim()) fragments.push(node.textContent); return; }
        if (!(node instanceof Element)) return;
        if (node.matches('script,style,button,input,textarea,select,svg,[role=button],[role=listbox],[role=menu],[role=option],ul,ol,[hidden],[aria-hidden=true]')) return;
        if (node !== parent && popup(node)) return;
        if (node !== parent && (!node.getClientRects().length || getComputedStyle(node).visibility === 'hidden')) return;
        node.childNodes.forEach(walk);
      };
      walk(parent);
      const value = text(fragments.join(' '), 80);
      // Pure numbers and punctuation are generally values, not field descriptions.
      if (!incomplete && value && /\p{L}/u.test(value)) return value;
    }
    return '';
  };
  controls.forEach((control, index) => {
    const el = elements[index];
    if (!el) return;
    const evidence: string[] = [];
    const scope = scopeFor(el);
    if (scope) evidence.push('semantic-ancestor-scope/v1');
    const parts: unknown[] = [];
    if (!control.name && ['generic', 'presentation', 'none'].includes(control.role) && !el.closest(itemSelector)) {
      const anchors = Array.from(el.children).filter(child => child.matches('button,input,select,textarea,a[href],[role=button],[role=combobox]'))
        .map(child => [child.getAttribute('role') || child.tagName.toLowerCase(), label(child)]).filter(([, name]) => name);
      if (anchors.length === 1) { parts.push(['labelled-child', anchors[0]]); evidence.push('unique-labelled-child/v1'); }
    }
    if (el.matches('a[href]')) {
      const href = el.getAttribute('href')?.trim();
      if (href && href !== '#' && !/^javascript:/i.test(href)) {
        try { parts.push(['link-destination', new URL(href, document.baseURI).href, el.getAttribute('target') || '']); evidence.push('link-destination/v1'); } catch { /* An invalid URL supplies no identity evidence. */ }
      }
    }
    // Existing list record keys already bind the field to its row. Do not make
    // an input's changing sibling values part of a virtual record's identity.
    if (!el.closest(itemSelector)) {
      const nearby = fieldText(el);
      if (nearby) { parts.push(['field-description', nearby]); evidence.push('local-field-description/v1'); }
    }
    if (scope || parts.length) control.identityContext = { scope, binding: parts.length ? JSON.stringify(parts) : undefined, evidence };
  });
  // Nested search fields can inherit a neighbouring amount field's binding from
  // their common component, including while the nested popup is hidden. Resolve
  // only a unique sibling field, never a first/nearest field chosen by position.
  const fields = controls.map((c, i) => ({ control: c, el: elements[i] })).filter(({ control, el }) =>
    el?.matches('input,textarea,select') && control.identityContext?.binding);
  controls.forEach((control, index) => {
    const el = elements[index];
    if (!el?.matches('input,textarea,select') || control.identityContext?.binding || el.closest(itemSelector)) return;
    for (let parent = el.parentElement, depth = 0; parent && parent !== document.body && depth < 7; parent = parent.parentElement, depth++) {
      const owners = fields.filter(field => parent!.contains(field.el));
      if (owners.length > 1) break;
      if (owners.length === 1) {
        control.identityContext = { ...control.identityContext, binding: JSON.stringify(['owner-field', owners[0].control.identityContext!.binding]),
          evidence: [...(control.identityContext?.evidence || []), 'unique-component-field-owner/v1'] };
        break;
      }
    }
  });
}
