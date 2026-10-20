/**
 * Language versions of a page. Many sites serve one page in several languages, each at its own
 * URL (/ru/download, /de/download, /download), sometimes on its own domain. They are one page:
 * same structure and functions, different words. The crawler tests one language (the entry's)
 * and keeps the others apart as language versions, never as other pages to spend budget on.
 *
 * Evidence, best first:
 * 1. The page's own declaration, <link rel="alternate" hreflang="..." href="...">: the site
 *    lists every language version of this page. Exact, whatever the URL scheme
 *    (/ae-ar/, /befr/, /es-la/, airbnb.de).
 * 2. Without one, a leading path segment that is a valid language tag, validated by Intl, not by
 *    a list of languages. A tag with a script or region (zh-hans, es-419, en-au) only names a
 *    language, so it is taken off: /zh-hans/x is /x. A bare language (ru, de) can also be an
 *    ordinary path (/my/account, /no/...), so it marks a language version only beside another
 *    language segment: /ru/x and /de/x are one page, /my/account and /account are not.
 */

/** One declared language version: its language tag and its URL. */
export interface LanguageVariant {
  lang: string;
  url: string;
}

/** What a document says about its language: its versions in other languages, and its own tag. */
export interface PageLanguage {
  /** <html lang>, as written; often wrong (a German page saying "en"), so only a fallback. */
  documentLang?: string;
  /** hreflang alternates the page declares, in document order; empty when it declares none. */
  variants: LanguageVariant[];
}

/** Read in the page: the declared language versions and the <html lang>. */
export const pageLanguageInPage = new Function(
  `const variants = [];
  for (const l of document.querySelectorAll('link[rel~=alternate][hreflang][href]')) {
    try { variants.push({ lang: l.getAttribute('hreflang').trim(), url: new URL(l.getAttribute('href'), location.href).href }); } catch {}
  }
  const documentLang = (document.documentElement && document.documentElement.getAttribute('lang') || '').trim();
  return { variants: variants.slice(0, 400), ...(documentLang ? { documentLang } : {}) };`,
) as () => PageLanguage;

/** A BCP 47 language tag Intl knows the language of: ru, zh-Hans, es-419, pt-BR. Not "us", "api". */
export function languageTag(text: string): string | undefined {
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(text)) return;
  try {
    const [tag] = Intl.getCanonicalLocales(text);
    const locale = new Intl.Locale(tag);
    if (!languageNames.of(locale.language)) return;
    if (locale.script && !scriptNames.of(locale.script)) return;
    // ZZ is "Unknown Region"; private-use regions (AA, QM-QZ, XA-XZ) have no name.
    if (locale.region && (locale.region === 'ZZ' || !regionNames.of(locale.region))) return;
    return tag;
  } catch {
    return;
  }
}
const languageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
const scriptNames = new Intl.DisplayNames(['en'], { type: 'script', fallback: 'none' });
const regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });

/** Origin and path without a trailing slash: the URL as one page, query and hash left out. */
export function urlPath(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return url;
  }
}

/**
 * The page identity of URLs and their language. Declarations are learnt as pages are read; a URL
 * named in one belongs to that page. Without one, a leading language segment is taken off.
 */
export class LanguageVersions {
  /** URL path → the page it is a language version of, and its language. */
  private readonly declared = new Map<string, { page: string; lang: string }>();
  /** Page → its language versions, as declared. */
  private readonly versions = new Map<string, LanguageVariant[]>();

  /**
   * Records what a document at `url` declares. Every URL it names is the same page; the page is
   * keyed by its x-default version, else the version without a language segment, else the first.
   */
  learn(url: string, language: PageLanguage) {
    const variants = language.variants.filter(v => /^https?:/.test(v.url));
    if (!variants.some(v => urlPath(v.url) === urlPath(url))) {
      // Pages often leave themselves out of their own list; it is still one of the versions.
      if (!variants.length) return;
      variants.push({ lang: language.documentLang || '', url });
    }
    const known = variants.map(v => this.declared.get(urlPath(v.url))?.page).find(Boolean);
    const page =
      known ||
      urlPath(variants.find(v => v.lang.toLowerCase() === 'x-default')?.url || '') ||
      variants.map(v => fallbackPage(v.url)).find(p => variants.some(v => urlPath(v.url) === p)) ||
      fallbackPage(variants[0].url);
    for (const v of variants) {
      const path = urlPath(v.url);
      // x-default names the fallback version, not a language: it never overwrites one.
      if (v.lang.toLowerCase() !== 'x-default') this.declared.set(path, { page, lang: v.lang });
      else if (!this.declared.has(path)) this.declared.set(path, { page, lang: '' });
    }
    const list = this.versions.get(page) || [];
    for (const v of variants)
      if (
        v.lang.toLowerCase() !== 'x-default' &&
        !list.some(x => x.lang === v.lang && urlPath(x.url) === urlPath(v.url))
      )
        list.push({ lang: v.lang, url: v.url });
    this.versions.set(page, list);
  }

  /** The page a URL is a language version of. */
  page(url: string): string {
    return this.declared.get(urlPath(url))?.page ?? fallbackPage(url);
  }

  /** The language of a URL: declared for it, else its leading language segment; undefined when unknown. */
  language(url: string): string | undefined {
    const declared = this.declared.get(urlPath(url))?.lang;
    if (declared) return declared;
    return leadingTag(url)?.tag;
  }

  /** Two URLs of the same page in different languages. */
  otherLanguage(a: string, b: string): boolean {
    if (urlPath(a) === urlPath(b)) return false;
    if (this.page(a) === this.page(b)) return true;
    if (this.declared.has(urlPath(a)) && this.declared.has(urlPath(b))) return false;
    // Two bare language segments in front of the same path: /ru/x and /de/x.
    const x = leadingTag(a),
      y = leadingTag(b);
    return !!x && !!y && x.rest === y.rest;
  }

  /** Every declared language version of the page `url` belongs to (for testing other languages). */
  variantsOf(url: string): LanguageVariant[] {
    return this.versions.get(this.page(url)) ?? [];
  }
}

/** A leading path segment that is a language tag, and the path without it. */
function leadingTag(url: string): { tag: string; rest: string } | undefined {
  try {
    const u = new URL(url);
    const match = /^\/([^/]+)(\/.*)?$/.exec(u.pathname);
    const tag = match && languageTag(match[1]);
    return tag ? { tag, rest: u.origin + (match[2] || '').replace(/\/+$/, '') } : undefined;
  } catch {
    return;
  }
}

/** Without a declaration: the URL with a leading script / region language segment taken off. */
export function withoutLanguage(url: string): string {
  return fallbackPage(url);
}
function fallbackPage(url: string): string {
  const lead = leadingTag(url);
  return lead && lead.tag.includes('-') ? lead.rest : urlPath(url);
}
