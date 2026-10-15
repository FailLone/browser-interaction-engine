import type { ActionEvidence } from '@interaction/core';

/** Serialized into the document. Recognition is based on native navigation semantics,
 * passive readout formats and repeated observations, never a site or control name. */
export function collectLiveContent(instance: (el: Element) => string, epoch: number) {
  const tracker = (window as any).__interactionEvidenceTracker;
  const history: WeakMap<Element, { binding: string; value: string; previous: string; changes: number; epoch: number; confirmed: boolean; observedChanges: number }> = tracker.liveText ??= new WeakMap();
  const ignored = new Set<Element>();
  const evidence = new Map<Element, ActionEvidence[]>();
  const active = 'button,input,select,textarea,[contenteditable]:not([contenteditable=false]),[role=button],[role=tab],[role=option],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=combobox],[tabindex],[onclick]';
  const formatted = (value: string) => /^[+\-−]?\p{Sc}\s*\d[\d,.]*(?:\s*[KMBTkmbt])?$/u.test(value) || /^[+\-−]?\d[\d,.]*\s*[%‰]$/.test(value);
  const numeric = (value: string) => /^[+\-−]?[\s\p{Sc}]*\d[\d,.]*(?:\s*[KMBTkmbt])?\s*[%‰]?$/u.test(value);
  for (const link of [...document.querySelectorAll('a[href]')].slice(0, 1500)) {
    let href: URL;
    try { href = new URL((link as HTMLAnchorElement).href, location.href); } catch { continue; }
    if (!['http:', 'https:'].includes(href.protocol) || href.origin + href.pathname + href.search === location.origin + location.pathname + location.search
      || link.closest('form') || link.hasAttribute('download') || link.getAttribute('role') && link.getAttribute('role') !== 'link') continue;
    const binding = JSON.stringify([href.href, link.getAttribute('target'), link.getAttribute('aria-label'), link.getAttribute('aria-labelledby')]);
    const candidates: Element[] = [];
    for (const el of [...link.querySelectorAll('*')].slice(0, 500)) {
      if (el.children.length || el.closest('a[href]') !== link || el.matches('script,style,svg,path') || el.closest('[hidden],[aria-hidden=true]')) continue;
      const owner = el.closest(active);
      if (owner && owner !== link && link.contains(owner)) continue;
      const value = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!numeric(value)) { history.delete(el); continue; }
      let prior = history.get(el);
      if (!prior || prior.binding !== binding) { prior = { binding, value, previous: value, changes: 0, epoch, confirmed: false, observedChanges: 0 }; history.set(el, prior); }
      else if (prior.epoch !== epoch) { prior.epoch = epoch; prior.changes = 0; prior.previous = prior.value; prior.value = value; }
      else if (prior.value !== value) { prior.previous = prior.value; prior.value = value; prior.changes++; prior.observedChanges++; }
      if (prior.changes >= 2) prior.confirmed = true;
      if (prior.confirmed || formatted(value)) candidates.push(el);
    }
    if (!candidates.length) continue;
    const copy = link.cloneNode(true) as Element;
    const children = [...link.querySelectorAll('*')], copies = [...copy.querySelectorAll('*')];
    for (const el of candidates) copies[children.indexOf(el)].remove();
    // A numeric-only navigation label (e.g. pagination) must not disappear.
    if (!/[\p{L}]/u.test(copy.textContent || '')) continue;
    for (const el of candidates) {
      ignored.add(el);
      const prior = history.get(el)!;
      const fact: ActionEvidence = { source: 'dom-samples', rule: prior.confirmed ? 'live-navigation-readout/v1' : 'formatted-navigation-readout/v1', facts: {
        instanceId: instance(el), binding, previousText: prior.previous, text: prior.value, changes: prior.observedChanges,
        meaning: 'Passive readout in a named native link, identified by currency/percentage formatting or repeated numeric changes; raw evidence is retained',
      } };
      evidence.set(link, [...(evidence.get(link) || []), fact]);
    }
  }
  return { ignored, evidence };
}
