import { createServer as createHttpServer, type Server } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BrowserDriver, desktopEdge, mediaBreakpoints, parseViewport } from '@interaction/crawler';

const pages: Record<string, { type: string; body: string }> = {
  // Bootstrap-like: desktop starts at 992 (max-width: 991.98px for the collapsed layout).
  '/css': {
    type: 'text/html',
    body: `<!doctype html><style>
      @media (min-width: 576px) { .a { color: red } }
      @media (max-width: 991.98px) { .nav { display: none } }
      @media (min-width: 1200px) { .b { color: blue } }
    </style><p>css</p>`,
  },
  // Breakpoints only in a sheet the page cannot read (served from another origin without CORS).
  '/cross': { type: 'text/html', body: '' },
  '/sheet.css': { type: 'text/css', body: '@media screen and (min-width: 64em) { .c { color: red } }' },
  // A layout chosen by script through matchMedia, as AntD's grid does.
  '/script': {
    type: 'text/html',
    body: `<!doctype html><p id="w"></p><script>
      document.getElementById('w').textContent = matchMedia('(min-width: 1280px)').matches ? 'wide' : 'narrow';
    </script>`,
  },
  '/none': { type: 'text/html', body: '<!doctype html><p>no breakpoints</p>' },
  '/agent': {
    type: 'text/html',
    body: `<!doctype html><meta name="viewport" content="width=device-width"><p id="ua"></p><script>
      document.getElementById('ua').textContent = [innerWidth, devicePixelRatio, navigator.maxTouchPoints > 0, /iPhone/.test(navigator.userAgent)].join(',');
    </script>`,
  },
};
let site: Server,
  base = '',
  other = '';
beforeAll(async () => {
  site = createHttpServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const page = pages[path] ?? { type: 'text/plain', body: '' };
    res.setHeader('content-type', page.type);
    res.end(
      path === '/cross' ? `<!doctype html><link rel="stylesheet" href="${other}/sheet.css"><p>cross</p>` : page.body,
    );
  });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const port = (site.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  other = `http://localhost:${port}`;
});
afterAll(() => new Promise<void>(resolve => site.close(() => resolve())));

it('reads the width at which each kind of width query switches', () => {
  expect(mediaBreakpoints('(min-width: 1024px)')).toEqual([1024]);
  expect(mediaBreakpoints('(max-width: 991.98px)')).toEqual([992]);
  expect(mediaBreakpoints('(max-width: 767px)')).toEqual([768]);
  expect(mediaBreakpoints('screen and (min-width: 62em)')).toEqual([992]);
  expect(mediaBreakpoints('(width >= 80rem)')).toEqual([1280]);
  expect(mediaBreakpoints('(width < 1024px)')).toEqual([1024]);
  expect(mediaBreakpoints('(1200px <= width)')).toEqual([1200]);
  expect(mediaBreakpoints('(min-height: 900px)')).toEqual([]);
  expect(mediaBreakpoints('(min-device-width: 900px)')).toEqual([]);
});

it('takes the narrowest desktop breakpoint, else the widest tablet one', () => {
  expect(desktopEdge([576, 768, 992, 1200, 1400])).toEqual({ width: 992, breakpoints: [992, 1200, 1400] });
  expect(desktopEdge([640, 768, 1024, 1280, 1536])?.width).toBe(1024);
  expect(desktopEdge([480, 768])).toEqual({ width: 768, breakpoints: [768] });
  expect(desktopEdge([480, 600])).toBeUndefined();
});

it('parses CLI viewports', () => {
  expect(parseViewport('desktop-edge')).toBe('desktop-edge');
  expect(parseViewport('1366x768')).toEqual({ width: 1366, height: 768 });
  expect(parseViewport('390x844@mobile')).toEqual({ width: 390, height: 844, mobile: true });
  expect(() => parseViewport('tablet')).toThrow(/Unknown viewport/);
});

const open = async (path: string, viewport: ConstructorParameters<typeof BrowserDriver>[0]['viewport']) => {
  const driver = new BrowserDriver({ url: base + path, viewport });
  await driver.start();
  return driver;
};

it.each([
  ['/css', 992, 'detected'],
  ['/cross', 1024, 'detected'],
  ['/script', 1280, 'detected'],
  ['/none', 1024, 'fallback'],
])('desktop-edge on %s runs at %i (%s)', async (path, width, source) => {
  const driver = await open(path, 'desktop-edge');
  try {
    expect(driver.viewport).toMatchObject({ preset: 'desktop-edge', width, source, mobile: false });
    expect(await driver.page!.evaluate('innerWidth')).toBe(width);
    // Layouts chosen once at startup see the new width: the page was reloaded at it.
    if (path === '/script') expect(await driver.page!.textContent('#w')).toBe('wide');
  } finally {
    await driver.close();
  }
});

it('mobile runs as an iPhone: touch, mobile user agent, device pixel ratio 3', async () => {
  const driver = await open('/agent', 'mobile');
  try {
    expect(driver.viewport).toMatchObject({ preset: 'mobile', width: 393, mobile: true });
    expect(await driver.page!.textContent('#ua')).toBe('393,3,true,true');
  } finally {
    await driver.close();
  }
});

it('desktop defaults to 1280x800 and custom sizes are taken as given', async () => {
  for (const [option, expected] of [
    [undefined, '1280,1,false,false'],
    [{ width: 1366, height: 768 }, '1366,1,false,false'],
    [{ width: 820, height: 1180, mobile: true }, '820,3,true,true'],
  ] as const) {
    const driver = await open('/agent', option);
    try {
      expect(await driver.page!.textContent('#ua')).toBe(expected);
    } finally {
      await driver.close();
    }
  }
});
