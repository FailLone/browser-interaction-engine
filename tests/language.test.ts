import { expect, test } from 'vitest';
import { LanguageVersions, languageTag, pagePath } from '@interaction/crawler';

test('language tags are validated by Intl, not by a list of languages', () => {
  for (const tag of ['ru', 'de', 'zh-hans', 'zh-Hant-TW', 'es-419', 'pt-BR', 'en-au'])
    expect(languageTag(tag)).toBeDefined();
  // Path words that look like tags but name no language, script or region.
  for (const word of ['us', 'api', 'docs', 'befr', 'xx-yy', 'en-zz', 'download'])
    expect(languageTag(word)).toBeUndefined();
});

test('declared versions are one page whatever the URL scheme; undeclared ones fall back to the path', () => {
  const v = new LanguageVersions();
  // OKX: /es-la/ is Spanish by declaration (as a tag it would read "Spanish, Laos").
  v.learn('https://www.okx.com/ru/download', {
    documentLang: 'ru',
    variants: [
      { lang: 'x-default', url: 'https://www.okx.com/download' },
      { lang: 'ru', url: 'https://www.okx.com/ru/download' },
      { lang: 'es', url: 'https://www.okx.com/es-la/download' },
      { lang: 'zh-Hans', url: 'https://www.okx.com/zh-hans/download' },
    ],
  });
  expect(v.otherLanguage('https://www.okx.com/es-la/download', 'https://www.okx.com/ru/download')).toBe(true);
  expect(v.otherLanguage('https://www.okx.com/download', 'https://www.okx.com/ru/download/')).toBe(true);
  expect(v.language('https://www.okx.com/es-la/download')).toBe('es');
  // x-default is the fallback version, not a language.
  expect(v.language('https://www.okx.com/download')).toBeUndefined();
  expect(v.otherLanguage('https://www.okx.com/ru/markets', 'https://www.okx.com/ru/download')).toBe(false);
  expect(v.variantsOf('https://www.okx.com/ru/download').map(x => x.lang)).toEqual(['ru', 'es', 'zh-Hans']);
  // Apple: country-language segments no tag check could read.
  v.learn('https://www.apple.com/de/iphone/', {
    variants: [
      { lang: 'de-DE', url: 'https://www.apple.com/de/iphone/' },
      { lang: 'fr-BE', url: 'https://www.apple.com/befr/iphone/' },
    ],
  });
  expect(v.otherLanguage('https://www.apple.com/befr/iphone/', 'https://www.apple.com/de/iphone')).toBe(true);
  // A page that leaves itself out of its own list is still one of its versions.
  v.learn('https://shop.test/de/cart', {
    documentLang: 'de',
    variants: [{ lang: 'fr', url: 'https://shop.test/fr/panier' }],
  });
  expect(v.otherLanguage('https://shop.test/fr/panier', 'https://shop.test/de/cart')).toBe(true);
  expect(v.language('https://shop.test/de/cart')).toBe('de');
});

test('without a declaration, bare language segments are versions of each other but not of an ordinary path', () => {
  const v = new LanguageVersions();
  expect(v.otherLanguage('https://mdn.test/de/docs/Web', 'https://mdn.test/fr/docs/Web')).toBe(true);
  expect(v.otherLanguage('https://x.test/zh-hans/a', 'https://x.test/a')).toBe(true);
  // "my" is Burmese, but /my/account is an account page, not the Burmese /account.
  expect(v.otherLanguage('https://x.test/my/account', 'https://x.test/account')).toBe(false);
  expect(v.otherLanguage('https://x.test/api/a', 'https://x.test/docs/a')).toBe(false);
  // Page identity from the URL alone keeps the same rule.
  expect(pagePath('https://x.test/es-419/a/')).toBe('https://x.test/a');
  expect(pagePath('https://x.test/my/account')).toBe('https://x.test/my/account');
});

test('the crawl stays in the entry language: other language versions are recorded, never visited', async () => {
  const { createServer } = await import('node:http');
  const { SampledCrawler } = await import('@interaction/crawler');
  const head = (lang: string) => `<!doctype html><html lang="${lang}"><meta charset="utf-8">
    <link rel="alternate" hreflang="x-default" href="/download"><link rel="alternate" hreflang="ru" href="/ru/download">
    <link rel="alternate" hreflang="es" href="/es-la/download">`;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const path = (req.url || '/').replace(/\/$/, '');
    if (path === '/es-la/download' || path === '/download')
      res.end(`${head('es')}<title>Descargar</title><main><button>Otro</button></main>`);
    else
      res.end(`${head('ru')}<title>Скачать</title><main>
        <a href="/es-la/download">Español</a>
        <button onclick="location.href='/download'">English</button>
        <button onclick="this.textContent='Готово'">Скачать</button></main>`);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const events: import('@interaction/crawler').CrawlEvent[] = [];
    // The scope allows every download page: a language switch is still not followed.
    const crawler = new SampledCrawler({
      url: `${base}/ru/download`,
      durationMs: 20000,
      settleMs: 100,
      followNavigation: true,
      policy: { allowedPaths: [/download$/] },
      log: e => events.push(e),
    });
    const summary = await crawler.run();
    // Every state is the Russian page; the link is never clicked, the button's load is stopped.
    const states = events.filter(e => e.type === 'state') as { state: { url: string } }[];
    expect(states.every(e => e.state.url.startsWith(`${base}/ru/download`))).toBe(true);
    expect(events.find(e => e.type === 'languages')).toMatchObject({
      language: 'ru',
      variants: [{ lang: 'ru' }, { lang: 'es' }],
    });
    const switches = events.filter(e => e.type === 'navigation' && e.kind === 'language');
    expect(switches.map(e => (e as { to: string }).to).sort()).toEqual([`${base}/download`, `${base}/es-la/download`]);
    expect(summary.navigations.languages).toBe(2);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
}, 60000);
