import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ViteDevServer } from 'vite';
import { HorizontalOverflowTracker, type RuleCheck } from '@interaction/rules';
import { fixtureServer, withFixture } from './rule-fixture.js';

let server: ViteDevServer, base: string;
beforeAll(async () => ({ server, url: base } = await fixtureServer()));
afterAll(() => server.close());

const phone = { width: 393, height: 852 };
const checksOf = (mode: string) =>
  withFixture(
    `${base}/horizontal-overflow.html?mode=${mode}`,
    async (_f, page) => (await new HorizontalOverflowTracker().run(page)).checks,
    phone,
  );
const reported = (checks: RuleCheck[]) => checks.filter(c => c.severity !== 'info');

it('reports OKX-style padding that pushes content past both edges, naming the outermost culprit once', async () => {
  const all = await checksOf('okx');
  // It also makes the page scroll; that is the same culprit, not a second unexplained scroll.
  expect(all).toHaveLength(1);
  const checks = reported(all);
  expect(checks[0]).toMatchObject({ verdict: 'fail', severity: 'warning', code: 'CONTENT_UNREACHABLE_LEFT' });
  expect(checks[0].facts).toMatchObject({ element: 'div#culprit' });
  expect(checks[0].facts?.lostText).toEqual(expect.arrayContaining([expect.stringContaining('криптопутешествие')]));
});

it('reports a page that scrolls sideways: a warning with content past the edge, a note with only space', async () => {
  const [right] = reported(await checksOf('right'));
  expect(right).toMatchObject({ code: 'PAGE_SCROLLS_HORIZONTALLY', severity: 'warning' });
  expect(right.facts).toMatchObject({ element: 'div#culprit', viewportWidth: 393 });
  expect(Number(right.facts?.overflowRightPx)).toBeCloseTo(67, 0);
  const empty = await checksOf('empty');
  expect(reported(empty)).toEqual([]);
  expect(empty).toEqual([expect.objectContaining({ code: 'PAGE_SCROLLS_HORIZONTALLY', severity: 'info' })]);
});

it('counts a control past the page edge as content, as on OKX once its title fits', async () => {
  const [edge] = reported(await checksOf('control-edge'));
  expect(edge).toMatchObject({ code: 'CONTENT_UNREACHABLE_LEFT', severity: 'warning' });
  expect(edge.facts).toMatchObject({ element: 'div#culprit', lostControls: 1 });
});

it('assesses only an open dialog, not the page behind it', async () => {
  expect(reported(await checksOf('under-dialog'))).toEqual([]);
  expect(reported(await checksOf('dialog-overflow'))).toEqual([
    expect.objectContaining({ code: 'CONTENT_UNREACHABLE_LEFT', severity: 'warning' }),
  ]);
});

it('reports content left of the page, where no scroll reaches', async () => {
  expect(reported(await checksOf('left'))).toEqual([
    expect.objectContaining({ code: 'CONTENT_UNREACHABLE_LEFT', severity: 'warning' }),
  ]);
});

it('reports text cut off by a container that cannot scroll, and by a page that hides overflow', async () => {
  const [cut] = reported(await checksOf('cut-off'));
  expect(cut).toMatchObject({ code: 'CONTENT_CUT_OFF', severity: 'warning' });
  expect(cut.facts).toMatchObject({ clipContainer: 'div#clip' });
  const [root] = reported(await checksOf('root-hidden'));
  expect(root).toMatchObject({ code: 'CONTENT_CUT_OFF', severity: 'warning' });
  expect(root.facts).toMatchObject({ clipContainer: 'page' });
});

it.each(['fits', 'scroll-strip', 'carousel', 'drawer', 'subpixel', 'glow', 'cut-control'])(
  'does not report %s',
  async mode => {
    expect(reported(await checksOf(mode))).toEqual([]);
  },
);

it('records a strip that scrolls with its scrollbar hidden without reporting it', async () => {
  const checks = await checksOf('hidden-scrollbar');
  expect(reported(checks)).toEqual([]);
  expect(checks).toEqual([expect.objectContaining({ code: 'HIDDEN_SCROLLBAR', verdict: 'unknown', severity: 'info' })]);
});
