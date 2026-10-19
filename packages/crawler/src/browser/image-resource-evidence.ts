/** Installed before page scripts. Only observes native resource events; does not
 * request, decode, retry, scroll or delay an image. Detached images are not covered. */
export function installImageResourceEvidence() {
  const events = new WeakMap<
    HTMLImageElement,
    { key: string; url: string; kind: 'load' | 'error'; sequence: number }
  >();
  let sequence = 0;
  const source = (el: HTMLImageElement) => {
    const picture: (string | null)[][] = [];
    if (el.parentElement?.tagName === 'PICTURE') {
      for (let child = el.parentElement.firstElementChild; child && child !== el; child = child.nextElementSibling) {
        if (child.tagName !== 'SOURCE') continue;
        if (picture.length >= 32) return undefined;
        picture.push(['srcset', 'sizes', 'media', 'type'].map(k => child.getAttribute(k)));
      }
    }
    const src = el.getAttribute('src'),
      srcset = el.getAttribute('srcset');
    const key = JSON.stringify([
      el.baseURI,
      src,
      srcset,
      el.getAttribute('sizes'),
      el.crossOrigin,
      el.referrerPolicy,
      picture,
    ]);
    if (key.length > 20000) return undefined;
    return { key, hasSource: !!(src?.trim() || srcset?.trim() || picture.some(p => p[0]?.trim())) };
  };
  const receive = (event: Event) => {
    if (!event.isTrusted || !(event.target instanceof HTMLImageElement)) return;
    const el = event.target,
      value = source(el);
    if (!value || el.currentSrc.length > 20000) {
      events.delete(el);
      return;
    }
    events.set(el, { key: value.key, url: el.currentSrc, kind: event.type as 'load' | 'error', sequence: ++sequence });
  };
  // Element load events do not reach Window; Document capture still observes
  // them before target handlers can replace the image with a fallback.
  document.addEventListener('load', receive, { capture: true, passive: true });
  window.addEventListener('error', receive, { capture: true, passive: true });
  (window as any).__interactionImageResources = {
    read(el: HTMLImageElement) {
      const value = source(el);
      if (!value) return undefined;
      const last = events.get(el),
        matches = last?.key === value.key && last.url === el.currentSrc;
      return {
        version: 1,
        sourceKey: value.key,
        hasSource: value.hasSource,
        event: matches ? last!.kind : 'unobserved',
        eventSequence: matches ? last!.sequence : 0,
      };
    },
  };
}
