import { useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { ChevronDown, ChevronRight, CornerDownLeft, CircleX, Info, ShieldCheck, Sparkles, Undo2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ChecksDetail, ChecksLink, ChecksRowBody, hasProblems } from './ChecksView.js';
import { Empty, Hint, InfoTip, Kind, Screenshot, Section, Time } from './common.js';
import { ModelCallDetail } from './ModelCallsView.js';
import {
  backtrackText,
  providerClass,
  purposeKinds,
  seconds,
  usd,
  kindText,
  navigationText,
  outcomeText,
  pluginText,
  questionText,
  severityText,
  inputKindText,
  sourceText,
  tierText,
  verdictLabel,
  verdictMeaning,
  verdictText,
} from './text.js';
import {
  type ActionNode,
  type ActionTree,
  type ModelStep,
  type ModelSteps,
  type StateChecks,
  markIn,
  modelSteps,
  pathTo,
} from './tree.js';
import type { Event, FindingEvent, JudgementEvent, ModelCallSummary, PluginErrorEvent } from './types.js';

type Row =
  | { type: 'action'; node: ActionNode; depth: number }
  /** The walk ended after this action and went back; shown as its own line. */
  | { type: 'backtrack'; node: ActionNode; depth: number }
  /** A question put to JEV / LLM, at the place in the walk where it was asked. */
  | { type: 'model'; step: ModelStep; depth: number; key: string }
  /** What plugins checked on the state an action reached (or the entry page). */
  | { type: 'checks'; group: StateChecks; depth: number };

/** What the right side shows besides an action: a state's checks or one model call. */
export type TreeDetail = { kind: 'checks'; state: string } | { kind: 'call'; id: number };

/** Deeper levels stop indenting so long walks stay readable; the level is still shown. */
const maxIndent = 12;

/**
 * Rows in tree order: every action sits one level under the action that reached the state it
 * was taken in. Siblings are different actions tried from the same state.
 */
function rows(tree: ActionTree, collapsed: Set<number>, models: ModelSteps, hidePassed: boolean): Row[] {
  const out: Row[] = [];
  const checked = (groups: StateChecks[] | undefined, depth: number) => {
    for (const group of groups ?? []) if (!hidePassed || hasProblems(group)) out.push({ type: 'checks', group, depth });
  };
  checked(tree.entryChecks, 0);
  const asked = (list: ModelStep[] | undefined, depth: number) => {
    for (const step of list ?? [])
      out.push({
        type: 'model',
        step,
        depth,
        key: step.kind === 'call' ? `call:${step.call.id}` : `judgement:${step.event.seq}`,
      });
  };
  const stack: { node: ActionNode; depth: number }[] = [...tree.root.children]
    .reverse()
    .map(node => ({ node, depth: 0 }));
  while (stack.length) {
    const { node, depth } = stack.pop() as { node: ActionNode; depth: number };
    asked(models.before.get(node.event.seq), depth);
    out.push({ type: 'action', node, depth });
    asked(models.during.get(node.event.seq), depth + 1);
    checked(tree.checksAfter.get(node.event.seq), depth + 1);
    if (node.backtracks.length) out.push({ type: 'backtrack', node, depth });
    if (collapsed.has(node.event.seq)) continue;
    for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], depth: depth + 1 });
  }
  asked(models.after, 0);
  return out;
}

const indent = (depth: number) => 12 + Math.min(depth, maxIndent) * 14;
/** One question to JEV / LLM in the walk; a recorded call opens its input and output. */
function ModelStepRow({
  step,
  depth,
  selected,
  onOpenCall,
}: {
  step: ModelStep;
  depth: number;
  selected: boolean;
  onOpenCall: (id: number) => void;
}) {
  const provider = step.kind === 'call' ? step.call.provider : step.event.source === 'llm' ? 'llm' : 'jev';
  const kinds = step.kind === 'call' ? purposeKinds(step.call.purpose) : [step.event.question];
  const reason = kinds.map(k => questionText[k]?.title ?? k).join(' + ');
  const body = (
    <>
      <Kind className={cn('px-1.5 py-0 text-[10px]', providerClass[provider])}>{provider.toUpperCase()}</Kind>
      <span className="shrink-0">{reason}</span>
      {step.kind === 'call' ? (
        <>
          {step.call.items > 1 && <span className="shrink-0">×{step.call.items}</span>}
          <span className="min-w-0 truncate">{step.call.subject}</span>
          <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 tabular-nums">
            {step.verdict && <VerdictBadge judgement={step.verdict} />}
            {step.call.error ? (
              <span className="text-destructive">{step.call.error}</span>
            ) : (
              <span>{step.call.costUsd === undefined ? '未计价' : usd(step.call.costUsd)}</span>
            )}
            <span>{seconds(step.call.ms)}</span>
            <Time ms={step.call.at} className="w-11 text-right" />
          </span>
        </>
      ) : (
        <>
          <span className="min-w-0 truncate">{step.event.label}</span>
          <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
            <VerdictBadge judgement={step.event} />
            <Time ms={step.event.at} className="w-11 text-right" />
          </span>
        </>
      )}
    </>
  );
  const className =
    'flex min-w-0 flex-1 items-center gap-1.5 py-0.5 pr-3 pl-1.5 text-left text-xs text-muted-foreground';
  return (
    <div
      className={cn('relative flex min-w-0 items-center hover:bg-accent/60', selected && 'bg-accent')}
      style={{ paddingLeft: `${indent(depth)}px` }}
    >
      <Guides depth={depth} />
      <span className="-ml-1 flex size-4 shrink-0 items-center justify-center">
        <Sparkles className="size-3 text-muted-foreground" />
      </span>
      {step.kind === 'call' ? (
        <button type="button" className={className} onClick={() => onOpenCall(step.call.id)}>
          {body}
        </button>
      ) : (
        <div className={className} title="没有逐次调用记录，只有判断结论">
          {body}
        </div>
      )}
    </div>
  );
}

/** A state's checks in one line; failing ones stand out, passing ones stay quiet. */
function ChecksRow({
  group,
  depth,
  selected,
  onOpen,
}: {
  group: StateChecks;
  depth: number;
  selected: boolean;
  onOpen: (state: string) => void;
}) {
  return (
    <div
      className={cn('relative flex min-w-0 items-center hover:bg-accent/60', selected && 'bg-accent')}
      style={{ paddingLeft: `${indent(depth) + 16}px` }}
    >
      <Guides depth={depth} />
      <button
        type="button"
        onClick={() => onOpen(group.state)}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1.5 py-0.5 pr-3 pl-1.5 text-left text-xs text-muted-foreground',
          !hasProblems(group) && 'opacity-70',
        )}
      >
        <ChecksRowBody group={group} />
      </button>
    </div>
  );
}

/** What the crawler concluded from a model answer; an unrelated effect shows how sure JEV was. */
function VerdictBadge({ judgement: j }: { judgement: JudgementEvent }) {
  const unrelated = j.verdict === 'no' && j.unrelated !== undefined && j.unrelated >= 0.5;
  const tip = unrelated
    ? `JEV 判断新出现的文字是页面自己加载或更新的（把握 ${(j.unrelated as number).toFixed(2)}），和这个动作无关，不算新状态。`
    : j.detail
      ? `${sourceText[j.source] ?? j.source}判定为「${inputKindText[j.detail] ?? j.detail}」，按这个类型填入样本值。`
      : `${verdictMeaning[j.question]?.[j.verdict] ?? verdictText[j.verdict]}${
          j.probability !== undefined ? `（概率 ${j.probability.toFixed(2)}）` : ''
        }`;
  return (
    <Hint tip={tip} className="no-underline">
      <Badge
        variant="outline"
        className={cn('px-1.5 py-0 text-[10px]', unrelated ? 'text-muted-foreground' : verdictClass[j.verdict])}
      >
        {verdictLabel(j)}
        {unrelated
          ? ` ${(j.unrelated as number).toFixed(2)}`
          : j.probability !== undefined && ` ${j.probability.toFixed(2)}`}
      </Badge>
    </Hint>
  );
}

/** Vertical lines for the levels a row is nested in. */
function Guides({ depth }: { depth: number }) {
  return Array.from({ length: Math.min(depth, maxIndent) }, (_, i) => (
    <span
      // biome-ignore lint/suspicious/noArrayIndexKey: one line per level, never reordered
      key={i}
      className="absolute top-0 bottom-0 border-l border-border"
      style={{ left: `${indent(i) + 2}px` }}
    />
  ));
}

const where = (to: ActionNode | 'entry' | undefined) => (to === 'entry' || !to ? '入口页' : `#${to.index} 之后`);

/** The list scrolls inside itself; the page around it keeps its place. */
const maxListHeight = typeof window === 'undefined' ? 600 : Math.round(window.innerHeight * 0.7);

const listPadding = { Header: () => <div className="h-1" />, Footer: () => <div className="h-1" /> };

const descendants = (node: ActionNode): number => node.children.reduce((n, c) => n + 1 + descendants(c), 0);

export function ActionTreeView({
  runId,
  tree,
  events,
  calls,
  selected,
  detail,
  focus,
  onSelect,
  onDetail,
}: {
  runId: string;
  tree: ActionTree;
  events: Event[];
  calls: ModelCallSummary[];
  selected?: number;
  /** Shown on the right instead of the selected action. */
  detail?: TreeDetail;
  /** Changes on every jump from outside the tree (a failure, a finding, a model call). */
  focus?: number;
  onSelect: (seq: number) => void;
  onDetail: (detail: TreeDetail) => void;
}) {
  const [collapsed, setCollapsed] = useState(new Set<number>());
  const [hidePassed, setHidePassed] = useState(() => {
    try {
      return localStorage.getItem('debug.hidePassedChecks') === '1';
    } catch {
      return false;
    }
  });
  const toggleHidePassed = () =>
    setHidePassed(prev => {
      try {
        localStorage.setItem('debug.hidePassedChecks', prev ? '0' : '1');
      } catch {}
      return !prev;
    });
  const models = useMemo(() => modelSteps(tree, calls), [tree, calls]);
  const list = useMemo(() => rows(tree, collapsed, models, hidePassed), [tree, collapsed, models, hidePassed]);
  const checks = detail?.kind === 'checks' ? tree.checks.get(detail.state) : undefined;
  const openChecks = (state: string) => onDetail({ kind: 'checks', state });
  const node = selected === undefined ? undefined : tree.nodes.get(selected);
  const virtuoso = useRef<VirtuosoHandle>(null);
  // Bring an action chosen elsewhere (a finding, a model call) into view; only rendered rows exist.
  // A collapsed ancestor hides the row: open the branch, then scroll once the row is rendered.
  const rowOf = (seq?: number) => list.findIndex(r => r.type === 'action' && r.node.event.seq === seq);
  // Coming from another tab mounts the tree afresh: it opens on the selected row instead of scrolling.
  const [initial] = useState(() => Math.max(0, rowOf(selected)));
  const mounted = useRef(false);
  const reveal = useRef<number>(undefined);
  const scrollTo = (seq: number) => {
    const index = rowOf(seq);
    if (index >= 0) virtuoso.current?.scrollIntoView({ index, behavior: 'auto' });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on a jump, not on every new row
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (!node) return;
    const hidden = new Set(
      pathTo(node)
        .map(n => n.event.seq)
        .filter(seq => seq !== selected && collapsed.has(seq)),
    );
    if (!hidden.size) return scrollTo(node.event.seq);
    reveal.current = node.event.seq;
    setCollapsed(prev => new Set([...prev].filter(seq => !hidden.has(seq))));
  }, [selected, focus]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls once the opened branch is rendered
  useEffect(() => {
    if (reveal.current === undefined) return;
    scrollTo(reveal.current);
    reveal.current = undefined;
  }, [list]);

  // Model calls, findings and plugin errors between this action and the next one.
  const next = node && tree.actions[node.index];
  const between = (at: number, seq?: number) =>
    node &&
    (seq === undefined ? at >= node.event.at : seq > node.event.seq) &&
    (!next || (seq === undefined ? at < next.event.at : seq < next.event.seq));
  const findings = node
    ? events.filter(
        (e): e is FindingEvent | PluginErrorEvent =>
          (e.type === 'finding' || e.type === 'plugin_error') && !!between(e.at, e.seq),
      )
    : [];

  if (!tree.actions.length && !list.length) return <Empty>还没有动作。</Empty>;
  const toggle = (seq: number) =>
    setCollapsed(prev => {
      const next = new Set(prev);
      if (!next.delete(seq)) next.add(seq);
      return next;
    });

  return (
    <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="min-w-0 overflow-hidden rounded-lg border">
        <Virtuoso
          ref={virtuoso}
          initialTopMostItemIndex={{ index: initial, align: 'center' }}
          data={list}
          computeItemKey={(_, row) =>
            row.type === 'model'
              ? row.key
              : row.type === 'checks'
                ? `checks:${row.group.state}`
                : `${row.type}:${row.node.event.seq}`
          }
          style={{ height: Math.min(list.length * 30 + 8, maxListHeight) }}
          components={listPadding}
          itemContent={(_, row) => {
            if (row.type === 'model')
              return (
                <ModelStepRow
                  step={row.step}
                  depth={row.depth}
                  selected={row.step.kind === 'call' && detail?.kind === 'call' && detail.id === row.step.call.id}
                  onOpenCall={id => onDetail({ kind: 'call', id })}
                />
              );
            if (row.type === 'checks')
              return (
                <ChecksRow group={row.group} depth={row.depth} selected={checks === row.group} onOpen={openChecks} />
              );
            const { node: n, depth } = row;
            const e = n.event;
            if (row.type === 'backtrack')
              return (
                <div
                  className="relative flex items-center gap-1.5 py-0.5 pr-3 text-xs text-warning"
                  style={{ paddingLeft: `${indent(depth) + 20}px` }}
                >
                  <Guides depth={depth} />
                  <Undo2 className="size-3.5 shrink-0" />
                  <span className="truncate">
                    到头，回溯{n.resumedAt ? `到${where(n.resumedAt)}继续` : '，遍历结束'}
                  </span>
                </div>
              );
            const isSelected = selected === e.seq && !detail;
            const hasChildren = n.children.length > 0;
            return (
              <div
                className={cn('relative flex min-w-0 items-center hover:bg-accent', isSelected && 'bg-accent')}
                style={{ paddingLeft: `${indent(depth)}px` }}
              >
                <Guides depth={depth} />
                {hasChildren ? (
                  <button
                    type="button"
                    aria-label={collapsed.has(e.seq) ? '展开' : '收起'}
                    onClick={() => toggle(e.seq)}
                    className="-ml-1 flex size-4 shrink-0 items-center justify-center rounded hover:bg-muted"
                  >
                    {collapsed.has(e.seq) ? (
                      <ChevronRight className="size-3.5" />
                    ) : (
                      <ChevronDown className="size-3.5" />
                    )}
                  </button>
                ) : (
                  <span className="flex size-4 shrink-0 items-center justify-center -ml-1">
                    <span className={cn('size-1.5 rounded-full', outcomeDot[e.outcome])} />
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onSelect(e.seq)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-3 pl-1.5 text-left text-sm"
                >
                  <span className="w-8 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">#{n.index}</span>
                  {depth > maxIndent && (
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">L{depth + 1}</span>
                  )}
                  <Kind className="px-1.5 py-0 text-[11px]">{kindText[e.step.kind] ?? e.step.kind}</Kind>
                  <span className={cn('min-w-0 truncate', e.outcome === 'failed' && 'text-destructive')}>
                    {e.step.label || '未命名'}
                  </span>
                  {e.step.retry && (
                    <Badge
                      variant="outline"
                      className="shrink-0 border-warning/40 px-1.5 py-0 text-[10px] text-warning"
                    >
                      retry
                    </Badge>
                  )}
                  {e.step.value && (
                    <code className="max-w-24 shrink-0 truncate rounded bg-muted px-1 font-mono text-xs">
                      {e.step.value}
                    </code>
                  )}
                  <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-muted-foreground">
                    {n.returned && (
                      <span className="flex items-center gap-0.5 text-xs">
                        <CornerDownLeft className="size-3" />
                        回到{where(n.returnedTo)}
                      </span>
                    )}
                    {e.newState && <span className="text-xs text-success">新</span>}
                    {e.outcome === 'failed' && <CircleX className="size-3.5 text-destructive" />}
                    {collapsed.has(e.seq) && <span className="text-xs">+{descendants(n)}</span>}
                    <Time ms={e.at} className="w-11 text-right" />
                  </span>
                </button>
              </div>
            );
          }}
        />
        <Legend hasChecks={tree.checks.size > 0} hidePassed={hidePassed} onToggleHidePassed={toggleHidePassed} />
      </div>

      <div className="min-w-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
        {detail?.kind === 'call' ? (
          <div className="rounded-lg border bg-card p-4">
            <ModelCallDetail runId={runId} id={detail.id} tree={tree} onSelectAction={onSelect} />
          </div>
        ) : checks ? (
          <ChecksDetail runId={runId} tree={tree} group={checks} onSelect={onSelect} />
        ) : node ? (
          <ActionDetail
            runId={runId}
            tree={tree}
            node={node}
            findings={findings}
            onSelect={onSelect}
            onOpenChecks={openChecks}
          />
        ) : (
          <div className="rounded-lg border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
            选一个动作，看它的结果、到达路径、截图和模型判断。
          </div>
        )}
      </div>
    </div>
  );
}

const outcomeDot: Record<string, string> = {
  ok: 'bg-success',
  no_change: 'bg-muted-foreground/40',
  failed: 'bg-destructive',
};

function Legend({
  hasChecks,
  hidePassed,
  onToggleHidePassed,
}: {
  hasChecks: boolean;
  hidePassed: boolean;
  onToggleHidePassed: () => void;
}) {
  return (
    <div className="sticky bottom-0 flex flex-wrap items-center gap-x-3 gap-y-1 border-t bg-card px-3 py-1.5 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1">
        <span className="size-1.5 rounded-full bg-success" />
        有变化
      </span>
      <span className="flex items-center gap-1">
        <span className="size-1.5 rounded-full bg-muted-foreground/40" />
        无变化
      </span>
      <span className="flex items-center gap-1">
        <Sparkles className="size-3" />
        <Hint
          tip={
            <>
              在动作<b>上方</b>、与它同一层的：为了选这个动作而问的（值不值得点、列表是否同类）。
              <br />
              在动作<b>下方</b>、缩进一层的：执行这个动作时问的（算不算新内容、输入框类型）。
              <br />
              点开可以看问了什么、模型怎么答、爬虫据此做了什么。
            </>
          }
        >
          问模型
        </Hint>
      </span>
      <span className="flex items-center gap-1">
        <CornerDownLeft className="size-3" />
        回到已有状态
      </span>
      <span className="flex items-center gap-1">
        <Undo2 className="size-3 text-warning" />
        到头回溯
      </span>
      {hasChecks && (
        <span className="flex items-center gap-1">
          <ShieldCheck className="size-3" />
          <Hint tip="插件在动作到达的新状态上做的检查，缩进在那个动作下面。点开看每条规则的结论和耗时。">检查</Hint>
          <button
            type="button"
            onClick={onToggleHidePassed}
            className={cn('rounded px-1 hover:bg-muted', hidePassed && 'bg-muted text-foreground')}
            aria-pressed={hidePassed}
          >
            {hidePassed ? '显示全部' : '只看有问题的'}
          </button>
        </span>
      )}
      <Hint
        className="ml-auto flex items-center gap-1"
        tip={
          <>
            一个动作缩进在谁下面，表示它是在<b>那个动作执行后的页面</b>上做的。
            <br />
            往下一层：在新出现的页面状态上继续操作。
            <br />
            同一层：从同一个页面状态出发，依次试的不同动作。
            <br />
            没有改变页面的动作（如输入、没有带出新内容的点击）不产生新状态，下一个动作和它同层，而不是挂在它下面，所以一个动作下面常常排着很多子动作。
          </>
        }
      >
        <Info className="size-3" />
        怎么读这棵树
      </Hint>
    </div>
  );
}

function ActionDetail({
  runId,
  tree,
  node,
  findings,
  onSelect,
  onOpenChecks,
}: {
  runId: string;
  tree: ActionTree;
  node: ActionNode;
  findings: (FindingEvent | PluginErrorEvent)[];
  onSelect: (seq: number) => void;
  onOpenChecks: (state: string) => void;
}) {
  const checks = tree.checksAfter.get(node.event.seq);
  const e = node.event;
  const path = pathTo(node);
  // Prefer the screenshot taken right after this action; otherwise the state it led to, taken earlier.
  const fresh = tree.shotAfter.get(e.seq);
  const shot = fresh ?? (node.after && tree.screenshots.has(node.after) ? node.after : undefined);
  const stateShot = node.before && tree.screenshots.has(node.before) ? node.before : undefined;
  // Two pictures only when the action led to another state; otherwise the one it happened on.
  const changed = !!(shot && stateShot && shot !== stateShot) || !!(fresh && !stateShot);
  // A screenshot taken at the moment of the action shows the page exactly as it was acted on.
  const momentShot = e.shot;
  const beforeShot = momentShot ?? stateShot;
  // The operated control, on whichever picture was taken where the action happened.
  const markBefore =
    momentShot && e.target ? e.target : markIn(e.target, tree.views.get((beforeShot ?? shot) as string));
  const markAfter = changed && shot ? markIn(e.target, tree.views.get(shot)) : undefined;
  return (
    <div className="flex flex-col gap-4 rounded-lg border bg-card p-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">#{node.index}</span>
          <Kind>{kindText[e.step.kind] ?? e.step.kind}</Kind>
          <span className="font-medium break-all">{e.step.label || '未命名'}</span>
          {e.step.value && <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{e.step.value}</code>}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <Badge
            variant="outline"
            className={cn(
              e.outcome === 'failed' && 'border-destructive/30 text-destructive',
              e.outcome === 'ok' && 'border-success/30 text-success',
            )}
          >
            {outcomeText[e.outcome] ?? e.outcome}
          </Badge>
          {e.newState && <span className="text-success">到达新状态</span>}
          {node.returned && (
            <span>
              回到
              {node.returnedTo === 'entry' || !node.returnedTo ? (
                '入口页'
              ) : (
                <button
                  type="button"
                  className="underline-offset-4 hover:underline"
                  onClick={() => node.returnedTo !== 'entry' && node.returnedTo && onSelect(node.returnedTo.event.seq)}
                >
                  #{node.returnedTo.index} 之后
                </button>
              )}
              的状态
            </span>
          )}
          <Hint tip="动作的优先级层：弹层内的先测，页头页脚、跳转类的后测。">{tierText[e.tier] ?? e.tier}</Hint>
          {e.overlay && <span className="break-all">在 {e.overlay}</span>}
          {e.step.purpose && <span>样本：{e.step.purpose}</span>}
          <Time ms={e.at} />
        </div>
        {e.error && <p className="text-xs break-all text-destructive">{e.error}</p>}
        {(() => {
          const tries = tree.actions.filter(a => a.event.step.classKey === e.step.classKey && a !== node);
          const first = e.step.retry ? tries.find(a => a.event.seq < e.seq) : undefined;
          const retry =
            !e.step.retry && /covered by/.test(e.error ?? '') ? tries.find(a => a.event.step.retry) : undefined;
          if (first)
            return (
              <p className="text-xs text-muted-foreground">
                重试：第一次在{' '}
                <button
                  type="button"
                  className="underline-offset-4 hover:underline"
                  onClick={() => onSelect(first.event.seq)}
                >
                  #{first.index}
                </button>{' '}
                被遮挡，放到最后、换一个状态再试一次{e.outcome === 'failed' ? '，仍然失败，不再尝试' : ''}。
              </p>
            );
          if (retry)
            return (
              <p className="text-xs text-muted-foreground">
                被遮挡，之后在{' '}
                <button
                  type="button"
                  className="underline-offset-4 hover:underline"
                  onClick={() => onSelect(retry.event.seq)}
                >
                  #{retry.index}
                </button>{' '}
                重试{retry.event.outcome === 'failed' ? '，仍然失败' : '成功'}。
              </p>
            );
          if (/covered by/.test(e.error ?? ''))
            return (
              <p className="text-xs text-muted-foreground">
                被遮挡：会放到最后、换一个状态再试一次；这次运行没来得及重试。
              </p>
            );
        })()}
      </div>

      <Section
        title={`到达路径（${path.length} 步）`}
        aside={<InfoTip>从入口页开始，按顺序做这些动作就能回到这一步。复现问题时照着走即可。</InfoTip>}
      >
        <ol className="flex flex-wrap items-center gap-1 text-xs">
          <li className="text-muted-foreground">入口页</li>
          {path.map(p => (
            <li key={p.event.seq} className="flex items-center gap-1">
              <ChevronRight className="size-3 text-muted-foreground" />
              <button
                type="button"
                onClick={() => onSelect(p.event.seq)}
                className={cn(
                  'max-w-48 truncate rounded px-1 py-0.5 hover:bg-accent',
                  p === node ? 'font-medium' : 'text-muted-foreground',
                )}
              >
                {kindText[p.event.step.kind] ?? p.event.step.kind} {p.event.step.label || '未命名'}
              </button>
            </li>
          ))}
        </ol>
      </Section>

      {(shot || beforeShot) && (
        <Section
          title={changed ? '动作前后' : '动作所在的状态'}
          aside={
            <InfoTip>
              红框是这一步操作的控件，画在"之前"那张图上，也就是操作发生的画面。每个状态只在第一次出现时截一张图，所以"之前"是这个状态第一次出现时的样子，不一定是操作前一刻。
            </InfoTip>
          }
        >
          {!markBefore && !markAfter && (
            <p className="text-xs text-muted-foreground">
              {e.target
                ? '这次运行没有保存操作那一刻的截图（较早的运行），现有截图拍摄时页面滚动位置不同，无法定位控件，所以没有画框。'
                : '没有记录控件的位置（较早的运行，或操作前就失败了），所以没有画框。'}
            </p>
          )}
          {!changed && (
            <p className="text-xs text-muted-foreground">
              {e.outcome === 'failed'
                ? '操作失败'
                : e.outcome === 'no_change'
                  ? '操作后页面没有变化'
                  : '操作后回到了这个状态'}
              ，所以只有一张图。
            </p>
          )}
          <div className={cn('grid gap-2', changed && 'grid-cols-2')}>
            {(beforeShot ?? shot) && (
              <figure className="flex min-w-0 flex-col gap-1">
                {changed && <figcaption className="text-[11px] text-muted-foreground">之前</figcaption>}
                <Screenshot
                  key={beforeShot ?? shot}
                  runId={runId}
                  state={(beforeShot ?? shot) as string}
                  label={`#${node.index} ${kindText[e.step.kind] ?? e.step.kind} ${e.step.label || '未命名'}`}
                  mark={markBefore}
                />
              </figure>
            )}
            {changed && shot && (
              <figure className="flex min-w-0 flex-col gap-1">
                <figcaption className="text-[11px] text-muted-foreground">之后</figcaption>
                <Screenshot
                  key={shot}
                  runId={runId}
                  state={shot}
                  label={`#${node.index} 之后`}
                  // The before picture is where the outline belongs; this one only when that one cannot have it.
                  mark={markBefore ? undefined : markAfter}
                />
              </figure>
            )}
          </div>
        </Section>
      )}

      {node.triggered.length > 0 && (
        <Section title="这一步触发的跳转">
          <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
            {node.triggered.map(n => (
              <li key={n.seq} className="break-all">
                {navigationText[n.outcome] ?? n.outcome} → {n.to}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {node.linksSeen.length > 0 && (
        <details className="text-xs">
          <summary className="flex cursor-pointer items-center gap-1.5 text-muted-foreground">
            选择这一步前，在页面上读到 {node.linksSeen.length} 个指向别处的链接
            <InfoTip>
              只测当前页：指向其他页面的链接不点击，直接从 href
              记下目的地。它们出现在新状态里（比如打开了一个列表），和这一步本身无关。每个目的地只记一次。
            </InfoTip>
          </summary>
          <ul className="mt-1.5 flex max-h-48 flex-col gap-1 overflow-y-auto pl-4 text-muted-foreground">
            {node.linksSeen.map(n => (
              <li key={n.seq} className="break-all">
                {n.action || '未命名'} → {n.to}
              </li>
            ))}
          </ul>
        </details>
      )}

      {checks && (
        <Section title="新状态上的检查">
          <ChecksLink groups={checks} onOpen={onOpenChecks} />
        </Section>
      )}

      {findings.length > 0 && (
        <Section title="在这一步之后的状态上发现">
          <ul className="flex flex-col gap-1.5 text-xs">
            {findings.map(f => (
              <li key={f.seq} className="flex min-w-0 flex-wrap items-center gap-2">
                <Kind>{pluginText[f.plugin] ?? f.plugin}</Kind>
                {f.type === 'finding' ? (
                  <>
                    <Badge variant="outline">
                      {severityText[f.finding.severity]} · {f.finding.rule}
                    </Badge>
                    <span className="min-w-0 truncate text-muted-foreground">
                      {f.finding.text || f.finding.selector}
                    </span>
                  </>
                ) : (
                  <span className="break-all text-destructive">插件出错：{f.error}</span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {node.backtracks.length > 0 && (
        <Section title="之后">
          <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
            {node.backtracks.map(b => (
              <li key={b.seq} className="flex items-center gap-1.5">
                <Undo2 className="size-3.5 text-warning" />
                {backtrackText[b.reason] ?? b.reason}
              </li>
            ))}
            <li className="pl-5">
              {node.resumedAt ? `回到${where(node.resumedAt)}的状态继续` : '之后没有动作，遍历结束'}
            </li>
          </ul>
        </Section>
      )}

      {node.children.length > 0 && (
        <Section title="从这里继续">
          <div className="flex flex-wrap gap-1">
            {node.children.map(c => (
              <Button
                key={c.event.seq}
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => onSelect(c.event.seq)}
              >
                #{c.index} {kindText[c.event.step.kind] ?? c.event.step.kind}{' '}
                {c.event.step.label.slice(0, 24) || '未命名'}
              </Button>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

export const verdictClass: Record<string, string> = {
  yes: 'border-success/30 text-success',
  no: 'border-destructive/30 text-destructive',
  uncertain: 'text-muted-foreground',
};
