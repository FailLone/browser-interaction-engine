import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  CircleStop,
  Clock,
  ListTree,
  Loader2,
  Monitor,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Square,
  X,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ActionTreeView } from './debug/ActionTreeView.js';
import { Hint, InfoTip } from './debug/common.js';
import { FindingsView } from './debug/FindingsView.js';
import { ModelCallDialog, ModelCallsView } from './debug/ModelCallsView.js';
import { StatesView } from './debug/StatesView.js';
import {
  call,
  duration,
  pluginText,
  providerClass,
  requestedViewport,
  resolvedViewport,
  seconds,
  statusText,
  stopText,
  usd,
  viewportText,
} from './debug/text.js';
import { buildActionTree } from './debug/tree.js';
import type { ActionNode } from './debug/tree.js';
import type { Event, FindingEvent, ModelCallSummary, PluginErrorEvent, Run, ViewportPreset } from './debug/types.js';

/**
 * Crawl debug page: start and follow runs, and work out afterwards why a problem was or was not
 * found — the walk as a tree, what was asked of JEV / LLM, and where each finding came from.
 */
export function CrawlPanel() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState('');
  const [creating, setCreating] = useState(false);
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
  }, [refresh]);

  const start = async (body: Record<string, unknown>) => {
    setError('');
    try {
      const created = await call<Run>('/v1/crawls', { method: 'POST', body: JSON.stringify(body) });
      setRuns(prev => [created, ...prev]);
      setSelected(created.id);
      setCreating(false);
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">巡检调试</h1>
        <InfoTip>遍历在服务端运行，关闭页面不会中断。每次运行只测入口页：跳转会被拦截并记录，不会离开页面。</InfoTip>
        <Button className="ml-auto" size="sm" onClick={() => setCreating(true)}>
          <Plus />
          新建遍历
        </Button>
      </header>

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

      <NewRunDialog open={creating} onOpenChange={setCreating} onStart={start} />

      <div className="grid items-start gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <RunList runs={runs} selected={selected} onSelect={setSelected} onRefresh={refresh} />
        {run ? (
          <RunDetail
            key={run.id}
            run={run}
            onUpdate={current => setRuns(prev => prev.map(r => (r.id === current.id ? current : r)))}
            onResume={() =>
              start({
                url: run.url,
                durationMs: run.options.durationMs ?? 300_000,
                models: run.options.models !== false,
                plugins: run.options.plugins ?? [],
                resumeFrom: run.id,
              })
            }
            onError={setError}
          />
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-card/50 px-8 py-24 text-center">
            <ListTree className="size-8 text-muted-foreground" />
            <h2 className="text-lg font-semibold">选择一次运行</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              看它走过的路径、问模型的问题和每个问题是怎么发现的。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function RunList({
  runs,
  selected,
  onSelect,
  onRefresh,
}: {
  runs: Run[];
  selected: string;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}) {
  return (
    <aside className="flex flex-col overflow-hidden rounded-xl border bg-card lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)]">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">运行记录</span>
        <Button variant="ghost" size="icon" className="size-7" aria-label="刷新" onClick={onRefresh}>
          <RefreshCw />
        </Button>
      </div>
      <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto p-1.5 lg:max-h-none">
        {runs.map(r => (
          <button
            type="button"
            key={r.id}
            onClick={() => onSelect(r.id)}
            className={cn(
              'flex flex-col gap-1 rounded-md border border-transparent px-2.5 py-2 text-left text-sm hover:bg-accent',
              r.id === selected && 'border-border bg-accent',
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <StatusBadge status={r.status} />
              <span className="truncate font-medium" title={r.url}>
                {new URL(r.url).pathname}
              </span>
            </span>
            <span className="text-xs text-muted-foreground">
              {new Date(r.createdAt).toLocaleString()}
              {` · ${r.summary?.viewport ? `${r.summary.viewport.width}×${r.summary.viewport.height}` : requestedViewport(r.options.viewport)}`}
              {r.options.resumeFrom ? ' · 续跑' : ''}
              {r.summary ? ` · ${r.summary.actions} 动作` : ''}
            </span>
          </button>
        ))}
        {!runs.length && <p className="px-3 py-6 text-center text-sm text-muted-foreground">还没有运行记录。</p>}
      </div>
    </aside>
  );
}

function RunDetail({
  run,
  onUpdate,
  onResume,
  onError,
}: {
  run: Run;
  onUpdate: (run: Run) => void;
  onResume: () => void;
  onError: (message: string) => void;
}) {
  const [events, setEvents] = useState<Event[]>([]);
  const [calls, setCalls] = useState<{ recorded: boolean; calls: ModelCallSummary[] }>({ recorded: true, calls: [] });
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState('tree');
  const [action, setAction] = useState<number>();
  const [openCall, setOpenCall] = useState<number>();

  // Slim events in pages; a running crawl is polled until it ends.
  // biome-ignore lint/correctness/useExhaustiveDependencies: onUpdate is a fresh closure each render; the poll belongs to the run
  useEffect(() => {
    let stop = false,
      last = 0;
    const tick = async () => {
      for (;;) {
        let batch: Event[];
        try {
          batch = await call<Event[]>(`/v1/crawls/${run.id}/debug/events?after=${last}&limit=2000`);
        } catch (e) {
          // Say so instead of showing an empty run, e.g. a server started before these routes existed.
          if (!stop) setLoadError(`读取运行记录失败：${(e as Error).message}。服务端可能需要重启。`);
          return;
        }
        if (stop) return;
        if (!batch.length) break;
        last = batch.at(-1)!.seq;
        setEvents(prev => [...prev, ...batch]);
        if (batch.length < 2000) break;
      }
      const [current, modelCalls] = await Promise.all([
        call<Run>(`/v1/crawls/${run.id}`).catch(() => undefined),
        call<{ recorded: boolean; calls: ModelCallSummary[] }>(`/v1/crawls/${run.id}/debug/model-calls`).catch(
          () => undefined,
        ),
      ]);
      if (stop) return;
      setLoaded(true);
      if (modelCalls) setCalls(modelCalls);
      if (current) onUpdate(current);
      if (current?.status === 'running') setTimeout(tick, 1500);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [run.id]);

  const tree = useMemo(() => buildActionTree(events), [events]);
  const states = useMemo(
    () => events.filter((e): e is Extract<Event, { type: 'state' }> => e.type === 'state'),
    [events],
  );
  const findings = useMemo(
    () => events.filter((e): e is FindingEvent | PluginErrorEvent => e.type === 'finding' || e.type === 'plugin_error'),
    [events],
  );
  const summary = run.summary;
  const viewportEvent = events.find(e => e.type === 'viewport');
  const usedViewport = summary?.viewport ?? (viewportEvent?.type === 'viewport' ? viewportEvent.viewport : undefined);
  const stopEvent = events.findLast(e => e.type === 'stop');
  const stopReason = summary?.stopReason ?? (stopEvent?.type === 'stop' ? stopEvent.reason : undefined);
  const backtracks = events.filter(e => e.type === 'backtrack').length;
  const models = summary?.models;
  // Per provider from the summary; a running crawl has none yet, so count the recorded calls.
  const model = (p: 'jev' | 'llm') => {
    if (models) return { n: models[p].calls, cost: models[p].costUsd };
    const own = calls.calls.filter(c => c.provider === p);
    return { n: own.length, cost: own.reduce((sum, c) => sum + (c.costUsd ?? 0), 0) };
  };
  const jev = model('jev'),
    llm = model('llm');
  const failures = useMemo(() => tree.actions.filter(a => a.event.outcome === 'failed'), [tree]);
  // Bumped on every jump from outside the tree, so choosing the same action again still scrolls to it.
  const [focus, setFocus] = useState(0);
  const selectAction = (seq: number) => {
    setAction(seq);
    setFocus(n => n + 1);
    setTab('tree');
  };

  const stopRun = async () => {
    try {
      const result = await call<{ run: Run }>(`/v1/crawls/${run.id}/stop`, { method: 'POST', body: '{}' });
      onUpdate(result.run);
    } catch (e) {
      onError(String((e as Error).message));
    }
  };

  const stats: [string, React.ReactNode, React.ReactNode?, string?][] = [
    ['用时', summary ? seconds(summary.elapsedMs) : tree.actions.length ? seconds(events.at(-1)!.at) : '—'],
    [
      '动作',
      summary?.actions ?? tree.actions.length,
      failures.length ? (
        <FailureStepper key="failures" failures={failures} current={action} onSelect={selectAction} />
      ) : summary?.failed ? (
        `${summary.failed} 失败`
      ) : undefined,
    ],
    ['新状态', summary?.states ?? states.length, summary?.resumedStates ? `沿用 ${summary.resumedStates}` : undefined],
    ['回溯', summary?.backtracks ?? backtracks],
    [
      '外链',
      summary?.navigations?.intercepted ?? events.filter(e => e.type === 'navigation').length,
      undefined,
      '页面上指向其他页面的不同目的地。大多直接从链接的 href 读到，没有点击；少数是点击后被拦截的跳转。',
    ],
    ['JEV', `${jev.n} 次`, jev.n ? usd(jev.cost) : undefined],
    ['LLM', `${llm.n} 次`, llm.n ? usd(llm.cost) : undefined],
    ['发现', findings.filter(f => f.type === 'finding').length],
  ];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <StatusBadge status={run.status} />
              <a
                href={run.url}
                target="_blank"
                rel="noreferrer"
                className="truncate font-semibold hover:underline"
                title={run.url}
              >
                {run.url}
              </a>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Monitor className="size-3.5" />
                {usedViewport ? resolvedViewport(usedViewport) : requestedViewport(run.options.viewport)}
                {(usedViewport?.breakpoints || usedViewport?.note) && (
                  <InfoTip>
                    {usedViewport.breakpoints && `页面桌面断点：${usedViewport.breakpoints.join(' / ')}px。`}
                    {usedViewport.note}
                  </InfoTip>
                )}
              </span>
              {run.status !== 'running' && stopReason && (
                <StopReason reason={stopReason} elapsedMs={summary?.elapsedMs} limitMs={run.options.durationMs} />
              )}
              {!!run.options.plugins?.length && (
                <span>插件：{run.options.plugins.map(p => pluginText[p] ?? p).join('、')}</span>
              )}
              {run.options.models === false && <span>未使用模型</span>}
            </div>
          </div>
          {run.status === 'running' ? (
            <Button variant="outline" size="sm" onClick={stopRun}>
              <Square />
              停止
            </Button>
          ) : (
            <Tooltipped tip="接着这次运行继续，已测过的动作和已有判断不会重复。">
              <Button variant="outline" size="sm" onClick={onResume}>
                <RotateCw />
                续跑
              </Button>
            </Tooltipped>
          )}
        </div>
        {run.error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription className="break-all">{run.error}</AlertDescription>
          </Alert>
        )}
        <dl className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
          {stats.map(([k, v, sub, tip]) => (
            <div key={k} className="rounded-lg bg-muted/50 px-3 py-2">
              <dt className="text-xs text-muted-foreground">
                {tip ? (
                  <span className="flex items-center gap-1">
                    {k}
                    <InfoTip>{tip}</InfoTip>
                  </span>
                ) : k === 'JEV' || k === 'LLM' ? (
                  <span className={cn('rounded px-1 py-0.5 font-medium', providerClass[k === 'JEV' ? 'jev' : 'llm'])}>
                    {k}
                  </span>
                ) : (
                  k
                )}
              </dt>
              <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
                <span className="text-base font-semibold whitespace-nowrap tabular-nums">{v}</span>
                {sub && <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">{sub}</span>}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="tree">
            动作树 <Count n={tree.actions.length} />
          </TabsTrigger>
          <TabsTrigger value="models">
            模型调用 <Count n={calls.calls.length} />
          </TabsTrigger>
          {!!run.options.plugins?.length && (
            <TabsTrigger value="findings">
              发现 <Count n={findings.length} />
            </TabsTrigger>
          )}
          <TabsTrigger value="states">
            状态 <Count n={states.length} />
          </TabsTrigger>
          {summary?.coverage && <TabsTrigger value="coverage">覆盖</TabsTrigger>}
        </TabsList>
        {loadError ? (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription className="break-all">{loadError}</AlertDescription>
          </Alert>
        ) : !loaded ? (
          <div className="flex justify-center py-16">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <TabsContent value="tree">
              <ActionTreeView
                runId={run.id}
                tree={tree}
                events={events}
                calls={calls.calls}
                selected={action}
                focus={focus}
                onSelect={setAction}
                onOpenCall={setOpenCall}
              />
            </TabsContent>
            <TabsContent value="models">
              <ModelCallsView
                calls={calls.calls}
                recorded={calls.recorded}
                tree={tree}
                onOpen={setOpenCall}
                modelsEnabled={run.options.models !== false}
              />
            </TabsContent>
            <TabsContent value="findings">
              <FindingsView runId={run.id} findings={findings} tree={tree} onSelectAction={selectAction} />
            </TabsContent>
            <TabsContent value="states">
              <StatesView runId={run.id} states={states} />
            </TabsContent>
            {summary?.coverage && (
              <TabsContent value="coverage">
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>页面</TableHead>
                        <TableHead>
                          <Hint tip="同一结构的控件算一类，每类只抽样执行几个。">执行的控件类 / 出现的</Hint>
                        </TableHead>
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
              </TabsContent>
            )}
          </>
        )}
      </Tabs>

      <ModelCallDialog
        runId={run.id}
        id={openCall}
        tree={tree}
        onClose={() => setOpenCall(undefined)}
        onSelectAction={selectAction}
      />
    </div>
  );
}

function Count({ n }: { n: number }) {
  return <span className="text-xs text-muted-foreground tabular-nums">{n}</span>;
}

function Tooltipped({ tip, children }: { tip: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

/** Why a finished run ended, in one line; the explanation is in a tooltip. */
function StopReason({ reason, elapsedMs, limitMs }: { reason: string; elapsedMs?: number; limitMs?: number }) {
  const early = reason === 'scope_exhausted';
  const Icon = early ? CircleCheck : reason === 'stopped' ? CircleStop : reason === 'error' ? CircleAlert : Clock;
  return (
    <span className={cn('flex items-center gap-1', early ? 'text-success' : reason === 'error' && 'text-destructive')}>
      <Icon className="size-3.5" />
      {stopText[reason] ?? reason}
      {elapsedMs !== undefined && (
        <InfoTip>
          用时 {duration(elapsedMs)}
          {limitMs ? `，上限 ${duration(limitMs)}` : ''}
          {early && limitMs && elapsedMs < limitMs ? '。能测的都测完了，所以提前结束。' : '。'}
        </InfoTip>
      )}
    </span>
  );
}

const statusClass: Record<Run['status'], string> = {
  running: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  finished: 'border-success/30 bg-success/10 text-success',
  failed: 'border-destructive/30 bg-destructive/10 text-destructive',
  interrupted: 'border-warning/40 bg-warning/10 text-warning',
};

function StatusBadge({ status }: { status: Run['status'] }) {
  return (
    <Badge variant="outline" className={cn('shrink-0', statusClass[status])}>
      {status === 'running' && <Loader2 className="animate-spin" />}
      {statusText[status]}
    </Badge>
  );
}

const selectClass =
  'h-9 w-full appearance-none rounded-md border border-input bg-transparent pr-9 pl-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30';

function NewRunDialog({
  open,
  onOpenChange,
  onStart,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (body: Record<string, unknown>) => void;
}) {
  const [url, setUrl] = useState('https://www.okx.com/convert/usd-to-btc');
  const [minutes, setMinutes] = useState(5);
  const [models, setModels] = useState(true);
  const [viewport, setViewport] = useState<ViewportPreset | 'custom'>('desktop');
  const [custom, setCustom] = useState({ width: 1280, height: 800, mobile: false });
  const [available, setAvailable] = useState<string[]>([]);
  // UI rules are on by default when the server offers them.
  const [plugins, setPlugins] = useState<string[]>([]);
  const [configured, setConfigured] = useState<{ jev: boolean; llm: boolean }>();
  useEffect(() => {
    call<{ jev: boolean; llm: boolean }>('/v1/crawl-models')
      .then(setConfigured)
      .catch(() => {});
    call<string[]>('/v1/crawl-plugins')
      .then(names => {
        setAvailable(names);
        setPlugins(names.filter(name => name === 'rules'));
      })
      .catch(() => {});
  }, []);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        // Focus the URL, not the first info icon, so no tip opens by itself.
        onOpenAutoFocus={e => {
          e.preventDefault();
          document.getElementById('crawl-url')?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>新建遍历</DialogTitle>
          <DialogDescription className="sr-only">输入网址和选项，开始一次遍历。</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={e => {
            e.preventDefault();
            onStart({
              url,
              durationMs: minutes * 60000,
              viewport: viewport === 'custom' ? custom : viewport,
              models,
              plugins,
            });
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="crawl-url" className="gap-1">
              网址
              <InfoTip>只测这一页：页面里的跳转会被拦截并记录，不会离开页面。</InfoTip>
            </Label>
            <Input id="crawl-url" value={url} onChange={e => setUrl(e.target.value)} />
          </div>
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
            <div className="grid gap-2">
              <Label htmlFor="crawl-minutes" className="gap-1">
                最长分钟
                <InfoTip>测完就会提前结束，不会等满。</InfoTip>
              </Label>
              <Input
                id="crawl-minutes"
                type="number"
                min={1}
                max={60}
                value={minutes}
                onChange={e => setMinutes(Number(e.target.value))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="crawl-viewport" className="gap-1">
                视口
                <InfoTip>
                  桌面临界：读取页面的 CSS / matchMedia 断点，取桌面布局的最窄宽度；读不到时用 1024×768。
                </InfoTip>
              </Label>
              <div className="relative">
                <select
                  id="crawl-viewport"
                  value={viewport}
                  onChange={e => setViewport(e.target.value as ViewportPreset | 'custom')}
                  className={selectClass}
                >
                  {Object.entries(viewportText).map(([value, text]) => (
                    <option key={value} value={value}>
                      {text}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </div>
          </div>
          {viewport === 'custom' && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid w-24 gap-2">
                <Label htmlFor="crawl-width">宽</Label>
                <Input
                  id="crawl-width"
                  type="number"
                  min={240}
                  max={3840}
                  value={custom.width}
                  onChange={e => setCustom(c => ({ ...c, width: Number(e.target.value) }))}
                />
              </div>
              <div className="grid w-24 gap-2">
                <Label htmlFor="crawl-height">高</Label>
                <Input
                  id="crawl-height"
                  type="number"
                  min={240}
                  max={2160}
                  value={custom.height}
                  onChange={e => setCustom(c => ({ ...c, height: Number(e.target.value) }))}
                />
              </div>
              <Label className="h-9 font-normal">
                <Checkbox
                  checked={custom.mobile}
                  onCheckedChange={v => setCustom(c => ({ ...c, mobile: v === true }))}
                />
                移动设备
                <InfoTip>触摸、移动端 UA、3 倍像素比。</InfoTip>
              </Label>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <Label className="font-normal">
              <Checkbox checked={models} onCheckedChange={v => setModels(v === true)} />
              使用模型（JEV / LLM）
            </Label>
            {configured && !configured.jev && !configured.llm && models && (
              <span className="flex items-center gap-1 text-xs text-warning">
                <CircleAlert className="size-3.5" />
                服务端未配置 JEV / LLM，不会调用模型
                <InfoTip>
                  启动服务前在环境里设置 EXPLORER_JEV_* / EXPLORER_LLM_*（见 .env.explorer.example），然后重启。
                </InfoTip>
              </span>
            )}
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
          <Button type="submit" className="self-end">
            <Play />
            开始遍历
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Failed actions in the stats box: the count opens the first one in the action tree; with
 * several, the arrows step through them in run order.
 */
function FailureStepper({
  failures,
  current,
  onSelect,
}: {
  failures: ActionNode[];
  current?: number;
  onSelect: (seq: number) => void;
}) {
  const at = failures.findIndex(f => f.event.seq === current);
  const go = (i: number) => onSelect(failures[(i + failures.length) % failures.length].event.seq);
  const arrow = 'rounded p-0.5 text-destructive/70 hover:bg-destructive/10 hover:text-destructive';
  return (
    <span className="inline-flex items-center gap-0.5 text-destructive">
      <button
        type="button"
        className="rounded px-0.5 underline-offset-4 hover:underline"
        title="在动作树中查看失败的动作"
        onClick={() => go(at < 0 ? 0 : at)}
      >
        {failures.length} 失败
      </button>
      {failures.length > 1 && (
        <>
          {at >= 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {at + 1}/{failures.length}
            </span>
          )}
          <button type="button" className={arrow} aria-label="上一个失败" onClick={() => go(at < 0 ? -1 : at - 1)}>
            <ChevronUp className="size-3.5" />
          </button>
          <button type="button" className={arrow} aria-label="下一个失败" onClick={() => go(at + 1)}>
            <ChevronDown className="size-3.5" />
          </button>
        </>
      )}
    </span>
  );
}
