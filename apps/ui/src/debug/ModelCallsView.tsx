import type React from 'react';
import { forwardRef, useEffect, useMemo, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { ChevronRight, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { Empty, InfoTip, Json, Kind, Section, Time } from './common.js';
import { call, providerClass, purposeKinds, questionText, seconds, usd } from './text.js';
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

/** One call's reason, input and output; fetched when opened. */
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
  const [detail, setDetail] = useState<ModelCall | { error: string }>();
  useEffect(() => {
    if (id === undefined) return;
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
    <Dialog open={id !== undefined} onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {c ? (
              <>
                <Kind className={providerClass[c.provider]}>{c.provider.toUpperCase()}</Kind>
                {reasonOf(c.purpose)}
              </>
            ) : (
              '模型调用'
            )}
          </DialogTitle>
          {c && (
            <DialogDescription asChild>
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
            </DialogDescription>
          )}
        </DialogHeader>
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
                    onClick={() => {
                      onSelectAction(target.node.event.seq);
                      onClose();
                    }}
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
              <Section title="完整输入" aside={<InfoTip>发给模型的说明和页面事实（state）。</InfoTip>}>
                <Json
                  value={{
                    instructions: c.request.instructions || undefined,
                    state: c.request.state,
                    options: c.request.options,
                  }}
                />
              </Section>
              {c.answer && (
                <Section title="原始输出">
                  <Json value={c.answer} className="max-h-48" />
                </Section>
              )}
            </div>
          )
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A JEV checklist answers each item separately: show item, question and probability side by side. */
function Questions({ call: c }: { call: ModelCall }) {
  if (c.kind === 'choice' && c.request.options) return <Choice call={c} />;
  if (c.kind !== 'checklist' || !c.request.checks) return null;
  const values = (c.answer?.value ?? {}) as Record<string, unknown>;
  const state = (c.request.state ?? {}) as Record<string, Record<string, unknown> | undefined>;
  // One box per question kind: a batch can mix "worth clicking" with "same-kind list".
  const groups = new Map<string, [string, { instructions: string }][]>();
  for (const entry of Object.entries(c.request.checks)) {
    const kind = String(state[entry[0]]?.kind ?? '');
    groups.set(kind, [...(groups.get(kind) ?? []), entry]);
  }
  return (
    <>
      {[...groups].map(([kind, checks]) => (
        <Section
          key={kind}
          title={`${questionText[kind]?.title ?? (kind || '逐项结果')}（${checks.length}）`}
          aside={<InfoTip>JEV 概率 ≥ 0.75 判为是，≤ 0.25 判为否，中间为不确定。</InfoTip>}
        >
          <ul className="flex max-h-72 flex-col divide-y overflow-y-auto rounded-md border text-sm">
            {checks.map(([key, check]) => {
              const p = values[key];
              const item = state[key];
              return (
                <li key={key} className="flex min-w-0 flex-col gap-1 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">
                      {subject(item) || check.instructions.split('\n')[0]}
                    </span>
                    {typeof p === 'number' ? (
                      <Badge
                        variant="outline"
                        className={cn(
                          'tabular-nums',
                          p >= 0.75
                            ? 'border-success/30 text-success'
                            : p <= 0.25
                              ? 'border-destructive/30 text-destructive'
                              : '',
                        )}
                      >
                        {p.toFixed(2)}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">无结果</span>
                    )}
                  </div>
                  {item && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted-foreground">输入与问题</summary>
                      <Json value={{ item, question: check.instructions }} className="mt-1 max-h-60" />
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      ))}
    </>
  );
}

const optionText: Record<string, string> = {
  yes: '是新内容',
  no: '没变化',
  unrelated: '页面自己变的，与动作无关',
  number: '数字',
  search: '搜索',
  email: '邮箱',
  date: '日期',
  text: '文本',
};

/** A JEV choice: each option with its probability, the chosen one first. */
function Choice({ call: c }: { call: ModelCall }) {
  const probabilities = c.answer?.probabilities ?? {};
  const options = Object.keys(c.request.options ?? {}).sort(
    (a, b) => (probabilities[b] ?? 0) - (probabilities[a] ?? 0),
  );
  return (
    <Section
      title="选项与概率"
      aside={
        c.purpose === 'crawler-effect' ? (
          <InfoTip>
            "与动作无关"的概率 ≥ 0.70 才不算新内容；否则只比较"是"和"否"，宁可多一个状态，也不漏掉真内容。
          </InfoTip>
        ) : undefined
      }
    >
      <ul className="flex flex-col divide-y rounded-md border text-sm">
        {options.map(option => {
          const p = probabilities[option];
          return (
            <li key={option} className="flex min-w-0 items-center gap-2 px-3 py-2">
              <span className={cn('min-w-0 flex-1 truncate', option === c.answer?.value && 'font-medium')}>
                {optionText[option] ?? option}
              </span>
              <span className="font-mono text-xs text-muted-foreground">{option}</span>
              <span className="w-10 text-right tabular-nums">{p === undefined ? '—' : p.toFixed(2)}</span>
            </li>
          );
        })}
      </ul>
    </Section>
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
