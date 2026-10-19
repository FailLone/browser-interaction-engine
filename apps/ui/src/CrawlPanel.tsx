import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleAlert, ImageIcon, ListTree, Loader2, Play, RefreshCw, RotateCw, Square, X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

interface Run {
  id: string;
  url: string;
  status: 'running' | 'finished' | 'failed' | 'interrupted';
  summary?: Summary;
  error?: string;
  createdAt: string;
  options: { resumeFrom?: string; plugins?: string[] };
}
interface Summary {
  elapsedMs: number;
  actions: number;
  states: number;
  resumedStates?: number;
  failed: number;
  onEntryPage: number;
  models?: { jev: { calls: number; costUsd: number }; llm: { calls: number; costUsd: number } };
  navigations?: { intercepted: number; sameDocument: unknown[] };
  coverage?: {
    pages: { page: string; classesExecuted: number; classesSeen: number; textBlocksRevealedByActions: number }[];
    statesPerMinute: number[];
  };
}
type Event =
  | { seq: number; type: 'state'; at: number; state: { key: string; url: string; overlay?: string; controls: number } }
  | {
      seq: number;
      type: 'action';
      at: number;
      step: { kind: string; label: string; value?: string };
      tier: string;
      outcome: string;
      newState: boolean;
      overlay?: string;
      error?: string;
    }
  | { seq: number; type: 'navigation'; at: number; kind: string; to: string; action: string; outcome: string }
  | {
      seq: number;
      type: 'judgement';
      at: number;
      question: string;
      label: string;
      verdict: string;
      source: string;
      probability?: number;
    }
  | { seq: number; type: 'backtrack' | 'stop'; at: number; reason: string }
  | {
      seq: number;
      type: 'finding';
      at: number;
      plugin: string;
      state: string;
      url: string;
      finding: { rule: string; severity: 'info' | 'warning' | 'error'; selector: string; text: string; detail: string };
    }
  | { seq: number; type: 'plugin_error'; at: number; plugin: string; state: string; error: string };

const statusText: Record<Run['status'], string> = {
  running: '运行中',
  finished: '已完成',
  failed: '失败',
  interrupted: '已中断',
};
const pluginText: Record<string, string> = { rules: 'UI 规则', checks: '轻量检查' };
const severityText: Record<string, string> = { info: '提示', warning: '警告', error: '错误' };
const outcomeText: Record<string, string> = { ok: '成功', no_change: '无变化', failed: '失败' };
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'content-type': 'application/json' } });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || response.statusText);
  return body as T;
}

/** Sampled crawler runs: start one, follow its actions and states live, view state screenshots, resume. */
export function CrawlPanel() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState('');
  const [events, setEvents] = useState<Event[]>([]);
  const [url, setUrl] = useState('https://www.okx.com/convert/usd-to-btc');
  const [minutes, setMinutes] = useState(5);
  const [models, setModels] = useState(true);
  const [available, setAvailable] = useState<string[]>([]);
  const [plugins, setPlugins] = useState<string[]>([]);
  const [state, setState] = useState('');
  const [error, setError] = useState('');
  const run = runs.find(r => r.id === selected);

  const refresh = useCallback(async () => {
    try {
      setRuns(await call<Run[]>('/v1/crawls'));
    } catch (e) {
      setError(String((e as Error).message));
    }
  }, []);
  useEffect(() => {
    void refresh();
    call<string[]>('/v1/crawl-plugins')
      .then(setAvailable)
      .catch(() => {});
  }, [refresh]);
  // Poll the selected run's new events while it is running.
  useEffect(() => {
    if (!selected) return;
    let stop = false,
      last = 0;
    setEvents([]);
    setState('');
    const tick = async () => {
      const batch = await call<Event[]>(`/v1/crawls/${selected}/events?after=${last}&limit=2000`).catch(() => []);
      if (stop) return;
      if (batch.length) {
        last = batch.at(-1)!.seq;
        setEvents(prev => [...prev, ...batch]);
      }
      const current = await call<Run>(`/v1/crawls/${selected}`).catch(() => undefined);
      if (current) setRuns(prev => prev.map(r => (r.id === current.id ? current : r)));
      if (!stop && current?.status === 'running') setTimeout(tick, 1500);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [selected]);

  const start = async (resumeFrom?: string) => {
    setError('');
    try {
      const created = await call<Run>('/v1/crawls', {
        method: 'POST',
        body: JSON.stringify({
          url: resumeFrom ? run!.url : url,
          durationMs: minutes * 60000,
          models,
          plugins: resumeFrom ? (run!.options.plugins ?? []) : plugins,
          ...(resumeFrom ? { resumeFrom } : {}),
        }),
      });
      setRuns(prev => [created, ...prev]);
      setSelected(created.id);
    } catch (e) {
      setError(String((e as Error).message));
    }
  };
  const stopRun = async () => {
    try {
      await call(`/v1/crawls/${selected}/stop`, { method: 'POST', body: '{}' });
      await refresh();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const states = useMemo(
    () => events.filter((e): e is Extract<Event, { type: 'state' }> => e.type === 'state'),
    [events],
  );
  const findings = useMemo(
    () =>
      events.filter(
        (e): e is Extract<Event, { type: 'finding' | 'plugin_error' }> =>
          e.type === 'finding' || e.type === 'plugin_error',
      ),
    [events],
  );
  const summary = run?.summary;

  const actionEvents = events.filter(e => e.type !== 'state' && e.type !== 'finding' && e.type !== 'plugin_error');

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold tracking-tight">抽样遍历</h1>

      {error && (
        <Alert variant="destructive" className="pr-10">
          <CircleAlert />
          <AlertDescription className="break-all">{error}</AlertDescription>
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-1.5 right-1.5 size-7"
            aria-label="关闭"
            onClick={() => setError('')}
          >
            <X />
          </Button>
        </Alert>
      )}

      <Card className="gap-4 py-5">
        <CardHeader className="px-5">
          <CardTitle>新建遍历</CardTitle>
          <CardDescription>只测当前页：跳转被拦截并记录，不会离开页面。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-4 px-5">
          <div className="grid min-w-0 flex-1 basis-80 gap-2">
            <Label htmlFor="crawl-url">网址</Label>
            <Input id="crawl-url" value={url} onChange={e => setUrl(e.target.value)} />
          </div>
          <div className="grid w-28 gap-2">
            <Label htmlFor="crawl-minutes">时长（分钟）</Label>
            <Input
              id="crawl-minutes"
              type="number"
              min={1}
              max={60}
              value={minutes}
              onChange={e => setMinutes(Number(e.target.value))}
            />
          </div>
          <div className="flex h-9 flex-wrap items-center gap-x-5 gap-y-2">
            <Label className="font-normal">
              <Checkbox checked={models} onCheckedChange={v => setModels(v === true)} />
              使用模型（JEV / LLM）
            </Label>
            {available.map(name => (
              <Label key={name} className="font-normal">
                <Checkbox
                  checked={plugins.includes(name)}
                  onCheckedChange={v =>
                    setPlugins(prev => (v === true ? [...prev, name] : prev.filter(p => p !== name)))
                  }
                />
                {pluginText[name] ?? name}
              </Label>
            ))}
          </div>
          <Button onClick={() => start()}>
            <Play />
            开始遍历
          </Button>
        </CardContent>
      </Card>

      <div className="grid items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <Card className="gap-0 py-0">
          <CardHeader className="flex items-center justify-between border-b px-4 py-3 [.border-b]:pb-3">
            <CardTitle className="text-sm">运行记录</CardTitle>
            <Button variant="ghost" size="sm" onClick={refresh}>
              <RefreshCw />
              刷新
            </Button>
          </CardHeader>
          <div className="flex max-h-[75vh] flex-col gap-1 overflow-y-auto p-2">
            {runs.map(r => (
              <button
                type="button"
                key={r.id}
                onClick={() => setSelected(r.id)}
                className={cn(
                  'flex flex-col gap-1 rounded-md border border-transparent px-3 py-2 text-left text-sm transition-colors hover:bg-accent',
                  r.id === selected && 'border-border bg-accent',
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <StatusBadge status={r.status} />
                  <span className="truncate font-medium">{new URL(r.url).pathname}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {new Date(r.createdAt).toLocaleString()}
                  {r.options.resumeFrom ? ' · 续跑' : ''}
                  {r.summary ? ` · ${r.summary.actions} 动作 / ${r.summary.states} 状态` : ''}
                </span>
              </button>
            ))}
            {!runs.length && <p className="px-3 py-6 text-center text-sm text-muted-foreground">还没有运行记录。</p>}
          </div>
        </Card>

        {run ? (
          <div className="flex min-w-0 flex-col gap-4">
            <Card className="gap-4 py-5">
              <CardHeader className="px-5">
                <CardTitle className="flex min-w-0 items-center gap-2">
                  <StatusBadge status={run.status} />
                  <span className="truncate" title={run.url}>
                    {run.url}
                  </span>
                </CardTitle>
                <CardAction>
                  {run.status === 'running' ? (
                    <Button variant="outline" size="sm" onClick={stopRun}>
                      <Square />
                      停止
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => start(run.id)}>
                      <RotateCw />
                      续跑（跳过已测）
                    </Button>
                  )}
                </CardAction>
              </CardHeader>
              {(run.error || summary) && (
                <CardContent className="flex flex-col gap-4 px-5">
                  {run.error && (
                    <Alert variant="destructive">
                      <CircleAlert />
                      <AlertDescription className="break-all">{run.error}</AlertDescription>
                    </Alert>
                  )}
                  {summary && (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {[
                        ['用时', seconds(summary.elapsedMs)],
                        ['动作', summary.actions],
                        ['新状态', summary.states],
                        ['续跑沿用状态', summary.resumedStates ?? 0],
                        ['失败', summary.failed],
                        ['拦截的跳转', summary.navigations?.intercepted ?? 0],
                        [
                          'JEV',
                          `${summary.models?.jev.calls ?? 0} 次 $${(summary.models?.jev.costUsd ?? 0).toFixed(5)}`,
                        ],
                        ['LLM', `${summary.models?.llm.calls ?? 0} 次`],
                      ].map(([k, v]) => (
                        <div key={String(k)} className="rounded-lg border bg-muted/40 px-3 py-2.5">
                          <div className="text-xs text-muted-foreground">{k}</div>
                          <div className="mt-1 text-lg font-semibold tabular-nums">{v}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {summary?.coverage && (
                    <div className="rounded-lg border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>页面</TableHead>
                            <TableHead>执行的控件类 / 出现的</TableHead>
                            <TableHead>动作揭示的文本块</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {summary.coverage.pages.map(p => (
                            <TableRow key={p.page}>
                              <TableCell className="font-mono text-xs">{new URL(p.page).pathname}</TableCell>
                              <TableCell className="tabular-nums">
                                {p.classesExecuted} / {p.classesSeen}
                              </TableCell>
                              <TableCell className="tabular-nums">{p.textBlocksRevealedByActions}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              )}
            </Card>

            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <ListCard title="动作" count={actionEvents.filter(e => e.type === 'action').length}>
                <ol className="divide-y">
                  {actionEvents.map(e => (
                    <li key={e.seq} className="flex gap-3 px-4 py-2 text-sm">
                      <Time ms={e.at} />
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        {e.type === 'action' && (
                          <>
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              <Kind>{e.step.kind}</Kind>
                              <span className="font-medium break-all">{e.step.label || '未命名'}</span>
                              {e.step.value && (
                                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{e.step.value}</code>
                              )}
                            </div>
                            <div className="text-xs break-all text-muted-foreground">
                              {e.tier}
                              {e.overlay ? ` · ${e.overlay}` : ''} ·{' '}
                              <span className={cn(e.outcome === 'failed' && 'text-destructive')}>
                                {outcomeText[e.outcome] ?? e.outcome}
                              </span>
                              {e.newState && <span className="text-success"> · 新状态</span>}
                              {e.error ? ` · ${e.error.slice(0, 80)}` : ''}
                            </div>
                          </>
                        )}
                        {e.type === 'navigation' && (
                          <div className="flex min-w-0 items-center gap-2">
                            <Kind>跳转</Kind>
                            <span className="text-xs break-all text-muted-foreground">
                              {e.kind} · {e.outcome} · {e.action} → {e.to}
                            </span>
                          </div>
                        )}
                        {e.type === 'judgement' && (
                          <div className="flex min-w-0 items-center gap-2">
                            <Kind>模型</Kind>
                            <span className="text-xs break-all text-muted-foreground">
                              {e.question} · {e.source} · {e.verdict}
                              {e.probability !== undefined ? ` ${e.probability.toFixed(2)}` : ''} · {e.label}
                            </span>
                          </div>
                        )}
                        {(e.type === 'backtrack' || e.type === 'stop') && (
                          <div className="flex min-w-0 items-center gap-2">
                            <Kind>{e.type === 'stop' ? '结束' : '回退'}</Kind>
                            <span className="text-xs break-all text-muted-foreground">{e.reason}</span>
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
                {!actionEvents.length && <Empty>还没有动作。</Empty>}
              </ListCard>

              <ListCard title="状态" count={states.length}>
                <ol className="flex flex-col gap-0.5 p-2">
                  {states.map(e => (
                    <li key={e.seq}>
                      <button
                        type="button"
                        onClick={() => setState(e.state.key)}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent',
                          state === e.state.key && 'bg-accent font-medium',
                        )}
                      >
                        <Time ms={e.at} />
                        <span className="min-w-0 flex-1 truncate">{e.state.overlay || '页面'}</span>
                        <span className="text-xs text-muted-foreground">{e.state.controls} 个可见控件</span>
                      </button>
                    </li>
                  ))}
                </ol>
                {!states.length && <Empty>还没有状态。</Empty>}
                {state && (
                  <div className="sticky bottom-0 border-t bg-card p-3">
                    <img
                      className="w-full rounded-md border"
                      alt="状态截图"
                      src={`/v1/crawls/${selected}/screenshot?state=${encodeURIComponent(state)}`}
                    />
                  </div>
                )}
              </ListCard>

              {!!run.options.plugins?.length && (
                <ListCard title="插件结果" count={findings.length} className="xl:col-span-2">
                  <ol className="divide-y">
                    {findings.map(e => (
                      <li key={e.seq} className="flex gap-3 px-4 py-2 text-sm">
                        <Time ms={e.at} />
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <Kind>{pluginText[e.plugin] ?? e.plugin}</Kind>
                            {e.type === 'finding' ? (
                              <Badge variant="outline" className={severityClass[e.finding.severity]}>
                                {severityText[e.finding.severity]} · {e.finding.rule}
                              </Badge>
                            ) : (
                              <span className="text-xs break-all text-destructive">插件出错：{e.error}</span>
                            )}
                          </div>
                          {e.type === 'finding' && (
                            <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                              <span className="break-all">
                                {e.finding.text || e.finding.selector} · {e.finding.detail.slice(0, 160)}
                              </span>
                              <Button
                                variant="link"
                                size="sm"
                                className="h-auto p-0 text-xs"
                                onClick={() => setState(e.state)}
                              >
                                <ImageIcon />
                                状态截图
                              </Button>
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                  {!findings.length && <Empty>还没有发现问题。</Empty>}
                </ListCard>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-card/50 px-8 py-24 text-center">
            <ListTree className="size-8 text-muted-foreground" />
            <h2 className="text-lg font-semibold">选择或开始一次遍历</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              遍历在服务端运行；关闭页面不会中断。中断后可以续跑，已测过的动作不会重测。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

const statusClass: Record<Run['status'], string> = {
  running: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  finished: 'border-success/30 bg-success/10 text-success',
  failed: 'border-destructive/30 bg-destructive/10 text-destructive',
  interrupted: 'border-warning/40 bg-warning/10 text-warning',
};
const severityClass: Record<string, string> = {
  info: 'text-muted-foreground',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
};

function StatusBadge({ status }: { status: Run['status'] }) {
  return (
    <Badge variant="outline" className={cn('shrink-0', statusClass[status])}>
      {status === 'running' && <Loader2 className="animate-spin" />}
      {statusText[status]}
    </Badge>
  );
}

function ListCard({
  title,
  count,
  className,
  children,
}: {
  title: string;
  count: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={cn('gap-0 overflow-hidden py-0', className)}>
      <CardHeader className="flex items-center justify-between border-b px-4 py-3 [.border-b]:pb-3">
        <CardTitle className="text-sm">{title}</CardTitle>
        <Badge variant="secondary" className="tabular-nums">
          {count}
        </Badge>
      </CardHeader>
      <div className="max-h-[60vh] overflow-y-auto">{children}</div>
    </Card>
  );
}

function Time({ ms }: { ms: number }) {
  return (
    <span className="w-12 shrink-0 pt-0.5 font-mono text-xs text-muted-foreground tabular-nums">{seconds(ms)}</span>
  );
}

function Kind({ children }: { children: React.ReactNode }) {
  return (
    <Badge variant="secondary" className="rounded-md font-mono">
      {children}
    </Badge>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-8 text-center text-sm text-muted-foreground">{children}</p>;
}
