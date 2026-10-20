import type React from 'react';
import { CircleCheck, CircleHelp, Loader2, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Disclosure, InfoTip, Screenshot } from './common.js';
import { usd } from './text.js';
import type { Event, GoalPlan, PursuitEvent, Summary } from './types.js';

const areaText: Record<GoalPlan['areas'][number], string> = {
  banner: '页头',
  navigation: '导航',
  contentinfo: '页脚',
};

/**
 * Goal mode: what was asked, how the LLM scoped it, and whether the page answered the question,
 * with the screenshot of the state the answer was read from.
 */
export function GoalView({
  runId,
  goal,
  events,
  summary,
  running,
}: {
  runId: string;
  goal: string;
  events: Event[];
  summary?: Summary;
  running: boolean;
}) {
  const planEvent = events.find(e => e.type === 'goal');
  const plan = summary?.goal?.plan ?? (planEvent?.type === 'goal' ? planEvent.plan : undefined);
  const looks = events.filter((e): e is PursuitEvent => e.type === 'pursuit');
  // The last answer stands until a later look takes it back (a provisional "no" overturned).
  const last = looks.at(-1);
  const answered = last?.answered ? last : undefined;
  const pursuit = summary?.pursuit;
  const status: { icon: React.ReactNode; text: string; className?: string; tip?: string } = !plan
    ? running
      ? { icon: <Loader2 className="size-4 animate-spin" />, text: '正在根据目标规划范围' }
      : { icon: <CircleHelp className="size-4" />, text: '没有得到目标规划', className: 'text-destructive' }
    : !plan.question
      ? {
          icon: <Search className="size-4" />,
          text: '目标是覆盖相关界面，没有要回答的问题',
          tip: '只在目标范围内探索：与目标无关的动作和区域不执行。',
        }
      : answered?.found
        ? { icon: <CircleCheck className="size-4" />, text: '页面上找到了答案', className: 'text-success' }
        : answered
          ? pursuit?.settled
            ? {
                icon: <CircleCheck className="size-4" />,
                text: '范围内都看过了，页面上没有',
                className: 'text-success',
                tip: '答案来自"没看到"，所以先探索完整个范围才算数。',
              }
            : {
                icon: running ? <Loader2 className="size-4 animate-spin" /> : <CircleHelp className="size-4" />,
                text: running ? '暂时判断页面上没有，继续探索确认' : '暂时判断页面上没有，但没探索完就停了',
                className: 'text-warning',
                tip: '答案来自"没看到"，内容可能还藏在菜单、标签页或折叠区里，要探索完整个范围才算数。',
              }
          : running
            ? { icon: <Loader2 className="size-4 animate-spin" />, text: '还在找答案' }
            : { icon: <CircleHelp className="size-4" />, text: '没有找到答案', className: 'text-warning' };

  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">测试目标</span>
        <p className="text-sm font-medium break-words">{goal}</p>
      </div>
      {plan?.question && (
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            要回答的问题
            <InfoTip>
              LLM 从目标里提炼的问题。每到一个新状态，LLM 读新出现的文字，判断答案找到没有、下一步点哪里。
            </InfoTip>
          </span>
          <p className="text-sm break-words">{plan.question}</p>
        </div>
      )}
      <div className={cn('flex items-center gap-1.5 text-sm font-medium', status.className)}>
        {status.icon}
        {status.text}
        {status.tip && <InfoTip>{status.tip}</InfoTip>}
      </div>
      {answered && (
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-2 text-sm">
            <p className="break-words">{answered.answer || '（模型没有给出答案文字）'}</p>
            {answered.reason && <p className="text-xs break-words text-muted-foreground">理由：{answered.reason}</p>}
            <a
              href={answered.url}
              target="_blank"
              rel="noreferrer"
              className="truncate text-xs text-muted-foreground hover:underline"
              title={answered.url}
            >
              {answered.url}
            </a>
          </div>
          <Screenshot runId={runId} state={answered.state} label="答案所在的页面状态" />
        </div>
      )}
      {plan && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>范围：{plan.stayOnPage ? '只在入口页' : `入口页和 ${plan.allowedPaths.length} 类页面`}</span>
          <span>
            站点区域：{plan.areas.length ? plan.areas.map(a => areaText[a]).join('、') : '不碰页头、导航和页脚'}
          </span>
          <span>LLM 看了 {looks.length} 次</span>
          {pursuit && (
            <>
              <span>按 LLM 建议点了 {pursuit.steeredActions} 次</span>
              <span>找答案花费 {usd(pursuit.costUsd)}</span>
            </>
          )}
          {summary?.goal && <span>与目标无关、跳过的动作类 {summary.goal.prunedClasses}</span>}
        </div>
      )}
      {plan && (
        <Disclosure summary="LLM 的规划">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            {!plan.stayOnPage && (
              <>
                <dt className="text-muted-foreground">可访问的页面</dt>
                <dd className="font-mono break-all">{plan.allowedPaths.join('  ')}</dd>
              </>
            )}
            {!!plan.focus.length && (
              <>
                <dt className="text-muted-foreground">关注</dt>
                <dd>{plan.focus.join('；')}</dd>
              </>
            )}
            {!!plan.tasks.length && (
              <>
                <dt className="text-muted-foreground">任务</dt>
                <dd>{plan.tasks.join('；')}</dd>
              </>
            )}
          </dl>
        </Disclosure>
      )}
    </section>
  );
}
