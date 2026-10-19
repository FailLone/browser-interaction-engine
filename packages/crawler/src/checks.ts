import type { CrawlPlugin, Finding } from './plugin.js';

function scanPage() {
    const out: { rule: string; severity: 'warning' | 'error'; selector: string; text: string; detail: string }[] = [];
    const path = (el: Element) => { const parts: string[] = []; for (let e: Element | null = el; e && parts.length < 4; e = e.parentElement) parts.unshift(e.tagName.toLowerCase() + (e.id ? `#${e.id}` : '')); return parts.join(' > '); };
    // Visually-hidden helpers (skip links, sr-only text) are intentionally tiny.
    const shown = (el: Element) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0; };
    for (const img of [...document.images]) {
      if (!shown(img) || !img.complete) continue;
      if (img.currentSrc && img.naturalWidth === 0) out.push({ rule: 'broken-image', severity: 'error', selector: path(img), text: img.alt || '', detail: img.currentSrc.slice(0, 200) });
    }
    for (const el of document.querySelectorAll('button, a, label, [role=button], [role=tab], h1, h2, h3, p, span, td, th')) {
      if (!shown(el) || el.children.length > 2) continue;
      const s = getComputedStyle(el), text = (el.textContent || '').trim();
      if (!text || s.textOverflow === 'ellipsis' || el.getAttribute('title')) continue;
      const clippedX = s.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 2, clippedY = s.overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 2;
      if ((clippedX || clippedY) && !['auto', 'scroll'].includes(s.overflowX) && !['auto', 'scroll'].includes(s.overflowY))
        out.push({ rule: 'clipped-text', severity: 'warning', selector: path(el), text: text.slice(0, 80), detail: `scroll ${el.scrollWidth}x${el.scrollHeight} > client ${el.clientWidth}x${el.clientHeight}` });
    }
    return out;
}

/**
 * Cheap in-page checks for crawling. Each scans visible elements once and is
 * deliberately conservative; heavier evidence-backed rules (packages/rules)
 * can be attached through the same hook. tsx/esbuild may inject a module-local
 * __name helper into nested functions; the serialized source supplies it so
 * development and compiled builds agree.
 */
const scanSource = `(() => { const __name = (fn) => fn; return (${scanPage.toString()})(); })()`;
/** Lightweight checks as a crawl plugin: broken images and hard-clipped text, evaluated in the page. */
export const checksPlugin: CrawlPlugin = { id: 'checks', onState: ({ page }) => page.evaluate(scanSource) as Promise<Finding[]> };
