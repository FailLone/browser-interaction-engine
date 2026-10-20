import type React from 'react';
import { Fragment, forwardRef, useEffect, useMemo, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { ChevronRight, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { Disclosure, Empty, InfoTip, Json, Kind, Section, Time } from './common.js';
import {
  call,
  inputKindText,
  providerClass,
  purposeKinds,
  questionText,
  seconds,
  usd,
  verdictMeaning,
  verdictText,
} from './text.js';
import type { ActionTree } from './tree.js';
import { callTarget } from './tree.js';
import type { ModelCall, ModelCallSummary } from './types.js';

/** How a call relates to its action, matching where the action tree places it. */
const relationText: Record<'choosing' | 'effect' | 'input', (action: string) => string> = {
  choosing: a => `为选择下一个动作而问，之后执行了 ${a}`,
  effect: a => `${a} 执行之后，判断它的效果`,
  input: a => `${a} 输入之前，判断输入框类型`,
};
const relationShort: Record<'choosing' | 'effect' | 'input', string> = { choosing: '→', effect: '←', input: '→' };

const reasonOf = (purpose: string) =>
  purposeKinds(purpose)
    .map(k => questionText[k]?.title ?? k)
    .join(' + ');

export function ModelCallRow({
  call: c,
  onOpen,
  action,
}: {
  call: ModelCallSummary;
  onOpen: () => void;
  action?: string;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent"
    >
      <Time ms={c.at} className="w-11" />
      <Kind className={cn('px-1.5 py-0', providerClass[c.provider])}>{c.provider.toUpperCase()}</Kind>
      <span className="shrink-0 font-medium">{reasonOf(c.purpose)}</span>
      {c.items > 1 && <span className="shrink-0 text-muted-foreground">×{c.items}</span>}
      <span className="min-w-0 truncate text-muted-foreground">{c.subject}</span>
      {action && <span className="hidden shrink-0 text-muted-foreground xl:inline">→ {action}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 tabular-nums">
        {c.error ? (
          <span className="text-destructive">{c.error}</span>
        ) : (
          <span className="text-muted-foreground">{c.costUsd === undefined ? '未计价' : usd(c.costUsd)}</span>
        )}
        <span className="w-10 text-right text-muted-foreground">{seconds(c.ms)}</span>
        <ChevronRight className="size-3.5 text-muted-foreground" />
      </span>
    </button>
  );
}

/** Rows are list items; Virtuoso renders only the visible ones. */
const CallList = forwardRef<HTMLUListElement, React.ComponentProps<'ul'>>(({ className, ...props }, ref) => (
  <ul ref={ref} className={cn('divide-y', className)} {...props} />
));

const CallItem = (props: React.ComponentProps<'li'>) => <li {...props} />;

/** Every model call of a run, with totals; the request and answer load when one is opened. */
export function ModelCallsView({
  calls,
  recorded,
  tree,
  onOpen,
  modelsEnabled,
}: {
  calls: ModelCallSummary[];
  recorded: boolean;
  tree: ActionTree;
  onOpen: (id: number) => void;
  modelsEnabled: boolean;
}) {
  const totals = useMemo(() => {
    const by = { jev: { n: 0, cost: 0, ms: 0 }, llm: { n: 0, cost: 0, ms: 0 } };
    for (const c of calls) {
      by[c.provider].n++;
      by[c.provider].cost += c.costUsd ?? 0;
      by[c.provider].ms += c.ms;
    }
    return by;
  }, [calls]);
  if (!calls.length)
    return (
      <Empty>
        {!modelsEnabled
          ? '这次运行没有使用模型。'
          : recorded
            ? '这次运行没有调用模型。'
            : '服务端没有开启模型调用记录。'}
        {modelsEnabled && recorded && (
          <span className="mt-1 block text-xs">在本功能上线前的运行没有逐次记录，只有汇总里的次数和费用。</span>
        )}
      </Empty>
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {(['jev', 'llm'] as const).map(p => (
          <span key={p}>
            <Kind className={cn('mr-1.5 px-1.5 py-0', providerClass[p])}>{p.toUpperCase()}</Kind>
            <span className="font-medium tabular-nums">
              {totals[p].n} 次 · {usd(totals[p].cost)} · {seconds(totals[p].ms)}
            </span>
          </span>
        ))}
      </div>
      <Virtuoso
        className="rounded-lg border"
        data={calls}
        computeItemKey={(_, c) => c.id}
        style={{ height: Math.min(calls.length * 33 + 2, Math.round(window.innerHeight * 0.7)) }}
        components={{ List: CallList, Item: CallItem }}
        itemContent={(_, c) => {
          const target = callTarget(tree, c);
          return (
            <ModelCallRow
              call={c}
              onOpen={() => onOpen(c.id)}
              action={
                target
                  ? `${relationShort[target.relation]} #${target.node.index} ${target.node.event.step.label.slice(0, 20)}`
                  : undefined
              }
            />
          );
        }}
      />
    </div>
  );
}

/** One call in a dialog, for the model calls list. */
export function ModelCallDialog({
  runId,
  id,
  tree,
  onClose,
  onSelectAction,
}: {
  runId: string;
  id?: number;
  tree: ActionTree;
  onClose: () => void;
  onSelectAction: (seq: number) => void;
}) {
  return (
    <Dialog open={id !== undefined} onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        {id !== undefined && (
          <ModelCallDetail
            runId={runId}
            id={id}
            tree={tree}
            onSelectAction={seq => {
              onSelectAction(seq);
              onClose();
            }}
            Title={DialogTitle}
            Description={DialogDescription}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

const PlainTitle = ({ className, children }: { className?: string; children: React.ReactNode }) => (
  <h2 className={cn('font-semibold', className)}>{children}</h2>
);
const PlainDescription = ({ children }: { asChild?: boolean; children: React.ReactNode }) => (
  <div className="text-sm text-muted-foreground">{children}</div>
);

/** One call's reason, input and output; fetched when shown. In a dialog it uses the dialog's title. */
export function ModelCallDetail({
  runId,
  id,
  tree,
  onSelectAction,
  Title = PlainTitle,
  Description = PlainDescription,
}: {
  runId: string;
  id: number;
  tree: ActionTree;
  onSelectAction: (seq: number) => void;
  Title?: React.ComponentType<{ className?: string; children: React.ReactNode }>;
  Description?: React.ComponentType<{ asChild?: boolean; children: React.ReactNode }>;
}) {
  const [detail, setDetail] = useState<ModelCall | { error: string }>();
  useEffect(() => {
    let live = true;
    setDetail(undefined);
    call<ModelCall>(`/v1/crawls/${runId}/debug/model-calls/${id}`)
      .then(d => live && setDetail(d))
      .catch(e => live && setDetail({ error: String((e as Error).message) }));
    return () => {
      live = false;
    };
  }, [runId, id]);
  const c = detail && 'request' in detail ? detail : undefined;
  const target = c && callTarget(tree, c);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Title className="flex items-center gap-2">
          {c ? (
            <>
              <Kind className={providerClass[c.provider]}>{c.provider.toUpperCase()}</Kind>
              {reasonOf(c.purpose)}
            </>
          ) : (
            '模型调用'
          )}
        </Title>
        {c && (
          <Description asChild>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>
                花费 <b className="text-foreground">{c.costUsd === undefined ? '未计价' : usd(c.costUsd)}</b>
              </span>
              <span>
                耗时 <b className="text-foreground">{seconds(c.ms)}</b>
              </span>
              {c.inputTokens !== undefined && (
                <span>
                  tokens {c.inputTokens} → {c.outputTokens ?? '?'}
                </span>
              )}
              <span className="font-mono text-xs">{c.model}</span>
              <span>
                第 <Time ms={c.at} /> 发起
              </span>
            </div>
          </Description>
        )}
      </div>
      {!detail ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : 'error' in detail ? (
        <p className="text-sm text-destructive">{detail.error}</p>
      ) : (
        c && (
          <div className="flex min-w-0 flex-col gap-4">
            <Section title="为什么调用">
              <ul className="flex flex-col gap-1 text-sm">
                {purposeKinds(c.purpose).map(k => (
                  <li key={k}>
                    <span className="font-medium">{questionText[k]?.title ?? k}</span>
                    <span className="text-muted-foreground">：{questionText[k]?.why ?? c.purpose}</span>
                  </li>
                ))}
              </ul>
              {target && (
                <button
                  type="button"
                  className="w-fit text-left text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  onClick={() => onSelectAction(target.node.event.seq)}
                >
                  {relationText[target.relation](
                    `#${target.node.index}「${target.node.event.step.label || '未命名'}」`,
                  )}{' '}
                  →
                </button>
              )}
            </Section>
            {c.error && (
              <Section title="调用失败">
                <p className="text-sm text-destructive">{c.error}</p>
              </Section>
            )}
            <Questions call={c} />
            <Disclosure summary="原始请求与输出（JSON）">
              <Json
                value={{
                  instructions: c.request.instructions || undefined,
                  state: c.request.state,
                  checks: c.request.checks,
                  options: c.request.options,
                  answer: c.answer,
                }}
                className="max-h-96"
              />
            </Disclosure>
          </div>
        )
      )}
    </div>
  );
}

type Verdict = 'yes' | 'no' | 'uncertain';

/** The crawler's reading of a checklist probability, per question kind (see judge.ts and goal.ts). */
function checklistVerdict(kind: string, p: number): Verdict {
  // Goal relevance only drops actions scored below 0.3; everything else stays eligible.
  if (kind === 'goal-relevance') return p >= 0.3 ? 'yes' : 'no';
  return p >= 0.75 ? 'yes' : p <= 0.25 ? 'no' : 'uncertain';
}
const thresholdText: Record<string, string> = {
  'goal-relevance': '概率 ≥ 0.30 判为相关并执行，低于 0.30 不执行。',
};
const verdictClass: Record<Verdict, string> = {
  yes: 'border-success/30 text-success',
  no: 'border-destructive/30 text-destructive',
  uncertain: 'text-muted-foreground',
};

/** A conclusion in plain words, colored by verdict, with the probability it came from. */
function Conclusion({ verdict, text, p }: { verdict: Verdict; text: string; p?: number }) {
  return (
    <span className="flex shrink-0 items-center gap-2">
      <span className={cn('text-xs', verdict === 'uncertain' ? 'text-muted-foreground' : verdictClass[verdict])}>
        {text}
      </span>
      <Badge variant="outline" className={cn('w-12 justify-center tabular-nums', verdictClass[verdict])}>
        {p === undefined ? '—' : p.toFixed(2)}
      </Badge>
    </span>
  );
}

/**
 * A JEV checklist answers each item separately. The question is the same for every item of a
 * kind, so it is shown once per group; each row gives the item, what the answer means for the
 * crawl, and its facts on demand.
 */
function Questions({ call: c }: { call: ModelCall }) {
  if (c.kind === 'choice' && c.request.options) return <Choice call={c} />;
  if (c.kind !== 'checklist' || !c.request.checks) return <Generated call={c} />;
  const values = (c.answer?.value ?? {}) as Record<string, unknown>;
  const state = (c.request.state ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const kinds = purposeKinds(c.purpose);
  // One box per question kind: a batch can mix "worth clicking" with "same-kind list".
  const groups = new Map<string, [string, { instructions: string }][]>();
  for (const entry of Object.entries(c.request.checks)) {
    const kind = String(state[entry[0]]?.kind ?? (kinds.length === 1 ? kinds[0] : ''));
    groups.set(kind, [...(groups.get(kind) ?? []), entry]);
  }
  return (
    <>
      {[...groups].map(([kind, checks]) => {
        const counts = { yes: 0, no: 0, uncertain: 0 };
        const rows = checks.map(([key, check]) => {
          const p = values[key];
          const verdict = typeof p === 'number' ? checklistVerdict(kind, p) : undefined;
          if (verdict) counts[verdict]++;
          return {
            key,
            check,
            p: typeof p === 'number' ? p : undefined,
            verdict,
            item: state[key],
          };
        });
        const meaning = verdictMeaning[kind] ?? {};
        return (
          <Section
            key={kind}
            title={`${questionText[kind]?.title ?? (kind || '逐项结果')}（${checks.length}）`}
            aside={<InfoTip>{thresholdText[kind] ?? 'JEV 概率 ≥ 0.75 判为是，≤ 0.25 判为否，中间为不确定。'}</InfoTip>}
          >
            <p className="text-xs text-muted-foreground">
              {(['yes', 'no', 'uncertain'] as const)
                .filter(v => counts[v])
                .map(v => `${counts[v]} 个${meaning[v] ?? verdictText[v]}`)
                .join('；')}
            </p>
            <ul className="flex max-h-96 flex-col divide-y overflow-y-auto rounded-md border text-sm">
              {rows.map(({ key, check, p, verdict, item }) => (
                <ItemRow
                  key={key}
                  label={subject(item) || check.instructions.split('\n')[0].replace(/^Action:\s*/, '')}
                  facts={item}
                >
                  {verdict ? (
                    <Conclusion verdict={verdict} text={meaning[verdict] ?? verdictText[verdict]} p={p} />
                  ) : (
                    <span className="text-xs text-muted-foreground">无结果</span>
                  )}
                </ItemRow>
              ))}
            </ul>
            <Disclosure summary="发给模型的问题">
              <Json value={sharedQuestion(rows[0]?.check.instructions ?? '', c.request.instructions)} />
            </Disclosure>
          </Section>
        );
      })}
    </>
  );
}

/** One checklist item; its facts open in place, rendered only when asked for. */
function ItemRow({
  label,
  facts,
  children,
}: {
  label: string;
  facts?: Record<string, unknown>;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="flex min-w-0 flex-col gap-1.5 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {facts ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(o => !o)}
            className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-foreground"
          >
            <ChevronRight
              className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
            />
            <span className="min-w-0 truncate">{label}</span>
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate">{label}</span>
        )}
        {children}
      </div>
      {open && facts && <Facts item={facts} />}
    </li>
  );
}

const factText: Record<string, string> = {
  tag: '标签',
  role: '角色',
  name: '名称',
  text: '文字',
  hints: '交互信号',
  context: '所在区域',
  action: '动作',
  after: '新出现的文字',
  before: '动作前的文字',
  members: '列表项',
  field: '输入框',
  goal: '测试目标',
  entry: '入口页',
  controls: '页面上可见的控件',
  question: '要回答的问题',
  history: '已做过的动作',
  newText: '新看到的文字',
  actions: '可选动作',
  stayOnPage: '只测当前页',
  allowedPaths: '允许访问的路径',
  areas: '包含的公共区域',
  focus: '关注点',
  tasks: '任务',
};

/** What the model was shown about one item, as labelled fields rather than JSON. */
function Facts({ item }: { item: Record<string, unknown> }) {
  const fields = Object.entries((item.control as Record<string, unknown> | undefined) ?? item).filter(
    ([k, v]) => k !== 'kind' && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length),
  );
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-muted/40 p-2 pl-6 text-xs">
      {fields.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="text-muted-foreground">{factText[k] ?? k}</dt>
          <dd className="min-w-0 break-all whitespace-pre-wrap">
            <FactValue value={v} />
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** A field value; long text and long lists show their start and render the rest only when opened. */
function FactValue({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);
  if (typeof value === 'boolean') return value ? '是' : '否';
  const lines = Array.isArray(value)
    ? value.map(v => (typeof v === 'object' ? JSON.stringify(v) : String(v)))
    : typeof value === 'object'
      ? [JSON.stringify(value)]
      : String(value).split('\n');
  const text = lines.join(Array.isArray(value) && lines.every(l => l.length < 40) && lines.length <= 8 ? ' / ' : '\n');
  if (text.length <= 400 && lines.length <= 8) return text;
  return (
    <>
      {open ? text : `${lines.slice(0, 4).join('\n').slice(0, 300)}…`}
      <button
        type="button"
        className="ml-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        onClick={() => setOpen(o => !o)}
      >
        {open ? '收起' : `展开全部（${lines.length} 行）`}
      </button>
    </>
  );
}

/**
 * LLM calls (goal planning, goal pursuit, escalated yes / no questions): the answer as the
 * crawler read it, then what the model was shown.
 */
function Generated({ call: c }: { call: ModelCall }) {
  const kind = purposeKinds(c.purpose)[0];
  const state = (c.request.state ?? {}) as Record<string, unknown>;
  const value = c.answer?.value;
  let conclusion: React.ReactNode = <span className="text-muted-foreground">没有结果。</span>;
  if (typeof value === 'boolean') {
    const verdict = value ? 'yes' : 'no';
    conclusion = (
      <span className={cn('font-medium', verdictClass[verdict])}>
        {verdictMeaning[kind]?.[verdict] ?? verdictText[verdict]}
      </span>
    );
  } else if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (kind === 'goal-pursuit') {
      const actions = (state.actions as string[] | undefined) ?? [];
      const next = typeof v.next === 'number' && v.next >= 0 ? actions[v.next]?.replace(/^\d+:\s*/, '') : undefined;
      conclusion = (
        <span className="flex flex-col gap-1">
          <span className={cn('font-medium', v.answered ? 'text-success' : '')}>
            {v.answered ? (v.found ? '已找到答案' : '判断页面上没有（暂定，会继续探索确认）') : '还没有答案'}
          </span>
          {v.answer ? <span>答案：{String(v.answer)}</span> : null}
          {!v.answered && <span>下一步：{next ? `建议执行「${next}」` : '没有明确该点哪里，交给爬虫自己探索'}</span>}
          {v.reason ? <span className="text-muted-foreground">理由：{String(v.reason)}</span> : null}
        </span>
      );
    } else conclusion = <Facts item={v} />;
  }
  return (
    <>
      <Section title="结论">
        <div className="text-sm">{conclusion}</div>
      </Section>
      <Section title="模型看到的">
        <Facts item={state} />
      </Section>
    </>
  );
}

/** A checklist item's question with its `itemN.` field prefixes removed, so it reads as the group's question. */
const sharedQuestion = (check: string, shared: string) =>
  [shared, /`item\d+\./.test(check) ? check.replace(/`item\d+\./g, '`') : ''].filter(Boolean).join('\n\n');

const optionText: Record<string, string> = {
  yes: '是新内容',
  no: '无实质变化（数字跳动或说的是同一件事）',
  unrelated: '页面自己变的，与动作无关',
  ...inputKindText,
};

/** What the crawler did with an effect choice, replaying judge.ts: unrelated first, then yes against no. */
function effectConclusion(probabilities: Record<string, number>): {
  verdict: Verdict;
  text: string;
  why: string;
} {
  const { yes = 0, no = 0, unrelated = 0 } = probabilities;
  if (unrelated >= 0.7)
    return {
      verdict: 'no',
      text: '不算新状态',
      why: `"与动作无关"的概率 ${unrelated.toFixed(2)} ≥ 0.70。`,
    };
  const p = yes + no > 0 ? yes / (yes + no) : 0;
  const ratio = `只比较"是"和"否"：是 / (是 + 否) = ${p.toFixed(2)}`;
  if (p >= 0.75) return { verdict: 'yes', text: '算新状态', why: `${ratio} ≥ 0.75。` };
  if (p <= 0.25) return { verdict: 'no', text: '不算新状态', why: `${ratio} ≤ 0.25。` };
  return {
    verdict: 'uncertain',
    text: '算新状态',
    why: `${ratio}，拿不准；宁可多一个状态，也不漏掉真内容。`,
  };
}

/** A JEV choice: the conclusion, then each option with its probability, the chosen one first. */
function Choice({ call: c }: { call: ModelCall }) {
  const probabilities = c.answer?.probabilities ?? {};
  const options = Object.keys(c.request.options ?? {}).sort(
    (a, b) => (probabilities[b] ?? 0) - (probabilities[a] ?? 0),
  );
  const state = (c.request.state ?? {}) as Record<string, unknown>;
  const effect = c.purpose === 'crawler-effect' && c.answer ? effectConclusion(probabilities) : undefined;
  const chosen = c.answer?.value === undefined ? undefined : String(c.answer.value);
  return (
    <>
      <Section title="结论">
        {effect ? (
          <p className="text-sm">
            <span className={cn('font-medium', effect.verdict !== 'uncertain' && verdictClass[effect.verdict])}>
              {effect.text}
            </span>
            <span className="text-muted-foreground">：{effect.why}</span>
          </p>
        ) : chosen !== undefined ? (
          <p className="text-sm">
            按「
            <span className="font-medium">{optionText[chosen] ?? chosen}</span>
            」填入样本值。
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">没有结果。</p>
        )}
      </Section>
      <Section title="模型看到的">
        <Facts item={state.field ? { ...(state.field as object), context: state.context } : state} />
      </Section>
      <Section title="选项与概率">
        <ul className="flex flex-col divide-y rounded-md border text-sm">
          {options.map(option => {
            const p = probabilities[option];
            return (
              <li key={option} className="flex min-w-0 items-center gap-3 px-3 py-2">
                <span className={cn('min-w-0 flex-1 truncate', option === chosen && 'font-medium')}>
                  {optionText[option] ?? option}
                </span>
                <span className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full bg-foreground/60" style={{ width: `${(p ?? 0) * 100}%` }} />
                </span>
                <span className="w-10 text-right tabular-nums">{p === undefined ? '—' : p.toFixed(2)}</span>
              </li>
            );
          })}
        </ul>
      </Section>
    </>
  );
}

/** What one checklist item asks about; the question kind is the box it sits in. */
function subject(item?: Record<string, unknown>) {
  if (!item) return '';
  const control = item.control as { name?: string; text?: string; tag?: string } | undefined;
  if (control) return control.name || control.text || control.tag || '';
  if (typeof item.action === 'string') return item.action;
  if (Array.isArray(item.members)) return item.members.slice(0, 4).join(' / ');
  return '';
}
