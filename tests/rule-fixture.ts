import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { BrowserDriver } from '@interaction/crawler';
import { pageFromCapture, type Control, type RulePage } from '@interaction/rules';

/** Serves apps/test-site with Vite so rule fixtures run as real pages. */
export async function fixtureServer(): Promise<{ server: ViteDevServer; url: string }> {
  const server = await createServer({
    root: resolve('apps/test-site'),
    server: { port: 0, strictPort: false },
    logLevel: 'error',
  });
  await server.listen();
  return { server, url: `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}` };
}

/**
 * A page opened by the crawler's driver. Each `inspect()` takes a fresh detailed capture and
 * returns the next RulePage in sequence, as the rules plugin does for each crawled state.
 */
export class RuleFixture {
  readonly driver: BrowserDriver;
  readonly sessionId = crypto.randomUUID();
  private readonly identities = new Map<string, string>();
  private sequence = 0;
  last?: RulePage;
  constructor(url: string, viewport = { width: 800, height: 600 }) {
    this.driver = new BrowserDriver({ url, viewport, actionTimeoutMs: 1000 });
  }
  get page() {
    return this.driver.page!;
  }
  async open() {
    await this.driver.start();
    await this.settle();
    return this.inspect();
  }
  async settle(ms = 60) {
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await this.page.waitForTimeout(ms);
  }
  async inspect(): Promise<RulePage> {
    await this.settle();
    const capture = await this.driver.readDOM(true);
    this.last = pageFromCapture(capture, {
      sessionId: this.sessionId,
      sequence: ++this.sequence,
      runtime: this.driver.runtime(),
      identities: this.identities,
    });
    return this.last;
  }
  control(predicate: (c: Control) => boolean) {
    return this.last!.observation.controls.find(predicate)!;
  }
  /**
   * Scroll a container (a user action outside any rule) so `target` sits inside its viewport,
   * as a user scrolling to a control would; then capture.
   */
  async scroll(container: string, target = '#target') {
    const moved = await this.page
      .evaluate(
        new Function(
          'args',
          `const [c, t] = args.map(s => document.querySelector(s));
      if (!c || !t) return false; const before = [c.scrollLeft, c.scrollTop];
      const cr = c.getBoundingClientRect(), tr = t.getBoundingClientRect();
      c.scrollBy(tr.left - cr.left - c.clientLeft - 4, tr.top - cr.top - c.clientTop - 4);
      return before[0] !== c.scrollLeft || before[1] !== c.scrollTop;`,
        ) as never,
        [container, target] as never,
      )
      .catch(() => false);
    return { moved: !!moved, page: await this.inspect() };
  }
  async close() {
    await this.driver.close();
  }
}

/** Open a fixture page, run the callback, always close the browser. */
export async function withFixture<T>(
  url: string,
  fn: (fixture: RuleFixture, first: RulePage) => Promise<T>,
  viewport?: { width: number; height: number },
) {
  const fixture = new RuleFixture(url, viewport);
  try {
    return await fn(fixture, await fixture.open());
  } finally {
    await fixture.close();
  }
}
