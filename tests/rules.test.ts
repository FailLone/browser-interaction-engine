import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  RuleRunner,
  sampledOcclusionRule,
  type ControlRule,
  type RuleAssessment,
  type RulePage,
  type RuleSelection,
} from '@interaction/rules';
import { fixtureServer, withFixture as openFixture, type RuleFixture } from './rule-fixture.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => {
  fixture = await fixtureServer();
});
afterAll(async () => {
  await fixture.server.close();
});
const runner = new RuleRunner([sampledOcclusionRule]);
const plan: RuleSelection[] = [{ ruleId: 'sampled-occlusion', ruleVersion: '1.0.0' }];
async function withFixture(mode: string, run: (f: RuleFixture, page: RulePage) => Promise<void>) {
  await openFixture(`${fixture.url}/rules.html?mode=${mode}`, async (f, page) => {
    await f.settle(40);
    await run(f, mode === 'endpoint' ? await f.inspect() : page);
  });
}
function targetPlan(page: RulePage, name = 'Target'): RuleSelection[] {
  const control = page.observation.controls.find(c => c.name === name)!;
  expect(control).toBeDefined();
  return [{ ...plan[0], targets: [{ captureId: page.capture.id, nodeId: control.localId }] }];
}

it.each(['healthy', 'pointer-transparent'])(
  'passes only the sampled hit for %s, including descendant hits',
  async mode => {
    await withFixture(mode, async (f, page) => {
      const [report] = await runner.run(page, targetPlan(page));
      expect(report).toMatchObject({ verdict: 'pass', severity: 'info' });
      expect(report.checks[0]).toMatchObject({ code: 'SAMPLE_REACHABLE', facts: { coverage: 'one-point-only' } });
      const [disabled] = await runner.run(page, targetPlan(page, 'Disabled'));
      expect(disabled.verdict).toBe('not-applicable');
    });
  },
);

it.each(['fixed', 'sticky', 'endpoint', 'non-scrollable', 'tooltip'])(
  'keeps %s interception unresolved instead of inventing a permanent defect',
  async mode => {
    await withFixture(mode, async (f, page) => {
      const [report] = await runner.run(page, targetPlan(page));
      expect(report).toMatchObject({ verdict: 'unknown', severity: 'warning' });
      expect(report.checks[0]).toMatchObject({ code: 'SAMPLE_INTERCEPTED', facts: { recovery: 'unverified' } });
      if (['fixed', 'sticky', 'endpoint', 'non-scrollable'].includes(mode))
        expect(report.checks[0].facts!.positionedAncestors).not.toEqual([]);
      if (mode === 'endpoint') {
        expect(
          await f.page.evaluate(() => Math.abs(scrollY + innerHeight - document.documentElement.scrollHeight) <= 1),
        ).toBe(true);
      }
    });
  },
);

it('limits a capture to the active popover without treating its background as healthy', async () => {
  await withFixture('popover', async (f, page) => {
    expect(page.observation.overlays?.at(-1)?.kind).toBe('popover');
    const [background] = await runner.run(page, targetPlan(page));
    expect(background.checks[0]).toMatchObject({ verdict: 'not-applicable', code: 'OUTSIDE_ACTIVE_SCOPE' });
    const [inside] = await runner.run(page, targetPlan(page, 'Inside'));
    expect(inside.verdict).toBe('pass');
  });
});

it('excludes modal background while still inspecting controls in the modal', async () => {
  await withFixture('modal', async (f, page) => {
    const [background] = await runner.run(page, targetPlan(page));
    expect(background.checks[0].code).toBe('MODAL_BACKGROUND');
    expect(background.verdict).toBe('not-applicable');
    const [inside] = await runner.run(page, targetPlan(page, 'Inside'));
    expect(inside.verdict).toBe('pass');
  });
});

it.each(['nested-modal', 'nested-popover'])(
  'checks portalled %s controls inside the logical modal scope',
  async mode => {
    await withFixture(mode, async (f, page) => {
      const [child] = await runner.run(page, targetPlan(page, 'Child'));
      expect(child.verdict).toBe('pass');
      const [background] = await runner.run(page, targetPlan(page));
      expect(background.verdict).toBe('not-applicable');
      if (mode === 'nested-modal') {
        const [parent] = await runner.run(page, targetPlan(page, 'Inside'));
        expect(parent.verdict).toBe('not-applicable');
      }
    });
  },
);

it('uses fresh captures after caller-controlled scrolling and never changes or substitutes historical evidence', async () => {
  await withFixture('fixed', async (f, page) => {
    const initialPlan = targetPlan(page);
    const original = await runner.run(page, initialPlan);
    await f.page.evaluate(() => window.scrollTo(0, 200)); // Test fixture action, not a rule side effect.
    const current = await f.inspect();
    expect((await runner.run(current, targetPlan(current)))[0].verdict).toBe('pass');
    expect(await runner.run(page, initialPlan)).toEqual(original);
    expect((await runner.run(current, initialPlan))[0].checks[0].code).toBe('TARGET_UNAVAILABLE');
    expect(await f.page.evaluate(() => scrollY)).toBe(200);
  });
});

it('validates plans before execution, isolates failures, and does not turn empty selection into pass', async () => {
  await withFixture('healthy', async (f, page) => {
    expect(runner.catalog()[0].optionsSchema).toMatchObject({
      properties: { includeDisabled: { type: 'boolean', default: false } },
    });
    expect(await runner.run(page, [])).toEqual([]);
    expect(await runner.run(page, [{ ...plan[0], enabled: false }])).toEqual([]);
    await expect(runner.run(page, [{ ...plan[0], ruleVersion: 'wrong' }])).rejects.toThrow('Unknown rule/version');
    await expect(runner.run(page, [{ ...plan[0], options: { execute: 'arbitrary code' } }])).rejects.toThrow();
    await expect(runner.run(page, [plan[0], plan[0]])).rejects.toThrow('Select each rule once');
    expect((await runner.run(page, [{ ...plan[0], targets: [] }]))[0].verdict).toBe('not-applicable');
    const bad: ControlRule = {
      ...sampledOcclusionRule,
      id: 'bad',
      configure: () => context => {
        context.node.tag = 'mutated';
        throw new Error('should not get here');
      },
    };
    const isolated = new RuleRunner([bad, sampledOcclusionRule]);
    const results = await isolated.run(page, [{ ...targetPlan(page)[0], ruleId: 'bad' }, ...targetPlan(page)]);
    expect(results[0].checks[0].code).toBe('RULE_ERROR');
    expect(results[1].verdict).toBe('pass');
    const slow = new RuleRunner(
      [{ ...bad, id: 'slow', configure: () => () => new Promise<RuleAssessment>(() => {}) }],
      { timeoutMs: 10 },
    );
    expect((await slow.run(page, [{ ...plan[0], ruleId: 'slow' }]))[0].checks[0].code).toBe('RULE_TIMEOUT');
    const partial = new RuleRunner(
      [
        {
          ...bad,
          id: 'partial',
          configure: () => {
            let calls = 0;
            return () =>
              ++calls === 1
                ? {
                    verdict: 'fail',
                    severity: 'error',
                    code: 'KNOWN_FAILURE',
                    expected: 'Test contract',
                    actual: 'Known failure before timeout',
                    evidence: [],
                  }
                : new Promise<RuleAssessment>(() => {});
          },
        },
      ],
      { timeoutMs: 10 },
    );
    const [partialReport] = await partial.run(page, [{ ...plan[0], ruleId: 'partial' }]);
    expect(partialReport).toMatchObject({ verdict: 'fail', severity: 'error' });
    expect(partialReport.checks.map(c => c.code)).toEqual(['KNOWN_FAILURE', 'RULE_TIMEOUT']);
  });
});

it('does not pass missing, incompatible, unstable, truncated or incorrectly bound evidence', async () => {
  await withFixture('healthy', async (f, page) => {
    const original = page;
    for (const mutate of [
      (s: RulePage) => {
        s.snapshot.dom = undefined;
      },
      (s: RulePage) => {
        (s.inspection as { protocolVersion: number }).protocolVersion = 2;
      },
      (s: RulePage) => {
        delete s.snapshot.dom!.spatialVersion;
      },
      (s: RulePage) => {
        s.snapshot.dom!.nodesTruncated = true;
      },
      (s: RulePage) => {
        s.observation.stable = false;
      },
      (s: RulePage) => {
        s.capture.documentId = 'another-document';
      },
      (s: RulePage) => {
        s.capture.quality.status = 'incomplete';
      },
    ]) {
      const source = structuredClone(original);
      mutate(source);
      const [result] = await runner.run(source, plan);
      expect(result.verdict).toBe('unknown');
    }
  });
});
