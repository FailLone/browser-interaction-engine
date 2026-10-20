import type {
  ActionEvent,
  BacktrackEvent,
  Box,
  CheckInfo,
  Event,
  FindingEvent,
  InspectionEvent,
  JudgementEvent,
  SweepEvent,
  ModelCallSummary,
  NavigationEvent,
  PluginErrorEvent,
  ScreenView,
} from './types.js';

/** What plugins checked on one new state: each plugin's inspection, and what it reported there. */
export interface StateChecks {
  /** State id. */
  state: string;
  /** Seq of the first event about it, to order it among the run's events. */
  seq: number;
  at: number;
  /** The action that reached the state; none for the entry page. */
  node?: ActionNode;
  inspections: InspectionEvent[];
  /** The state scrolled to the end, when it was. */
  sweep?: SweepEvent;
  /** Findings first reported on this state, and plugin errors. */
  findings: (FindingEvent | PluginErrorEvent)[];
}

/** One executed action, placed under the action that led to the state it was taken in. */
export interface ActionNode {
  event: ActionEvent;
  /** 1-based position among the run's actions. */
  index: number;
  parent?: ActionNode;
  children: ActionNode[];
  /** State ids before and after; `after` is unknown when a backtrack or the end followed. */
  before?: string;
  after?: string;
  /** The action led to a state that was already on the tree (e.g. closing a dialog). */
  returned: boolean;
  /** Where it returned to: the action that first reached that state, or the entry page. */
  returnedTo?: ActionNode | 'entry';
  /** Model judgements between the previous action and this one. */
  context: (JudgementEvent | NavigationEvent)[];
  /** Navigations this action set off (intercepted, popup or route change). */
  triggered: NavigationEvent[];
  /**
   * Links recorded from their href while choosing this action, without clicking them: the
   * crawler tests one page, so a link elsewhere is recorded, not followed.
   */
  linksSeen: NavigationEvent[];
  /** Backtracks right after this action: the walk ended here and went back. */
  backtracks: BacktrackEvent[];
  /** After those backtracks, the walk went on from the state this action reached, or the entry page. */
  resumedAt?: ActionNode | 'entry';
}
export interface ActionTree {
  /** The entry page: its own state, the first actions, and what was asked before the first action. */
  root: {
    state?: string;
    children: ActionNode[];
    context: (JudgementEvent | NavigationEvent)[];
    backtracks: BacktrackEvent[];
  };
  nodes: Map<number, ActionNode>;
  /** Actions in run order. */
  actions: ActionNode[];
  /** States with a screenshot (announced by a state event). */
  screenshots: Set<string>;
  /** Scroll and viewport of each state's screenshot, when recorded. */
  views: Map<string, ScreenView>;
  /** States first seen right after an action, by that action's seq: their screenshot shows its result. */
  shotAfter: Map<number, string>;
  /** Judgements after the last action. */
  tail: JudgementEvent[];
  /** Plugin checks per state id, and per the action that reached the state (by seq). */
  checks: Map<string, StateChecks>;
  checksAfter: Map<number, StateChecks[]>;
  /** Checks on states reached before any action (the entry page). */
  entryChecks: StateChecks[];
  /** Check names by `plugin/id`. */
  checkNames: Map<string, CheckInfo>;
  /** Plain-words explanations of result codes, by `plugin/code`. */
  reasons: Map<string, string>;
  /** Findings in the order reported, which is how an inspection's `repeated` refers to them. */
  findings: FindingEvent[];
}

/**
 * Rebuilds the walk from the flat event log. The crawler acts in a state, moves on to the state
 * the action led to, and backtracks (replays from the entry page) when a state is exhausted. An
 * action is placed under the action that first reached the state it was taken in, so a walk reads
 * top to bottom until it ends, and what follows a backtrack hangs where the replay landed.
 */
export function buildActionTree(events: Event[]): ActionTree {
  const tree: ActionTree = {
    root: { children: [], context: [], backtracks: [] },
    nodes: new Map(),
    actions: [],
    screenshots: new Set(),
    views: new Map(),
    shotAfter: new Map(),
    tail: [],
    checks: new Map(),
    checksAfter: new Map(),
    entryChecks: [],
    checkNames: new Map(),
    reasons: new Map(),
    findings: [],
  };
  // Plugins check a state right after it is announced, so the last action is the one that reached it.
  const checksOf = (e: Event, state: string) => {
    let group = tree.checks.get(state);
    if (group) return group;
    group = { state, seq: e.seq, at: e.at, inspections: [], findings: [], ...(prev ? { node: prev } : {}) };
    tree.checks.set(state, group);
    if (prev) tree.checksAfter.set(prev.event.seq, [...(tree.checksAfter.get(prev.event.seq) ?? []), group]);
    else tree.entryChecks.push(group);
    return group;
  };
  const owners = new Map<string, ActionNode | ActionTree['root']>();
  /** Revealed states announced ahead of their action, by that action's seq. */
  const revealedBy = new Map<number, string>();
  /** The state announced last: an inspection is of that state. */
  let announced: string | undefined;
  let prev: ActionNode | undefined,
    broken = false,
    pending: (JudgementEvent | NavigationEvent)[] = [];
  for (const [i, e] of events.entries()) {
    if (e.type === 'state') {
      announced = e.state.key;
      tree.screenshots.add(e.state.key);
      if (e.view) tree.views.set(e.state.key, e.view);
      // The next state announced after an action, before any other action, is where it led. A revealed
      // state announced right before an action (older runs) belongs to that action instead.
      const revealedNext = e.revealed === 'before' ? actionRevealing(events, i) : undefined;
      if (revealedNext) revealedBy.set(revealedNext, e.state.key);
      else if (prev && !broken && !tree.shotAfter.has(prev.event.seq)) tree.shotAfter.set(prev.event.seq, e.state.key);
      if (!tree.root.state && !tree.actions.length) {
        tree.root.state = e.state.key;
        owners.set(e.state.key, tree.root);
      }
    } else if (e.type === 'checks') {
      for (const c of e.checks) tree.checkNames.set(`${e.plugin}/${c.id}`, c);
    } else if (e.type === 'sweep') {
      if (announced) checksOf(e, announced).sweep = e;
    } else if (e.type === 'inspection') {
      if (announced) checksOf(e, announced).inspections.push(e);
      for (const [code, text] of Object.entries(e.reasons ?? {})) tree.reasons.set(`${e.plugin}/${code}`, text);
    } else if (e.type === 'finding' || e.type === 'plugin_error') {
      if (e.type === 'finding') tree.findings.push(e);
      // Findings that resolved at the end of the crawl belong to no state.
      if (e.state) checksOf(e, e.state).findings.push(e);
    } else if (e.type === 'judgement' || e.type === 'navigation') pending.push(e);
    else if (e.type === 'backtrack') {
      (prev ?? tree.root).backtracks.push(e);
      broken = true;
    } else if (e.type === 'action') {
      const before = e.step.state;
      if (before && !tree.root.state) {
        tree.root.state = before;
        owners.set(before, tree.root);
      }
      // Without a backtrack in between, this action was taken where the previous one led.
      if (prev && !broken && before) {
        prev.after = before;
        if (before !== prev.before) {
          const owner = owners.get(before);
          if (!owner) owners.set(before, prev);
          else {
            prev.returned = true;
            prev.returnedTo = owner === tree.root ? 'entry' : (owner as ActionNode);
          }
        }
      }
      const parent = (before && owners.get(before)) || tree.root;
      const navigations = pending.filter((c): c is NavigationEvent => c.type === 'navigation');
      if (prev && broken && prev.backtracks.length)
        prev.resumedAt = parent === tree.root ? 'entry' : (parent as ActionNode);
      const node: ActionNode = {
        event: e,
        index: tree.actions.length + 1,
        ...(parent !== tree.root ? { parent: parent as ActionNode } : {}),
        children: [],
        before,
        returned: false,
        context: pending.filter(c => c.type === 'judgement'),
        // A navigation the action set off carries the action's label; the rest were read from hrefs.
        triggered: navigations.filter(n => n.action === e.step.label),
        linksSeen: navigations.filter(n => n.action !== e.step.label),
        backtracks: [],
      };
      parent.children.push(node);
      tree.nodes.set(e.seq, node);
      const early = revealedBy.get(e.seq);
      if (early) tree.shotAfter.set(e.seq, early);
      tree.actions.push(node);
      pending = [];
      prev = node;
      broken = false;
    }
  }
  tree.tail = pending.filter((c): c is JudgementEvent => c.type === 'judgement');
  return tree;
}

/** A problem shown on a state: new there, or reported earlier and seen again, with where it is now. */
export interface StateFinding {
  event: FindingEvent;
  /** Reported on an earlier state. */
  earlier: boolean;
  target?: FindingEvent['finding']['target'];
  /** Its number on the screenshot. */
  n: number;
}

/** Problems on a state in screenshot order: new ones, then those seen again. */
export function stateFindings(tree: ActionTree, group: StateChecks): StateFinding[] {
  const out: Omit<StateFinding, 'n'>[] = group.findings
    .filter((f): f is FindingEvent => f.type === 'finding')
    .map(event => ({ event, earlier: false, target: event.finding.target }));
  for (const i of group.inspections)
    for (const { finding, target } of i.repeated ?? []) {
      const event = tree.findings[finding];
      if (event) out.push({ event, earlier: true, target });
    }
  return out.map((f, i) => ({ ...f, n: i + 1 }));
}

/** Actions from the entry page to this one: how to reach it by hand. */
export function pathTo(node: ActionNode): ActionNode[] {
  const path: ActionNode[] = [];
  for (let n: ActionNode | undefined = node; n; n = n.parent) path.unshift(n);
  return path;
}

/** The last action before an event: plugins check a state right after the action that reached it. */
export function actionBefore(tree: ActionTree, seq: number): ActionNode | undefined {
  let found: ActionNode | undefined;
  for (const node of tree.actions) {
    if (node.event.seq > seq) break;
    found = node;
  }
  return found;
}

/** A model question shown in the tree: a recorded call, or for runs without a call log, the judgement. */
export type ModelStep =
  /** `verdict`: for a question about one action, what the crawler concluded from the answer. */
  { kind: 'call'; call: ModelCallSummary; verdict?: JudgementEvent } | { kind: 'judgement'; event: JudgementEvent };
export interface ModelSteps {
  /** Asked in the state an action was taken in, while choosing it (worth clicking, same-kind list). */
  before: Map<number, ModelStep[]>;
  /** Asked about the action itself, after it ran or while typing (new content, input type). */
  during: Map<number, ModelStep[]>;
  /** Asked after the last action. */
  after: ModelStep[];
}

/** Questions about what an action did, rather than which action to take. */
const aboutAction = (kinds: string[]) => kinds.every(k => k === 'effect' || k === 'input-kind');

/**
 * The action a model call served and how. A call is matched to the first action recorded after it
 * starts; an action's record is written once it has finished, so questions about the action itself
 * (its effect, the input's type) were asked while it ran, the rest while choosing it.
 */
export function callTarget(
  tree: ActionTree,
  call: Pick<ModelCallSummary, 'at' | 'purpose'>,
): { node: ActionNode; relation: 'choosing' | 'effect' | 'input' } | undefined {
  const node = tree.actions.find(n => n.event.at >= call.at);
  if (!node) return;
  const kinds = call.purpose.replace(/^crawler-/, '').split('+');
  if (!aboutAction(kinds)) return { node, relation: 'choosing' };
  return { node, relation: kinds.includes('effect') ? 'effect' : 'input' };
}

/**
 * Places model questions on the tree. Calls are matched to the next action by time; without a
 * call log (older runs), the judgements recorded before each action are used instead.
 */
export function modelSteps(tree: ActionTree, calls: ModelCallSummary[]): ModelSteps {
  const steps: ModelSteps = { before: new Map(), during: new Map(), after: [] };
  const add = (node: ActionNode | undefined, step: ModelStep, kinds: string[]) => {
    if (!node) return void steps.after.push(step);
    const map = aboutAction(kinds) ? steps.during : steps.before;
    map.set(node.event.seq, [...(map.get(node.event.seq) ?? []), step]);
  };
  if (calls.length) {
    for (const call of calls) {
      const target = callTarget(tree, call);
      // An effect call asks about one action; its judgement, recorded just before the action, is the verdict.
      const verdict =
        target?.relation === 'effect'
          ? target.node.context.findLast(c => c.type === 'judgement' && c.question === 'effect')
          : undefined;
      add(
        target?.node,
        { kind: 'call', call, ...(verdict?.type === 'judgement' ? { verdict } : {}) },
        call.purpose.replace(/^crawler-/, '').split('+'),
      );
    }
    return steps;
  }
  for (const node of [...tree.actions, undefined]) {
    const judgements = node ? node.context : tree.tail;
    for (const event of judgements)
      if (event.type === 'judgement' && (event.source === 'jev' || event.source === 'llm' || event.source === 'none'))
        add(node, { kind: 'judgement', event }, [event.question]);
  }
  return steps;
}

/**
 * Where the operated control sits in a state's screenshot: its box when the action ran, but only
 * when the screenshot was taken at the same scroll position and viewport. Shifting by the scroll
 * difference is not reliable: sticky and fixed parts of a page (a calculator card, a header) do not
 * move with it, so the box would land on something else.
 */
export function markIn(target: (ScreenView & { box: Box }) | undefined, view: ScreenView | undefined) {
  if (!target || !view) return;
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;
  if (!near(target.scroll.x, view.scroll.x) || !near(target.scroll.y, view.scroll.y)) return;
  if (target.viewport.width !== view.viewport.width || target.viewport.height !== view.viewport.height) return;
  const { box } = target;
  if (
    box.x + box.width <= 0 ||
    box.y + box.height <= 0 ||
    box.x >= view.viewport.width ||
    box.y >= view.viewport.height
  )
    return;
  return { box, viewport: view.viewport };
}

/** The action right after a revealed state at `i` in an older run (plugin results may sit between). */
function actionRevealing(events: Event[], i: number): number | undefined {
  for (const e of events.slice(i + 1)) {
    if (e.type === 'action') return e.seq;
    if (!['finding', 'plugin_error', 'inspection', 'sweep', 'judgement'].includes(e.type)) return;
  }
}
