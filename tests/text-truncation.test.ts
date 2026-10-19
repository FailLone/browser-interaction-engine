import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  RuleRunner,
  TextTruncationTracker,
  textTruncationRule,
  textRequirementProposalSchema,
  type RulePage,
  type RuleReport,
} from '@interaction/rules';
import { fixtureServer, withFixture, type RuleFixture } from './rule-fixture.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => {
  fixture = await fixtureServer();
});
afterAll(async () => {
  await fixture.server.close();
});
const runner = new RuleRunner([textTruncationRule]);
const plan = [{ ruleId: 'text-truncation', ruleVersion: '1.0.0' }];
const target = (r: RuleReport, id: string) =>
  r.checks.find(c => c.target?.nodeId === id || c.facts?.identityId === id)!;
async function setup(mode: string, fn: (f: RuleFixture, page: RulePage, node: string, id: string) => Promise<void>) {
  await withFixture(`${fixture.url}/text-truncation.html?mode=${mode}`, async (f, page) => {
    const c = f.control(c => c.selector === '#target');
    await fn(f, page, c.localId, c.identityId!);
  });
}
const run = async (page: RulePage) => (await runner.run(page, plan))[0];
/** Scroll whichever label scroller the mode uses, as a user would. */
async function scroll(f: RuleFixture) {
  const container = await f.page.evaluate(
    () =>
      ['#scroller', '#outer'].find(s => {
        const el = document.querySelector(s);
        return el && el.scrollHeight > el.clientHeight + 1;
      }) ?? '#outer',
  );
  // Fixture content pads the label 16px down; scrolling by that brings it into the scroller.
  await f.page.locator(container).evaluate(el => el.scrollBy(0, 16));
  return f.inspect();
}

it.each(['healthy', 'literal', 'ellipsis-fit', 'clamp-fit', 'wrap', 'native-modal'])(
  'fits %s without mistaking CSS or literal punctuation for actual elision',
  async mode => {
    await setup(mode, async (_f, page, node) => {
      const c = target(await run(page), node);
      expect(c, JSON.stringify(c)).toMatchObject({ verdict: 'pass', code: 'DOM_TEXT_BOXES_FIT', facts: { cuts: [] } });
    });
  },
);
it.each(['hard-x', 'hard-y', 'ellipsis-vertical', 'clamp-partial', 'block-child', 'label'])(
  'warns about %s using the built-in policy without a product requirement',
  async mode => {
    await setup(mode, async (_f, page, node) => {
      const c = target(await run(page), node);
      expect(c, JSON.stringify(c)).toMatchObject({
        verdict: 'unknown',
        severity: 'warning',
        code: 'TEXT_HARD_CLIP_SUSPECTED',
        facts: { policy: { source: 'builtin', externalRequirements: 'not-integrated' } },
      });
      expect((c.facts!.cuts as any[]).some(c => c.mechanism === 'hard-clip')).toBe(true);
    });
  },
);
it.each(['ellipsis', 'nested', 'rtl', 'clamp'])(
  'records %s overflow without inferring design compliance or a painted ellipsis',
  async mode => {
    await setup(mode, async (_f, page, node) => {
      const c = target(await run(page), node);
      expect(c, JSON.stringify(c)).toMatchObject({
        verdict: 'unknown',
        severity: 'info',
        code: 'TEXT_ELISION_OBSERVED',
        facts: { elisionMarkerPainted: 'unverified' },
      });
      expect((c.facts!.cuts as any[]).some(c => c.mechanism === (mode === 'clamp' ? 'line-clamp' : 'ellipsis'))).toBe(
        true,
      );
    });
  },
);
it.each(['scroll', 'viewport', 'offscreen-hard'])('defers %s rather than asserting a text defect', async mode => {
  await setup(mode, async (_f, page, node) =>
    expect(target(await run(page), node)).toMatchObject({
      verdict: 'unknown',
      severity: 'info',
      code: 'TEXT_SCROLL_RECHECK_PENDING',
    }),
  );
});
it.each(['transform', 'vertical', 'columns', 'clip-margin', 'absolute-escape', 'fragments-budget'])(
  'does not certify unsupported or incomplete %s text geometry',
  async mode => {
    await setup(mode, async (_f, page, node) =>
      expect(target(await run(page), node)).toMatchObject({ verdict: 'unknown', code: 'TEXT_RECHECK_UNAVAILABLE' }),
    );
  },
);
it.each(['disabled', 'empty', 'title-only', 'input-value', 'hidden-label'])(
  'does not substitute metadata or editing values for a visible label (%s)',
  async mode => {
    await setup(mode, async (_f, page, node) => expect(target(await run(page), node).verdict).toBe('not-applicable'));
  },
);
it('uses captured text rectangles, remains read-only, and does not replace old evidence with live text', async () => {
  await setup('hard-x', async (f, page, node) => {
    expect(page.snapshot.dom!.textGeometry).toMatchObject({ version: 1, fonts: 'loaded' });
    const text = page.snapshot.dom!.nodes.find(n => n.parentId === node && n.nodeType === 'text')!;
    expect(text.textLayout).toMatchObject({ version: 1, status: 'captured' });
    expect(text.textLayout!.rects.length).toBeGreaterThan(0);
    const selection = await f.page.evaluate(() => getSelection()?.toString());
    await f.page.locator('#target').evaluate(el => (el.textContent = 'Short'));
    expect(target(await run(page), node).code).toBe('TEXT_HARD_CLIP_SUSPECTED');
    expect(await f.page.evaluate(() => getSelection()?.toString())).toBe(selection);
    expect(target(await run(await f.inspect()), node).code).toBe('DOM_TEXT_BOXES_FIT');
  });
});
it('keeps old captures, loading fonts, missing ancestors and truncated text unknown', async () => {
  await setup('healthy', async (f, page, node) => {
    const original = page;
    for (const alter of [
      (source: typeof original) => {
        delete source.snapshot.dom!.textGeometry;
      },
      (source: typeof original) => {
        source.snapshot.dom!.textGeometry!.fonts = 'loading';
      },
      (source: typeof original) => {
        source.snapshot.dom!.nodes = source.snapshot.dom!.nodes.filter(n => n.tag !== 'body');
      },
      (source: typeof original) => {
        source.snapshot.dom!.nodes.find(n => n.parentId === node && n.nodeType === 'text')!.textLayout!.status =
          'truncated';
      },
      (source: typeof original) => {
        source.snapshot.dom!.nodes.find(n => n.id === node)!.layout!.client.width = NaN;
      },
    ]) {
      const source = structuredClone(original);
      alter(source);
      expect(target((await runner.run(source, plan))[0], node).verdict).toBe('unknown');
    }
  });
});

it.each(['scroll', 'modal-scroll', 'inner-scroll', 'label-scroll'])(
  'does not track %s text that is out of view, and checks it once scrolled into view',
  async mode => {
    await setup(mode, async (f, firstPage, _node, id) => {
      const tracker = new TextTruncationTracker(),
        first = await tracker.run(firstPage),
        copy = structuredClone(first);
      expect(target(first, id)).toMatchObject({
        verdict: 'unknown',
        severity: 'info',
        code: 'TEXT_SCROLL_RECHECK_PENDING',
        facts: { tracking: 'not-in-view' },
      });
      expect(target(first, id).facts!.issueId).toBeUndefined();
      const page = await scroll(f);
      const report = await tracker.run(page),
        check = target(report, id);
      expect(check, JSON.stringify(check)).toMatchObject({ verdict: 'pass', code: 'DOM_TEXT_BOXES_FIT' });
      expect(await f.page.evaluate(() => scrollY)).toBe(0);
      expect(first).toEqual(copy);
      expect(await tracker.run(page)).toEqual(report);
      await expect(tracker.run(firstPage)).rejects.toThrow('OUT_OF_ORDER');
    });
  },
);

it('does not claim scrolling or upgrade severity when the page cancels movement', async () => {
  await setup('cancel', async (f, page, _node, id) => {
    const tracker = new TextTruncationTracker();
    await tracker.run(page);
    expect(target(await tracker.run(await scroll(f)), id)).toMatchObject({
      verdict: 'unknown',
      severity: 'info',
      code: 'TEXT_SCROLL_RECHECK_PENDING',
      facts: { tracking: 'not-in-view' },
    });
  });
});

it('keeps a hard-clip warning through elision and resolves only comparable geometry, then reopens on recurrence', async () => {
  await setup('hard-x', async (f, page, node, id) => {
    const tracker = new TextTruncationTracker(),
      first = await tracker.run(page),
      issueId = target(first, id).facts!.issueId;
    await f.page.locator('#target').evaluate(el => ((el as HTMLElement).style.textOverflow = 'ellipsis'));
    expect(target(await tracker.run(await f.inspect()), id)).toMatchObject({
      verdict: 'unknown',
      severity: 'warning',
      facts: { lifecycle: 'unverified', issueId },
    });
    await f.page.locator('#target').evaluate(el => ((el as HTMLElement).style.width = '500px'));
    expect(target(await tracker.run(await f.inspect()), id)).toMatchObject({
      verdict: 'pass',
      facts: { lifecycle: 'resolved', issueId },
    });
    await f.page.locator('#target').evaluate(el => {
      (el as HTMLElement).style.width = '120px';
      (el as HTMLElement).style.textOverflow = 'clip';
    });
    expect(target(await tracker.run(await f.inspect()), id)).toMatchObject({
      verdict: 'unknown',
      severity: 'warning',
      facts: { lifecycle: 'suspected', issueId },
    });
  });
});

it.each(['text-change', 'text-rebuild', 'control-rebuild'])(
  'does not transfer recovery across %s even with an unchanged accessible name',
  async mode => {
    await setup('hard-x', async (f, page, node, id) => {
      await f.page.locator('#target').evaluate(el => el.setAttribute('aria-label', 'Stable name'));
      const tracker = new TextTruncationTracker();
      await tracker.run(await f.inspect());
      await f.page.locator('#target').evaluate((el, mode) => {
        if (mode === 'text-change') el.firstChild!.textContent = 'Short';
        if (mode === 'text-rebuild') el.textContent = el.textContent;
        if (mode === 'control-rebuild') {
          const replacement = el.cloneNode(true) as HTMLElement;
          el.replaceWith(replacement);
          el = replacement;
        }
        (el as HTMLElement).style.width = '500px';
      }, mode);
      expect(target(await tracker.run(await f.inspect()), id)).toMatchObject({
        verdict: 'unknown',
        severity: 'warning',
        code: 'TEXT_BASELINE_CHANGED',
        facts: { lifecycle: 'unverified' },
      });
    });
  },
);

it('retains missing evidence and removed targets as unresolved, and processes backlog without live DOM', async () => {
  await setup('hard-x', async (f, page, node, id) => {
    const tracker = new TextTruncationTracker();
    await tracker.run(page);
    const source = structuredClone(await f.inspect());
    delete source.snapshot.dom!.textGeometry;
    expect(target(await tracker.run(source), id)).toMatchObject({
      verdict: 'unknown',
      severity: 'warning',
      facts: { lifecycle: 'unverified' },
    });
    await f.page.locator('#target').evaluate(el => el.remove());
    expect(target(await tracker.run(await f.inspect()), id)).toMatchObject({
      code: 'TEXT_TARGET_UNOBSERVED',
      verdict: 'unknown',
      severity: 'warning',
    });
  });
  await setup('hard-x', async (f, page, node, id) => {
    await f.page.locator('#target').evaluate(el => ((el as HTMLElement).style.width = '500px'));
    const pages = [page, await f.inspect()];
    await f.page.locator('#target').evaluate(el => el.remove());
    const tracker = new TextTruncationTracker();
    const reports = await Promise.all(pages.map(p => tracker.run(p)));
    expect(target(reports[1], id).facts!.lifecycle).toBe('resolved');
  });
});
it('exposes proposal-only interfaces and refuses to silently execute requirements or agent decisions', async () => {
  const proposal = {
    schemaVersion: 1,
    status: 'proposed',
    ruleId: 'text-truncation',
    ruleVersion: '1.0.0',
    target: { sessionId: 's', observationId: 'o', captureId: 'c', documentId: 'd', nodeId: 'n', instanceId: 'i' },
    requirement: 'full-text-inline',
    source: { kind: 'agent-judgment', agentId: 'agent', basis: 'inference' },
    reason: 'Possible primary action',
    evidence: ['capture:c'],
  };
  expect(textRequirementProposalSchema.parse(proposal).status).toBe('proposed');
  expect(() => textRequirementProposalSchema.parse({ ...proposal, status: 'confirmed' })).toThrow();
  expect(() => textRequirementProposalSchema.parse({ ...proposal, evidence: [] })).toThrow();
  expect(() => textRequirementProposalSchema.parse({ ...proposal, target: { nodeId: 'n' } })).toThrow();
  await setup('ellipsis', async (f, page, node) => {
    await expect(runner.run(page, [{ ...plan[0], options: { requirements: [proposal] } }])).rejects.toThrow();
    expect(target(await run(page), node)).toMatchObject({ verdict: 'unknown', severity: 'info' });
    expect(runner.catalog()[0].optionsSchema).toBeDefined();
  });
});

it('retains the original clipped text when a changed label establishes a new baseline', async () => {
  await setup('hard-x', async (f, page, node, id) => {
    const tracker = new TextTruncationTracker(),
      first = target(await tracker.run(page), id);
    expect(first.facts!.lastObservedFinding).toMatchObject({
      code: 'TEXT_HARD_CLIP_SUSPECTED',
      severity: 'warning',
      facts: { cuts: first.facts!.cuts },
    });
    await f.page.locator('#target').evaluate(el => (el.textContent = 'OK'));
    const changed = target(await tracker.run(await f.inspect()), id);
    expect(changed).toMatchObject({
      code: 'TEXT_BASELINE_CHANGED',
      verdict: 'unknown',
      facts: {
        lastObservedFinding: first.facts!.lastObservedFinding,
        currentObservation: { verdict: 'pass', code: 'DOM_TEXT_BOXES_FIT' },
      },
    });
    await f.page.locator('#target').evaluate(el => el.remove());
    expect(target(await tracker.run(await f.inspect()), id).facts!.lastObservedFinding).toEqual(
      first.facts!.lastObservedFinding,
    );
  });
});
