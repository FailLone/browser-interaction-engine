import { describe, expect, it } from 'vitest';
import {
  bindSentinelTarget,
  createSentinelRulePlugins,
  sentinelCatalog,
  sentinelReasons,
  type DomNodeEvidence,
  type RulePage,
  type SentinelBinding,
} from '@interaction/rules';

const at = '2026-10-21T00:00:01.000Z';
const before = '2026-10-21T00:00:00.000Z';
const box = { x: 20, y: 20, width: 100, height: 30 };
const viewport = { x: 0, y: 0, width: 800, height: 600 };
function page(): RulePage {
  const styles = {
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    'font-family': 'sans-serif',
    'font-size': '16px',
    'font-weight': '400',
    'line-height': '20px',
    color: 'rgb(0, 0, 0)',
    'background-color': 'rgb(255, 255, 255)',
    'border-top-width': '1px',
    'border-top-style': 'solid',
    'border-top-color': 'rgb(0, 0, 0)',
    'border-top-left-radius': '0px',
    cursor: 'pointer',
  };
  const nodes: DomNodeEvidence[] = [
    { id: 'root', tag: 'html', nodeType: 'element', children: ['target', 'peer'], rect: viewport, styles, gaps: [] },
    {
      id: 'target',
      tag: 'img',
      nodeType: 'element',
      parentId: 'root',
      children: [],
      attributes: { id: 'subject' },
      text: 'Current identity',
      rect: box,
      styles: { ...styles },
      gaps: [],
      image: {
        version: 1,
        currentSrc: 'https://fixture.test/image.png',
        complete: true,
        naturalWidth: 0,
        naturalHeight: 0,
        loadEpoch: 1,
        motion: 'idle',
        contentBox: { width: 100, height: 30 },
        resource: { version: 1, sourceKey: 'img:1', hasSource: true, event: 'error', eventSequence: 1 },
      },
    },
    {
      id: 'peer',
      tag: 'div',
      nodeType: 'element',
      parentId: 'root',
      children: [],
      attributes: { id: 'peer' },
      text: 'Textual identity',
      rect: { ...box, y: 80 },
      styles: { ...styles },
      gaps: [],
    },
  ];
  return {
    inspection: {
      id: 'i1',
      sessionId: 's1',
      captureId: 'c1',
      observationId: 'o1',
      sequence: 1,
      protocolVersion: 1,
      focus: { regionKey: 'document', kind: 'document', confidence: 'observed' },
    },
    capture: {
      id: 'c1',
      sessionId: 's1',
      observationId: 'o1',
      documentId: 'd1',
      capturedAt: at,
      quality: { status: 'complete', missingRequired: [] },
    },
    observation: { id: 'o1', documentId: 'd1', url: 'https://fixture.test/', stable: true, context: {}, controls: [] },
    snapshot: {
      observationId: 'o1',
      documentId: 'd1',
      runtime: {
        since: before,
        capturedAt: at,
        network: [],
        console: [],
        errors: [],
        dropped: { network: 0, console: 0, errors: 0 },
        truncatedFields: 0,
        frames: [],
      },
      dom: {
        documentId: 'd1',
        capturedAt: at,
        rootId: 'root',
        nodes,
        html: '',
        htmlTruncated: false,
        nodesTruncated: false,
        gaps: [],
        regionRoots: {},
        spatialVersion: 1,
        environment: {
          coordinateSpace: 'layout-viewport-css-px',
          zoom: 'visual-viewport-scale-and-dpr-only',
          devicePixelRatio: 2,
          scroll: { x: 0, y: 0 },
          layoutViewport: { width: 800, height: 600, clientWidth: 800, clientHeight: 600 },
        },
        page: {
          url: 'https://fixture.test/',
          title: '',
          baseURI: 'https://fixture.test/',
          language: 'en',
          characterSet: 'UTF-8',
          readyState: 'complete',
          doctype: 'html',
          metadata: [],
        },
      },
    },
  };
}
const node = (p: RulePage, id = 'target') => p.snapshot.dom!.nodes.find(n => n.id === id)!;
function binding(p: RulePage, ruleId: string, data?: unknown): SentinelBinding {
  return {
    ruleId,
    target: bindSentinelTarget(p, 'target'),
    applicability: 'yes',
    source: 'synthetic-fixture:v1',
    reason: 'The fixture declares this semantic relationship',
    evidence: ['fixture-observation:1'],
    data,
  };
}
async function run(p: RulePage, id: string, data: unknown, modify?: (b: SentinelBinding) => void) {
  const bound = binding(p, id, data);
  modify?.(bound);
  return createSentinelRulePlugins({ rules: [id], collect: () => [bound] })[0]
    .create()
    .run(p);
}
const equivalent = {
  role: 'section-title',
  state: 'rest',
  variant: 'standard',
  density: 'normal',
  platform: 'desktop',
  breakpoint: 'wide',
  version: 'v1',
};
const tokenContext = {
  environment: 'runtime',
  version: 'v1',
  mode: 'light',
  scope: 'card',
  normalization: 'rgba-8-bit',
};
const transition = (time: string) => ({
  at: time,
  operationId: 'load:1',
  attempt: 'try:1',
  phase: 'loading',
  feedback: 'loading',
  feedbackOperationId: 'load:1',
  feedbackAttempt: 'try:1',
  previousResultMarked: false,
  contentCount: 1,
});
const motion = (time: string) => ({
  at: time,
  contentKey: 'entity:1',
  breakpoint: 'wide',
  rect: { ...box },
  scroll: { x: 0, y: 0 },
  visible: true,
  moving: false,
});
interface Scenario {
  id: string;
  prepare?: (p: RulePage) => void;
  problemPage?: (p: RulePage) => void;
  data(p: RulePage): { healthy: unknown; problem: unknown; exception: unknown };
}
const scenarios: Scenario[] = [
  {
    id: 'UIK-D002',
    problemPage: p => {
      node(p, 'peer').rect!.y = 25;
    },
    data: p => {
      const healthy = {
        other: bindSentinelTarget(p, 'peer'),
        coexist: true,
        intentionalOverlay: false,
        informationReadable: true,
        operationReachable: true,
      };
      return {
        healthy,
        problem: { ...healthy, informationReadable: false },
        exception: { ...healthy, intentionalOverlay: true },
      };
    },
  },
  {
    id: 'UIK-D003',
    data: () => {
      const outside = { viewport, target: { ...box, y: 700 }, operable: false };
      const problem = {
        allowed: true,
        viewportChanged: true,
        supportedViewport: true,
        requiredPaths: ['page', 'panel'],
        paths: [
          { id: 'page', exhausted: true, samples: [outside] },
          { id: 'panel', exhausted: true, samples: [outside] },
        ],
      };
      return {
        problem,
        healthy: {
          ...problem,
          paths: [{ id: 'page', exhausted: false, samples: [{ viewport, target: box, operable: true }] }],
        },
        exception: { ...problem, allowed: false },
      };
    },
  },
  {
    id: 'UIK-D006',
    data: () => {
      const healthy = {
        operationId: 'load:1',
        attempt: 'try:1',
        complete: true,
        samples: [transition(before), transition(at)],
      };
      return {
        healthy,
        problem: { ...healthy, samples: [transition(before), { ...transition(at), feedback: 'empty' }] },
        exception: {
          ...healthy,
          samples: [transition(before), transition(at)].map(s => ({ ...s, phase: 'empty', feedback: 'empty' })),
        },
      };
    },
  },
  {
    id: 'UIK-D007',
    data: () => {
      const healthy = {
        selectionKnown: true,
        selected: true,
        neededForOrientation: true,
        selectionKey: 'period:long',
        cuesComplete: true,
        cues: [{ kind: 'background', visible: true, evidence: 'screen:1' }],
      };
      return {
        healthy,
        problem: { ...healthy, cues: [{ kind: 'underline', visible: false, evidence: 'screen:1' }] },
        exception: { ...healthy, selected: false },
      };
    },
  },
  {
    id: 'UIK-D008',
    data: p => {
      const target = bindSentinelTarget(p, 'target'),
        peer = bindSentinelTarget(p, 'peer');
      const healthy = {
        mappingsComplete: true,
        alternativesChecked: true,
        series: [
          { id: 'a', required: true, identifiers: [{ target, identifies: 'a', reachable: true, readable: true }] },
          {
            id: 'b',
            required: true,
            identifiers: [{ target: peer, identifies: 'b', reachable: true, readable: true }],
          },
        ],
        annotations: [{ target, intendedSeries: 'a', observedSeries: 'a' }],
      };
      return {
        healthy,
        problem: { ...healthy, annotations: [{ target, intendedSeries: 'a', observedSeries: 'b' }] },
        exception: { ...healthy, series: healthy.series.slice(0, 1), annotations: [] },
      };
    },
  },
  {
    id: 'UIK-D009',
    data: p => {
      const healthy = {
        owner: bindSentinelTarget(p, 'root'),
        kind: 'fill',
        allowBleed: false,
        boundary: viewport,
        radius: { x: 10, y: 10 },
        paintCaptureId: p.capture.id,
        paintComplete: true,
        painted: [box],
      };
      return {
        healthy,
        problem: { ...healthy, painted: [{ x: 795, y: 20, width: 10, height: 10 }] },
        exception: { ...healthy, kind: 'focus-ring' },
      };
    },
  },
  {
    id: 'UIK-D011',
    data: () => {
      const healthy = {
        definitionContext: tokenContext,
        consumerContext: tokenContext,
        token: 'button',
        consumerToken: 'button',
        overrideAllowed: false,
        definitions: [
          { id: 'button', kind: 'alias', to: 'brand' },
          { id: 'brand', kind: 'value', value: [0, 0, 0, 255] },
        ],
        consumerValue: [0, 0, 0, 255],
      };
      return {
        healthy,
        problem: { ...healthy, consumerValue: [255, 0, 0, 255] },
        exception: { ...healthy, consumerContext: { ...tokenContext, mode: 'dark' } },
      };
    },
  },
  ...['UIK-R001', 'UIK-R002'].map(id => ({
    id,
    problemPage: (p: RulePage) => {
      node(p, 'peer').styles!['font-size'] = '32px';
    },
    data: (p: RulePage) => {
      const healthy = {
        context: equivalent,
        peers: [{ target: bindSentinelTarget(p, 'peer'), context: equivalent }],
        allowedDifferences: [],
      };
      return {
        healthy,
        problem: healthy,
        exception: { ...healthy, peers: [{ ...healthy.peers[0], context: { ...equivalent, variant: 'compact' } }] },
      };
    },
  })),
  {
    id: 'UIK-R003',
    problemPage: p => {
      node(p, 'peer').rect!.x = 35;
    },
    data: p => {
      const healthy = { group: 'related-fields', peers: [bindSentinelTarget(p, 'peer')], intent: 'start', axis: 'x' };
      return { healthy, problem: healthy, exception: { ...healthy, intent: 'content-sized' } };
    },
  },
  {
    id: 'UIK-R004',
    data: p => {
      const healthy = {
        currentTheme: 'light',
        referenceTheme: 'dark',
        sameContent: true,
        identityRequired: true,
        currentCaptureId: p.capture.id,
        referenceEvidence: 'dark-screen:1',
        currentRecognizable: true,
        referenceRecognizable: true,
      };
      return {
        healthy,
        problem: { ...healthy, currentRecognizable: false },
        exception: { ...healthy, identityRequired: false },
      };
    },
  },
  {
    id: 'UIK-R005',
    data: p => {
      const healthy = {
        identityRequired: true,
        intendedEntity: 'entity:1',
        fallbackKind: 'neutral',
        textAlternative: bindSentinelTarget(p, 'peer'),
        textIdentifiesEntity: true,
        layoutStable: true,
      };
      return {
        healthy,
        problem: { ...healthy, fallbackKind: 'entity', fallbackEntity: 'entity:2' },
        exception: { ...healthy, identityRequired: false },
      };
    },
  },
  {
    id: 'UIK-R006',
    data: p => {
      const healthy = {
        activated: true,
        actualState: 'empty',
        stateEvidence: 'request:completed',
        feedback: [bindSentinelTarget(p, 'peer')],
        explainedByContext: false,
        feedbackAccurate: true,
      };
      return {
        healthy,
        problem: { ...healthy, feedback: [], feedbackAccurate: false },
        exception: { ...healthy, activated: false },
      };
    },
  },
  {
    id: 'UIK-R007',
    data: () => {
      const healthy = {
        contextNeeded: true,
        pathComplete: true,
        from: 'list',
        current: 'details',
        expectedDestination: 'list',
        observedDestination: 'list',
        contextIdentifiable: true,
        directionPredictable: true,
        alternativePathClear: false,
      };
      return {
        healthy,
        problem: { ...healthy, observedDestination: 'unrelated' },
        exception: { ...healthy, contextNeeded: false },
      };
    },
  },
  {
    id: 'UIK-R008',
    data: () => {
      const healthy = {
        sameTarget: true,
        complete: true,
        intendedReflow: false,
        userInitiatedMotion: false,
        reducedMotion: false,
        samples: [motion(before), motion(at)],
      };
      return {
        healthy,
        problem: { ...healthy, samples: [motion(before), { ...motion(at), rect: { ...box, y: 200 } }] },
        exception: { ...healthy, intendedReflow: true },
      };
    },
  },
  {
    id: 'UIK-R009',
    data: () => {
      const healthy = { actual: 'enabled', perceived: 'enabled', alternativeCue: false, intentionalStaticLabel: false };
      return {
        healthy,
        problem: { ...healthy, perceived: 'disabled' },
        exception: { ...healthy, actual: 'static', perceived: 'static', intentionalStaticLabel: true },
      };
    },
  },
  {
    id: 'UIK-R010',
    data: () => {
      const healthy = {
        styleChanged: true,
        keyboardFocusable: true,
        pathComplete: true,
        visits: [{ modality: 'keyboard', active: true, indicatorVisible: true, evidence: 'keyboard-screen:1' }],
      };
      return {
        healthy,
        problem: { ...healthy, visits: [{ ...healthy.visits[0], indicatorVisible: false }] },
        exception: { ...healthy, styleChanged: false },
      };
    },
  },
  {
    id: 'UIK-R011',
    data: () => {
      const healthy = {
        purpose: 'scroll-cue',
        orderKnown: true,
        positionsComplete: true,
        samples: [
          { position: 0, maximum: 100, cues: ['end'], obscuresRequiredContent: false, evidence: 'start-screen:1' },
          { position: 100, maximum: 100, cues: ['start'], obscuresRequiredContent: false, evidence: 'end-screen:1' },
        ],
      };
      return {
        healthy,
        problem: { ...healthy, samples: healthy.samples.map(s => ({ ...s, cues: ['end'] })) },
        exception: { ...healthy, purpose: 'decoration' },
      };
    },
  },
  {
    id: 'UIK-R012',
    prepare: p => {
      Object.assign(node(p).image!, { naturalWidth: 100, naturalHeight: 30 });
    },
    data: p => {
      const healthy = {
        purpose: 'entity identity',
        style: 'continuous',
        currentSrc: node(p).image!.currentSrc,
        loadEpoch: 1,
        pixelWidth: 200,
        pixelHeight: 60,
        renderedWidth: 100,
        renderedHeight: 30,
        screenshotUncompressed: true,
        recognizable: true,
      };
      return { healthy, problem: { ...healthy, recognizable: false }, exception: { ...healthy, style: 'pixel-art' } };
    },
  },
];

for (const scenario of scenarios)
  describe(scenario.id, () => {
    it('has an actual healthy pass within its stated scope', async () => {
      const p = page();
      scenario.prepare?.(p);
      const original = structuredClone(p);
      expect((await run(p, scenario.id, scenario.data(p).healthy)).verdict).toBe('pass');
      expect(p).toEqual(original);
    });
    it('finds its problem, preserving the distinction between defect and review', async () => {
      const p = page();
      scenario.prepare?.(p);
      scenario.problemPage?.(p);
      const report = await run(p, scenario.id, scenario.data(p).problem);
      expect(report).toMatchObject({ verdict: scenario.id.includes('-D') ? 'fail' : 'unknown', severity: 'warning' });
      expect(report.checks[0].code).toBe(scenario.id.includes('-D') ? 'UIK_DEFECT_OBSERVED' : 'UIK_REVIEW_SUGGESTED');
      expect(report.checks[0].evidence).toContain('fixture-observation:1');
    });
    it('recognizes its legitimate exception', async () => {
      const p = page();
      scenario.prepare?.(p);
      expect((await run(p, scenario.id, scenario.data(p).exception)).verdict).toBe('not-applicable');
    });
    it('keeps missing evidence unknown, rather than silently passing', async () => {
      expect(await run(page(), scenario.id, {})).toMatchObject({ verdict: 'unknown', severity: 'info' });
    });
  });

it('accounts for all 23 documents without duplicating the four existing measurements', () => {
  expect(sentinelCatalog).toHaveLength(23);
  expect(new Set(sentinelCatalog.map(r => r.id)).size).toBe(23);
  expect(createSentinelRulePlugins().map(r => r.id)).toEqual(scenarios.map(s => s.id));
  expect(sentinelCatalog.filter(r => r.plugin === 'rules').map(r => r.id)).toEqual([
    'UIK-D001',
    'UIK-D004',
    'UIK-D005',
    'UIK-D010',
  ]);
});

it('collects once per capture, freezes host input, and records all unbound checks as unknown', async () => {
  let calls = 0;
  const p = page();
  const plugins = createSentinelRulePlugins({
    collect: captured => {
      calls++;
      expect(Object.isFrozen(captured.snapshot.dom!.nodes[0])).toBe(true);
      return [];
    },
  });
  for (const plugin of plugins) {
    const result = await plugin.create().run(p);
    expect(result).toMatchObject({ verdict: 'unknown', severity: 'info' });
    expect(result.checks[0].code).toBe('UIK_BINDING_REQUIRED');
  }
  expect(calls).toBe(1);
});

it.each(['captureId', 'documentId', 'observationId', 'sessionId', 'nodeId', 'fingerprint'] as const)(
  'rejects stale or unavailable target %s',
  async field => {
    const p = page();
    const s = scenarios.find(s => s.id === 'UIK-D007')!;
    const result = await run(p, s.id, s.data(p).healthy, b => {
      b.target[field] = 'stale';
    });
    expect(result.verdict).toBe('unknown');
  },
);

it('does not silently select the first duplicate node or conflicting binding', async () => {
  const p = page();
  const b = binding(p, 'UIK-D007', scenarios.find(s => s.id === 'UIK-D007')!.data(p).healthy);
  const duplicate = createSentinelRulePlugins({ rules: [b.ruleId], collect: () => [b, b] });
  expect((await duplicate[0].create().run(p)).checks[0].code).toBe('UIK_BINDING_INVALID');
  p.snapshot.dom!.nodes.push(structuredClone(node(p)));
  const ambiguous = createSentinelRulePlugins({ rules: [b.ruleId], collect: () => [b] });
  expect((await ambiguous[0].create().run(p)).checks[0].code).toBe('UIK_TARGET_UNAVAILABLE');
});

it('rejects old peer references after layout or name changes but permits fresh binding to renamed targets', async () => {
  const p = page();
  const s = scenarios.find(s => s.id === 'UIK-R001')!;
  const old = s.data(p).healthy;
  node(p, 'peer').text = 'A completely different display name';
  node(p, 'peer').rect!.y += 20;
  expect((await run(p, s.id, old)).checks[0].code).toBe('UIK_TARGET_STALE');
  expect((await run(p, s.id, s.data(p).healthy)).verdict).toBe('pass');
});

it('bounds evidence providers and isolates malformed per-rule data', async () => {
  const p = page();
  let signal: AbortSignal | undefined;
  const slow = createSentinelRulePlugins({
    rules: ['UIK-D007'],
    collectTimeoutMs: 5,
    collect: (_p, s) => {
      signal = s;
      return new Promise(() => {});
    },
  });
  expect((await slow[0].create().run(p)).checks[0].code).toBe('UIK_BINDING_INVALID');
  expect(signal!.aborted).toBe(true);
  const good = scenarios.find(s => s.id === 'UIK-D007')!.data(p).healthy;
  const rules = createSentinelRulePlugins({
    rules: ['UIK-D006', 'UIK-D007'],
    collect: () => [binding(p, 'UIK-D006', {}), binding(p, 'UIK-D007', good)],
  });
  expect((await rules[0].create().run(p)).verdict).toBe('unknown');
  expect((await rules[1].create().run(p)).verdict).toBe('pass');
});

it('does not infer viewport impossibility from an incomplete scroll search', async () => {
  const p = page();
  const data = scenarios.find(s => s.id === 'UIK-D003')!.data(p).problem as { paths: { exhausted: boolean }[] };
  data.paths[1].exhausted = false;
  expect((await run(p, 'UIK-D003', data)).verdict).toBe('unknown');
});

it('allows a retained, clearly marked previous failure while a new request loads', async () => {
  const p = page();
  const data = {
    operationId: 'load:1',
    attempt: 'try:1',
    complete: true,
    samples: [
      transition(before),
      { ...transition(at), feedback: 'failure', feedbackAttempt: 'try:0', previousResultMarked: true },
    ],
  };
  expect((await run(p, 'UIK-D006', data)).verdict).toBe('pass');
  data.samples[1].previousResultMarked = false;
  expect((await run(p, 'UIK-D006', data)).verdict).toBe('unknown');
  data.samples[1].attempt = 'different-request';
  expect((await run(p, 'UIK-D006', data)).verdict).toBe('unknown');
});

it('does not require an underline if a visible background cue still communicates selection', async () => {
  const data = {
    selectionKnown: true,
    selected: true,
    neededForOrientation: true,
    selectionKey: 'period:long',
    cuesComplete: true,
    cues: [
      { kind: 'underline', visible: false, evidence: 'screen:1' },
      { kind: 'background', visible: true, evidence: 'screen:1' },
    ],
  };
  expect((await run(page(), 'UIK-D007', data)).verdict).toBe('pass');
  data.cues = [];
  data.cuesComplete = false;
  expect((await run(page(), 'UIK-D007', data)).verdict).toBe('unknown');
});

it('rejects incomplete and cyclic token aliases without using screenshot colors', async () => {
  const data = {
    definitionContext: tokenContext,
    consumerContext: tokenContext,
    token: 'a',
    consumerToken: 'a',
    overrideAllowed: false,
    definitions: [{ id: 'a', kind: 'alias', to: 'b' }],
    consumerValue: 'black',
  };
  expect((await run(page(), 'UIK-D011', data)).verdict).toBe('unknown');
  data.definitions.push({ id: 'b', kind: 'alias', to: 'a' });
  expect((await run(page(), 'UIK-D011', data)).verdict).toBe('unknown');
});

it('requires keyboard visits and does not treat a pointer focus ring as a defect', async () => {
  const data = {
    styleChanged: true,
    keyboardFocusable: true,
    pathComplete: true,
    visits: [{ modality: 'pointer', active: true, indicatorVisible: true, evidence: 'screen:1' }],
  };
  expect((await run(page(), 'UIK-R010', data)).verdict).toBe('unknown');
});

it('requires actual resource pixels and visual judgment for image clarity', async () => {
  const p = page(),
    s = scenarios.find(s => s.id === 'UIK-R012')!;
  s.prepare!(p);
  const data = s.data(p).healthy as { recognizable: boolean | null; pixelWidth: number; currentSrc: string };
  data.recognizable = null;
  expect(await run(p, s.id, data)).toMatchObject({ verdict: 'unknown', severity: 'info' });
  data.pixelWidth = 50;
  expect(await run(p, s.id, data)).toMatchObject({ verdict: 'unknown', severity: 'warning' });
  data.currentSrc = 'https://another.test/old.png';
  expect(await run(p, s.id, data)).toMatchObject({ verdict: 'unknown', severity: 'info' });
});

it('explains every Sentinel code and validates explicit rule selection', async () => {
  const codes = new Set<string>();
  for (const s of scenarios) {
    const p = page();
    s.prepare?.(p);
    s.problemPage?.(p);
    for (const data of Object.values(s.data(p))) {
      const report = await run(p, s.id, data);
      for (const c of report.checks) codes.add(c.code);
    }
  }
  expect([...codes].filter(code => !sentinelReasons[code])).toEqual([]);
  expect(() => createSentinelRulePlugins({ rules: ['UIK-D010'] })).toThrow();
  expect(() => createSentinelRulePlugins({ rules: ['UIK-D007', 'UIK-D007'] })).toThrow();
  expect(() => createSentinelRulePlugins({ collectTimeoutMs: 0 })).toThrow();
});

it.each([
  (p: RulePage) => {
    p.capture.sessionId = 'other-session';
  },
  (p: RulePage) => {
    p.snapshot.documentId = 'other-document';
  },
  (p: RulePage) => {
    p.snapshot.dom!.nodesTruncated = true;
  },
  (p: RulePage) => {
    p.observation.stable = false;
  },
  (p: RulePage) => {
    p.capture.quality.missingRequired = ['web.styles'];
  },
  (p: RulePage) => {
    p.inspection.focus.confidence = 'unknown';
  },
  (p: RulePage) => {
    node(p).gaps.push({ code: 'FIELD_TRUNCATED', message: 'style:color was truncated' });
  },
  (p: RulePage) => {
    node(p).styles!.opacity = '0';
  },
])('keeps incomplete, invisible or mismatched evidence unresolved (%#)', async mutate => {
  const p = page();
  mutate(p);
  const data = scenarios.find(s => s.id === 'UIK-D007')!.data(p).healthy;
  expect((await run(p, 'UIK-D007', data)).verdict).toBe('unknown');
});

it('does not certify painted non-overlap merely because DOM boxes are disjoint', async () => {
  const p = page();
  const data = { other: bindSentinelTarget(p, 'peer'), coexist: true, intentionalOverlay: false };
  expect((await run(p, 'UIK-D002', data)).verdict).toBe('unknown');
});

it('does not treat a collapsed control as proof of viewport unreachability', async () => {
  const data = {
    allowed: true,
    viewportChanged: true,
    supportedViewport: true,
    requiredPaths: ['page'],
    paths: [{ id: 'page', exhausted: true, samples: [{ viewport, target: { ...box, width: 0 }, operable: false }] }],
  };
  expect((await run(page(), 'UIK-D003', data)).verdict).toBe('unknown');
});

it('requires current paint, catches corner leakage and permits no visible decoration', async () => {
  const p = page();
  const healthy = scenarios.find(s => s.id === 'UIK-D009')!.data(p).healthy as Record<string, unknown>;
  expect((await run(p, 'UIK-D009', { ...healthy, paintCaptureId: 'old' })).verdict).toBe('unknown');
  expect((await run(p, 'UIK-D009', { ...healthy, painted: [{ x: 0, y: 0, width: 2, height: 2 }] })).verdict).toBe(
    'fail',
  );
  expect((await run(p, 'UIK-D009', { ...healthy, painted: [] })).verdict).toBe('not-applicable');
});

it('does not count an invisible peer as a healthy typography comparison', async () => {
  const p = page();
  node(p, 'peer').styles!.opacity = '0';
  const data = scenarios.find(s => s.id === 'UIK-R001')!.data(p).healthy;
  expect((await run(p, 'UIK-R001', data)).verdict).toBe('unknown');
});

it('compensates for ordinary scroll movement in continuity observations', async () => {
  const data = {
    sameTarget: true,
    complete: true,
    intendedReflow: false,
    userInitiatedMotion: false,
    reducedMotion: false,
    samples: [motion(before), { ...motion(at), rect: { ...box, y: 0 }, scroll: { x: 0, y: 20 } }],
  };
  expect((await run(page(), 'UIK-R008', data)).verdict).toBe('pass');
});

it('does not reuse cached healthy evidence after a caller mutates the same capture object', async () => {
  const p = page();
  let calls = 0;
  const plugin = createSentinelRulePlugins({
    rules: ['UIK-R001'],
    collect: captured => {
      calls++;
      return [binding(captured, 'UIK-R001', scenarios.find(s => s.id === 'UIK-R001')!.data(captured).healthy)];
    },
  })[0].create();
  expect((await plugin.run(p)).verdict).toBe('pass');
  node(p, 'peer').styles!['font-size'] = '40px';
  expect((await plugin.run(p)).checks[0].code).toBe('UIK_TARGET_STALE');
  expect(calls).toBe(1);
});
