import { useState } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Empty, Json, Kind, Screenshot, Time } from './common.js';
import { call, kindText, pluginText, severityText } from './text.js';
import { type ActionTree, actionBefore, pathTo } from './tree.js';
import type { FindingEvent, PluginErrorEvent } from './types.js';

export const severityClass: Record<string, string> = {
  info: 'text-muted-foreground',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
};

/** Plugin findings, each with the action that reached the state it was found in. */
export function FindingsView({
  runId,
  findings,
  tree,
  onSelectAction,
}: {
  runId: string;
  findings: (FindingEvent | PluginErrorEvent)[];
  tree: ActionTree;
  onSelectAction: (seq: number) => void;
}) {
  const [open, setOpen] = useState<number>();
  if (!findings.length) return <Empty>还没有发现问题。</Empty>;
  return (
    <ol className="flex flex-col divide-y rounded-lg border">
      {findings.map(f => {
        const expanded = open === f.seq;
        return (
          <li key={f.seq}>
            <button
              type="button"
              onClick={() => setOpen(expanded ? undefined : f.seq)}
              className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
            >
              <ChevronRight
                className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')}
              />
              <Time ms={f.at} className="w-11" />
              <Kind>{pluginText[f.plugin] ?? f.plugin}</Kind>
              {f.type === 'finding' ? (
                <>
                  <Badge variant="outline" className={severityClass[f.finding.severity]}>
                    {severityText[f.finding.severity]} · {f.finding.rule}
                  </Badge>
                  <span className="min-w-0 truncate text-muted-foreground">{f.finding.text || f.finding.selector}</span>
                </>
              ) : (
                <span className="min-w-0 truncate text-destructive">插件出错：{f.error}</span>
              )}
            </button>
            {expanded && <FindingDetail runId={runId} finding={f} tree={tree} onSelectAction={onSelectAction} />}
          </li>
        );
      })}
    </ol>
  );
}

function FindingDetail({
  runId,
  finding: f,
  tree,
  onSelectAction,
}: {
  runId: string;
  finding: FindingEvent | PluginErrorEvent;
  tree: ActionTree;
  onSelectAction: (seq: number) => void;
}) {
  const [facts, setFacts] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const via = actionBefore(tree, f.seq);
  const path = via ? pathTo(via) : [];
  const loadFacts = async () => {
    setLoading(true);
    try {
      const full = await call<FindingEvent & { finding: { facts?: unknown } }>(
        `/v1/crawls/${runId}/debug/events/${f.seq}`,
      );
      setFacts(full.finding?.facts ?? null);
    } catch (e) {
      setFacts({ error: String((e as Error).message) });
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="grid gap-4 border-t bg-muted/20 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
      <div className="flex min-w-0 flex-col gap-3 text-sm">
        {f.type === 'finding' ? (
          <>
            <p className="break-all">{f.finding.detail}</p>
            {f.finding.selector && (
              <code className="font-mono text-xs break-all text-muted-foreground">{f.finding.selector}</code>
            )}
          </>
        ) : (
          <p className="break-all text-destructive">{f.error}</p>
        )}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">怎么到的这个状态</span>
          {via ? (
            <ol className="flex flex-wrap items-center gap-1 text-xs">
              <li className="text-muted-foreground">入口页</li>
              {path.map(p => (
                <li key={p.event.seq} className="flex items-center gap-1">
                  <ChevronRight className="size-3 text-muted-foreground" />
                  <button
                    type="button"
                    onClick={() => onSelectAction(p.event.seq)}
                    className="max-w-48 truncate rounded px-1 py-0.5 hover:bg-accent"
                  >
                    #{p.index} {kindText[p.event.step.kind] ?? p.event.step.kind} {p.event.step.label || '未命名'}
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <span className="text-xs text-muted-foreground">打开页面时就有，不需要任何动作。</span>
          )}
        </div>
        {f.type === 'finding' &&
          (facts === undefined ? (
            <Button variant="outline" size="sm" className="w-fit" onClick={loadFacts} disabled={loading}>
              {loading && <Loader2 className="animate-spin" />}
              加载规则证据
            </Button>
          ) : (
            <Json value={facts ?? '这条结果没有附带证据。'} />
          ))}
      </div>
      <Screenshot runId={runId} state={f.state} label={f.type === 'finding' ? f.finding.rule : '插件出错时的状态'} />
    </div>
  );
}
