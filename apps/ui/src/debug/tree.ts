import type { ActionEvent, BacktrackEvent, Event, JudgementEvent, ModelCallSummary, NavigationEvent } from './types.js';

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
  /** Judgements after the last action. */
  tail: JudgementEvent[];
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
    tail: [],
  };
  const owners = new Map<string, ActionNode | ActionTree['root']>();
  let prev: ActionNode | undefined,
    broken = false,
    pending: (JudgementEvent | NavigationEvent)[] = [];
  for (const e of events) {
    if (e.type === 'state') {
      tree.screenshots.add(e.state.key);
      if (!tree.root.state && !tree.actions.length) {
        tree.root.state = e.state.key;
        owners.set(e.state.key, tree.root);
      }
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
      tree.actions.push(node);
      pending = [];
      prev = node;
      broken = false;
    }
  }
  tree.tail = pending.filter((c): c is JudgementEvent => c.type === 'judgement');
  return tree;
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
