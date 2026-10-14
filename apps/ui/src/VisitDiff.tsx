import { useEffect, useState } from 'react';
import type { InteractionClient } from '@interaction/client';
import type { ActionAttempt, Diff, Visit } from '@interaction/browser';

type Comparison = { attempt?: ActionAttempt; diff?: Diff; beforeId: string; afterId?: string };
type Loaded = { key: string; comparison?: Comparison; error?: string };
const fromAttempt = (attempt: ActionAttempt): Comparison => ({ attempt, diff: attempt.diff, beforeId: attempt.beforeId, afterId: attempt.afterId });

/** One visit owns both the comparison and its images, including repeated states. */
export function VisitDiff({ api, sessionId, visit, parentObservationId, attempt, statusText }: {
  api: InteractionClient; sessionId: string; visit?: Visit; parentObservationId?: string;
  attempt?: ActionAttempt; statusText: Record<string, string>;
}) {
  const [loaded, setLoaded] = useState<Loaded>();
  const key = `${sessionId}:${visit?.id}:${parentObservationId || ''}`;
  useEffect(() => {
    if (!visit || attempt || !visit.viaAttemptId && !parentObservationId) return;
    let cancelled = false;
    async function load(): Promise<Comparison> {
      if (visit!.viaAttemptId) {
        // The main dashboard loads only the first page of attempts. Historical
        // visits beyond that page must still resolve their own action.
        for (let offset = 0; ; ) {
          const page = await api.list<ActionAttempt>(sessionId, 'attempts', { offset, limit: 1000 });
          if (cancelled) throw new Error('Selection changed');
          const found = page.items.find(a => a.id === visit!.viaAttemptId);
          if (found) return fromAttempt(found);
          offset += page.items.length;
          if (!page.items.length || offset >= page.total) break;
        }
        throw new Error('未找到所选步骤的操作记录。');
      }
      const query = new URLSearchParams({ before: parentObservationId!, after: visit!.observationId });
      const diff = await api.request<Diff>(`/sessions/${encodeURIComponent(sessionId)}/compare?${query}`);
      return { diff, beforeId: parentObservationId!, afterId: visit!.observationId };
    }
    void load().then(comparison => { if (!cancelled) setLoaded({ key, comparison }); }, error => { if (!cancelled) setLoaded({ key, error: String(error) }); });
    return () => { cancelled = true; };
  }, [api, sessionId, visit?.id, visit?.viaAttemptId, visit?.observationId, parentObservationId, attempt, key]);

  if (!visit) return <div className="empty">请选择或等待加载一条访问记录。</div>;
  if (!visit.viaAttemptId && !parentObservationId) return <div className="empty">入口观察没有前一步，暂无可比较的差异。</div>;
  const result = loaded?.key === key ? loaded : undefined;
  const comparison = attempt ? fromAttempt(attempt) : result?.comparison;
  if (!comparison) return <div className="empty" role={result?.error ? 'alert' : 'status'}>{result?.error || '正在加载所选步骤的差异…'}</div>;
  const action = comparison.attempt;
  return <div data-testid="visit-diff" data-visit-id={visit.id}>
    <div className="diff-title"><b>{action ? action.action.label || '未命名操作' : '补充观察'}</b>{action && <><span className={`badge ${action.status}`}>{statusText[action.status]}</span><span>{action.reason}</span></>}</div>
    {!action && <p className="muted">与该访问记录的父观察比较；期间变化不归因于某次操作。</p>}
    <div className="compare-images">
      <figure><img alt="操作前" src={`/v1/sessions/${sessionId}/evidence/${comparison.beforeId}`} /><figcaption>{action ? '操作前' : '父观察'}</figcaption></figure>
      {comparison.afterId && <figure><img alt="操作后" src={`/v1/sessions/${sessionId}/evidence/${comparison.afterId}`} /><figcaption>{action ? '操作后' : '所选观察'}</figcaption></figure>}
    </div>
    {comparison.diff ? <pre>{JSON.stringify(comparison.diff, null, 2)}</pre> : <div className="empty">此步骤尚未获得可比较的结果。{action?.reason}</div>}
  </div>;
}
