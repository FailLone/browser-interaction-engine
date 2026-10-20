import { useEffect, useState } from 'react';
import { Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { Disclosure, Hint, InfoTip, Json, Kind, Screenshot, Section, Time } from './common.js';
import { call, kindText, pluginText, severityText, span } from './text.js';
import { type ActionTree, type StateChecks, type StateFinding, actionBefore, stateFindings } from './tree.js';
import type { CheckSummary, FindingEvent, SweepEvent } from './types.js';

type Verdict = CheckSummary['verdict'];
const verdictOrder: Verdict[] = ['fail', 'unknown', 'pass', 'not-applicable'];
export const checkVerdictText: Record<Verdict, string> = {
  fail: '未通过',
  unknown: '无法判断',
  pass: '通过',
  'not-applicable': '不适用',
};
const checkVerdictClass: Record<Verdict, string> = {
  fail: 'border-destructive/30 text-destructive',
  unknown: 'border-warning/40 text-warning',
  pass: 'border-success/30 text-success',
  'not-applicable': 'text-muted-foreground',
};
/** Above this many checks on a state, the detail offers a search box. */
const searchFrom = 15;

/** Counts over every plugin's checks on one state. */
export function checkTally(group: StateChecks) {
  const tally = { checks: 0, ms: 0, fail: 0, unknown: 0, pass: 0, 'not-applicable': 0, errors: 0 };
  for (const i of group.inspections) {
    tally.ms += i.ms;
    for (const c of i.checks ?? []) {
      tally.checks++;
      tally[c.verdict]++;
    }
  }
  tally.errors = group.findings.filter(f => f.type === 'plugin_error').length;
  return tally;
}

/**
 * Something on the state needs a look: a check failed, a plugin erred, or a problem was reported
 * there (new or seen before). An undecided check alone is common (evidence a rule cannot read) and
 * is not counted.
 */
export const hasProblems = (group: StateChecks) => {
  const t = checkTally(group);
  return t.fail > 0 || t.errors > 0 || group.findings.length > 0 || group.inspections.some(i => i.repeated?.length);
};

/** One line in the action tree for everything plugins checked on a state. */
export function ChecksRowBody({ group }: { group: StateChecks }) {
  const t = checkTally(group);
  const repeated = group.inspections.reduce((n, i) => n + (i.repeated?.length ?? 0), 0);
  const found = group.findings.filter(f => f.type === 'finding').length;
  const bad = hasProblems(group);
  const Icon = bad ? ShieldAlert : ShieldCheck;
  return (
    <>
      <Icon className={cn('size-3 shrink-0', bad ? 'text-destructive' : 'text-muted-foreground')} />
      <span className="shrink-0">{t.checks ? `检查 ${t.checks} 条` : '检查'}</span>
      <span className="flex min-w-0 items-center gap-1.5 truncate tabular-nums">
        {t.pass > 0 && <span className="text-success">✓{t.pass}</span>}
        {t.fail > 0 && <span className="text-destructive">✗{t.fail}</span>}
        {t.unknown > 0 && <span>?{t.unknown}</span>}
        {t.errors > 0 && <span className="text-destructive">出错 {t.errors}</span>}
        {found > 0 && <span className="text-destructive">新问题 {found}</span>}
        {repeated > 0 && <span>重复 {repeated}</span>}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 tabular-nums">
        <span>{span(t.ms)}</span>
        <Time ms={group.at} className="w-11 text-right" />
      </span>
    </>
  );
}

/** Everything plugins checked on one state: per check its verdict and time, and what failing ones found. */
export function ChecksDetail({
  runId,
  tree,
  group,
  onSelect,
}: {
  runId: string;
  tree: ActionTree;
  group: StateChecks;
  onSelect: (seq: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<number>();
  const t = checkTally(group);
  const problems = stateFindings(tree, group);
  // Problems further down the page were measured on a picture of their own; the rest on the state's.
  const pictures = [undefined, ...new Set(problems.flatMap(p => (p.target?.shot ? [p.target.shot] : [])))];
  const marksOn = (shot: string | undefined) =>
    problems.flatMap(p =>
      p.target && p.target.shot === shot ? [{ ...p.target, key: p.n, label: String(p.n), active: active === p.n }] : [],
    );
  const placed = problems.filter(p => p.target).length;
  const sweep = group.sweep;
  const capture = group.inspections.reduce((n, i) => n + (i.captureMs ?? 0), 0);
  const targets = Math.max(0, ...group.inspections.flatMap(i => (i.checks ?? []).map(c => c.targets)));
  const errors = group.findings.filter(f => f.type === 'plugin_error');
  const node = group.node;
  return (
    <div className="flex flex-col gap-4 rounded-lg border bg-card p-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {hasProblems(group) ? (
            <ShieldAlert className="size-4 text-destructive" />
          ) : (
            <ShieldCheck className="size-4 text-success" />
          )}
          <span className="font-medium">状态检查</span>
          <span className="text-sm text-muted-foreground">
            {node ? (
              <>
                在{' '}
                <button
                  type="button"
                  className="underline-offset-4 hover:underline"
                  onClick={() => onSelect(node.event.seq)}
                >
                  #{node.index} {kindText[node.event.step.kind] ?? node.event.step.kind}「
                  {node.event.step.label.slice(0, 24) || '未命名'}」
                </button>{' '}
                之后
              </>
            ) : (
              '入口页'
            )}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            耗时 <b className="text-foreground">{span(t.ms)}</b>
            {capture > 0 && `（采集 ${span(capture)}，规则 ${span(Math.max(0, t.ms - capture))}）`}
          </span>
          {t.checks > 0 && (
            <span>
              {t.checks} 条规则：
              {verdictOrder
                .filter(v => t[v])
                .map(v => `${checkVerdictText[v]} ${t[v]}`)
                .join('，')}
            </span>
          )}
          {targets > 0 && <span>最多检查 {targets} 个对象</span>}
          {sweep && <SweepSummary sweep={sweep} />}
          <Time ms={group.at} />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className={cn('grid gap-2', pictures.length > 1 && 'grid-cols-2')}>
          {pictures.map(shot => (
            <div key={shot ?? 'state'} className="flex min-w-0 flex-col gap-1">
              {pictures.length > 1 && (
                <span className="text-xs text-muted-foreground">{shot ? '往下滚动后' : '页面顶部'}</span>
              )}
              <Screenshot
                runId={runId}
                state={shot ?? group.state}
                label={shot ? '滚动后检查的位置' : '检查的状态'}
                marks={marksOn(shot)}
              />
            </div>
          ))}
        </div>
        {problems.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {placed === problems.length
              ? '红框是发现问题的元素，编号与下面的问题对应；点问题可以突出它的框。'
              : placed
                ? `红框是发现问题的元素，编号与下面的问题对应。有 ${problems.length - placed} 个问题没有位置（较早的运行，或元素没有尺寸）。`
                : '这些问题没有记录位置（较早的运行），无法在截图上标出。'}
          </p>
        )}
      </div>

      {errors.length > 0 && (
        <Section title="插件出错">
          <ul className="flex flex-col gap-1 text-xs text-destructive">
            {errors.map(e => (
              <li key={e.seq} className="break-all">
                <Kind className="mr-1.5">{pluginText[e.plugin] ?? e.plugin}</Kind>
                {e.error}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {t.checks > searchFrom && (
        <Input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="按规则名或 id 筛选"
          className="h-8 text-sm"
        />
      )}

      {group.inspections.map(i => (
        <PluginChecks
          key={i.seq}
          runId={runId}
          tree={tree}
          plugin={i.plugin}
          checks={i.checks ?? []}
          problems={problems.filter(p => p.event.plugin === i.plugin)}
          active={active}
          onActivate={n => setActive(prev => (prev === n ? undefined : n))}
          multiple={group.inspections.length > 1}
          ms={i.ms}
          query={query.trim().toLowerCase()}
          onSelect={onSelect}
        />
      ))}
      {!group.inspections.length && (
        <p className="text-xs text-muted-foreground">这次运行没有记录检查摘要（较早的运行），只有发现的问题。</p>
      )}
    </div>
  );
}

function PluginChecks({
  runId,
  tree,
  plugin,
  checks,
  problems,
  active,
  onActivate,
  multiple,
  ms,
  query,
  onSelect,
}: {
  runId: string;
  tree: ActionTree;
  plugin: string;
  checks: CheckSummary[];
  problems: StateFinding[];
  active?: number;
  onActivate: (n: number) => void;
  multiple: boolean;
  ms: number;
  query: string;
  onSelect: (seq: number) => void;
}) {
  const name = (id: string) => tree.checkNames.get(`${plugin}/${id}`);
  const shown = checks.filter(
    c => !query || c.id.toLowerCase().includes(query) || name(c.id)?.name.toLowerCase().includes(query),
  );
  const found = (id: string) => problems.filter(p => p.event.finding.rule === id);
  // Failing and undecided checks open; the passing and inapplicable ones fold into one line each.
  const byVerdict = (v: Verdict) => shown.filter(c => c.verdict === v);
  const row = (c: CheckSummary) => (
    <CheckRow
      key={c.id}
      runId={runId}
      tree={tree}
      plugin={plugin}
      check={c}
      info={name(c.id)}
      problems={found(c.id)}
      active={active}
      onActivate={onActivate}
      onSelect={onSelect}
    />
  );
  const folded = (v: Verdict) => {
    const list = byVerdict(v);
    if (!list.length) return null;
    return (
      <Disclosure
        summary={
          <span>
            {checkVerdictText[v]}（{list.length}）
          </span>
        }
      >
        <ul className="flex flex-col divide-y rounded-md border">{list.map(row)}</ul>
      </Disclosure>
    );
  };
  const open = [...byVerdict('fail'), ...byVerdict('unknown')];
  // Named checks the plugin left out of the summary had nothing to check on this state.
  const idle = [...tree.checkNames]
    .filter(([key, info]) => key === `${plugin}/${info.id}` && !checks.some(c => c.id === info.id))
    .map(([, info]) => info)
    .filter(info => !query || info.id.toLowerCase().includes(query) || info.name.toLowerCase().includes(query));
  // Findings from a check that is not in the summary (a plugin reporting findings only).
  const loose = problems.filter(p => !checks.some(c => c.id === p.event.finding.rule));
  return (
    <Section
      title={multiple || plugin !== 'rules' ? (pluginText[plugin] ?? plugin) : '规则'}
      aside={<span className="font-normal tabular-nums">{span(ms)}</span>}
    >
      {open.length > 0 && <ul className="flex flex-col divide-y rounded-md border">{open.map(row)}</ul>}
      {folded('pass')}
      {folded('not-applicable')}
      {idle.length > 0 && (
        <Disclosure summary={<span>这个状态上没有可检查的对象（{idle.length}）</span>}>
          <ul className="flex flex-wrap gap-1 pl-4">
            {idle.map(info => (
              <li key={info.id}>
                <Badge variant="outline" className="font-normal text-muted-foreground" title={info.description}>
                  {info.name}
                </Badge>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      {loose.length > 0 && (
        <ul className="flex flex-col divide-y rounded-md border">
          {loose.map(p => (
            <FindingItem
              key={p.n}
              runId={runId}
              tree={tree}
              plugin={plugin}
              problem={p}
              active={active === p.n}
              onActivate={onActivate}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
      {query && !shown.length && <p className="text-xs text-muted-foreground">没有匹配的规则。</p>}
    </Section>
  );
}

function CheckRow({
  runId,
  tree,
  plugin,
  check: c,
  info,
  problems,
  active,
  onActivate,
  onSelect,
}: {
  runId: string;
  tree: ActionTree;
  plugin: string;
  check: CheckSummary;
  info?: { name: string; description?: string };
  problems: StateFinding[];
  active?: number;
  onActivate: (n: number) => void;
  onSelect: (seq: number) => void;
}) {
  // Targets per verdict; a summary without counts had one verdict for all of them.
  const count = (v: Verdict) => c.counts?.[v] ?? (c.counts ? 0 : c.verdict === v ? c.targets : 0);
  const lines = verdictOrder.filter(v => count(v) > 0);
  // The plugin's explanation; the code itself only on hover.
  const reason = (code: string) => tree.reasons.get(`${plugin}/${code}`);
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <Badge variant="outline" className={cn('shrink-0 px-1.5 py-0 text-[10px]', checkVerdictClass[c.verdict])}>
          {checkVerdictText[c.verdict]}
        </Badge>
        <span className="min-w-0 truncate text-sm">{info?.name ?? c.id}</span>
        {info?.description && <InfoTip>{info.description}</InfoTip>}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-muted-foreground tabular-nums">
          <span>{c.targets} 个对象</span>
          <span className="w-10 text-right">{span(c.ms)}</span>
        </span>
      </div>
      {lines.length > 0 && (lines.length > 1 || c.codes?.length) && (
        <ul className="flex flex-col gap-0.5 text-muted-foreground">
          {lines.map(v => {
            const codes = (c.codes ?? []).filter(r => r.verdict === v);
            return (
              <li key={v} className="flex min-w-0 flex-wrap gap-x-2">
                <span className={cn('shrink-0', v === 'fail' && 'text-destructive')}>
                  {checkVerdictText[v]} {count(v)}
                  {codes.length > 0 && '：'}
                </span>
                {codes.map((r, n) => (
                  <span key={r.code} title={r.code}>
                    {reason(r.code) ?? <span className="font-mono">{r.code}</span>}
                    {codes.length > 1 && <span className="tabular-nums"> {r.count}</span>}
                    {n < codes.length - 1 && '；'}
                  </span>
                ))}
              </li>
            );
          })}
        </ul>
      )}
      {problems.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">发现的问题</span>
          <ul className="flex flex-col gap-1">
            {problems.map(p => (
              <FindingItem
                key={p.n}
                runId={runId}
                tree={tree}
                plugin={plugin}
                problem={p}
                active={active === p.n}
                onActivate={onActivate}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </div>
      )}
      {c.verdict === 'fail' && !problems.length && (
        <p className="text-muted-foreground">未通过但没有报告问题：这条规则的结果只是提示级别。</p>
      )}
    </li>
  );
}

/**
 * A problem under its check: its number on the screenshot, severity, the element and the
 * plugin's explanation. Clicking it highlights its box; the raw detail and evidence open on demand.
 */
function FindingItem({
  runId,
  tree,
  plugin,
  problem: { event: f, earlier, target, n },
  active,
  onActivate,
  onSelect,
}: {
  runId: string;
  tree: ActionTree;
  plugin: string;
  problem: StateFinding;
  active: boolean;
  onActivate: (n: number) => void;
  onSelect: (seq: number) => void;
}) {
  const via = earlier ? actionBefore(tree, f.seq) : undefined;
  // Older runs carry the code only at the start of the detail.
  const code = f.finding.code ?? /^([A-Z][A-Z0-9_]+):/.exec(f.finding.detail)?.[1];
  const reason = code && tree.reasons.get(`${plugin}/${code}`);
  return (
    <li
      className={cn(
        'flex min-w-0 flex-col gap-1 rounded-md border px-2 py-1.5',
        active ? 'border-rose-500/60 bg-rose-500/5' : 'border-transparent',
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => onActivate(n)}
          aria-pressed={active}
          className="flex min-w-0 items-center gap-1.5 text-left"
          title={target ? '在截图上突出它的框' : '这个问题没有记录位置'}
        >
          <span
            className={cn(
              'flex h-4 min-w-4 shrink-0 items-center justify-center rounded-sm px-1 text-[10px] font-medium text-white tabular-nums',
              target ? 'bg-rose-500' : 'bg-muted-foreground/50',
            )}
          >
            {n}
          </span>
          <span className={cn('shrink-0', f.finding.severity === 'error' ? 'text-destructive' : 'text-warning')}>
            {severityText[f.finding.severity]}
          </span>
          <span className="min-w-0 truncate text-foreground">{f.finding.text || f.finding.selector}</span>
        </button>
        {earlier && (
          <span className="ml-auto shrink-0 text-muted-foreground">
            此前已在
            {via ? (
              <button
                type="button"
                className="mx-0.5 underline-offset-4 hover:underline"
                onClick={() => onSelect(via.event.seq)}
              >
                #{via.index} 之后
              </button>
            ) : (
              '入口页'
            )}
            报告
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1 pl-5.5 text-muted-foreground">
        {reason && <span title={code}>{reason}</span>}
        {f.finding.selector && <code className="font-mono break-all">{f.finding.selector}</code>}
        <Disclosure summary="原始证据" className="text-[11px]">
          <RawEvidence runId={runId} finding={f} />
        </Disclosure>
      </div>
    </li>
  );
}

/** A finding's detail as the plugin wrote it and its evidence, fetched when first shown. */
function RawEvidence({ runId, finding: f }: { runId: string; finding: FindingEvent }) {
  const [facts, setFacts] = useState<unknown>();
  useEffect(() => {
    let live = true;
    call<FindingEvent & { finding: { facts?: unknown } }>(`/v1/crawls/${runId}/debug/events/${f.seq}`)
      .then(full => live && setFacts(full.finding?.facts ?? null))
      .catch(e => live && setFacts({ error: String((e as Error).message) }));
    return () => {
      live = false;
    };
  }, [runId, f.seq]);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="break-all">{f.finding.detail}</p>
      {facts === undefined ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Json value={facts ?? '这条结果没有附带证据。'} />
      )}
    </div>
  );
}

const sweepEndText: Record<SweepEvent['surfaces'][number]['end'], string> = {
  end: '到底',
  endless: '无限加载，已停止',
  repeats: '后面都是同类内容，按列表抽样',
  budget: '达到上限',
};

/** How far the crawler scrolled this state: the page and each scrolling container, and how each ended. */
function SweepSummary({ sweep }: { sweep: SweepEvent }) {
  const screens = sweep.surfaces.reduce((n, s) => n + s.screens, 0);
  return (
    <Hint
      tip={
        <ul className="flex flex-col gap-0.5">
          {sweep.surfaces.map(s => (
            <li key={s.surface}>
              {s.surface === 'page' ? '页面' : `容器 ${s.surface}`}：{s.screens} 屏，{sweepEndText[s.end]}
              {s.ms !== undefined && `，${span(s.ms)}，新出现 ${s.revealed} 个控件（新类型 ${s.newClasses}）`}
            </li>
          ))}
          {sweep.skipped?.map(s => (
            <li key={s}>{s === 'page' ? '页面' : `容器 ${s}`}：和之前滚动时一样，没有再滚动</li>
          ))}
          <li>
            滚动后新出现 {sweep.revealed} 个控件，用时 {span(sweep.ms)}
          </li>
        </ul>
      }
      className={cn(sweep.surfaces.some(s => s.end === 'endless') && 'text-warning')}
    >
      {screens ? `滚动查看了 ${screens} 屏` : '下方无变化，未再滚动'}
      {sweep.surfaces.some(s => s.end === 'endless') && '（含无限加载）'}
    </Hint>
  );
}

/** Shown in an action's detail: a link to the checks on the state it led to. */
export function ChecksLink({ groups, onOpen }: { groups: StateChecks[]; onOpen: (state: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {groups.map(g => {
        const t = checkTally(g);
        return (
          <Button
            key={g.state}
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => onOpen(g.state)}
          >
            {hasProblems(g) ? (
              <ShieldAlert className="size-3.5 text-destructive" />
            ) : (
              <ShieldCheck className="size-3.5 text-success" />
            )}
            {t.checks ? `${t.checks} 条规则` : '检查'}
            {t.fail > 0 && <span className="text-destructive">✗{t.fail}</span>}
            <span className="text-muted-foreground">{span(t.ms)}</span>
          </Button>
        );
      })}
    </div>
  );
}
