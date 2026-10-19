import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Empty, Screenshot, Time } from './common.js';
import type { Event } from './types.js';

type StateEvent = Extract<Event, { type: 'state' }>;

/** New states in discovery order; the screenshot loads only for the selected one. */
export function StatesView({ runId, states }: { runId: string; states: StateEvent[] }) {
  const [selected, setSelected] = useState<string>();
  if (!states.length) return <Empty>还没有状态。</Empty>;
  const current = states.find(s => s.state.key === selected) ?? states[0];
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <ol className="flex max-h-[70vh] flex-col gap-0.5 overflow-y-auto rounded-lg border p-1.5">
        {states.map((e, i) => (
          <li key={e.seq}>
            <button
              type="button"
              onClick={() => setSelected(e.state.key)}
              className={cn(
                'flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent',
                current === e && 'bg-accent font-medium',
              )}
            >
              <span className="w-7 shrink-0 font-mono text-xs text-muted-foreground">{i + 1}</span>
              <Time ms={e.at} className="w-11" />
              <span className="min-w-0 flex-1 truncate">{e.state.overlay || '页面'}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{e.state.controls} 个控件</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="md:sticky md:top-4 md:self-start">
        <Screenshot
          key={current.state.key}
          runId={runId}
          state={current.state.key}
          label={current.state.overlay || '页面'}
        />
      </div>
    </div>
  );
}
