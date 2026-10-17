// Diagnostic entry only. The runner copies the existing epoch worker into the
// owned archive, with two explicitly recorded diagnostic-only stage additions.
import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const started = performance.now();
let sequence = 0;
const counts: Record<string, number> = {};
(globalThis as any).__bieRecoveryDiagnostic = (kind: string, data: unknown) => {
  counts[kind] = (counts[kind] ?? 0) + 1;
  writeSync(1, JSON.stringify({ event: 'diagnostic', sequence: ++sequence,
    elapsedMs: performance.now() - started, kind, data }) + '\n');
};
await import('./base-worker.ts');
(globalThis as any).__bieRecoveryDiagnostic('terminal', { counts,
  timingUse: 'Diagnostic bound only; extra explanatory projections and checkpoint strategy queries prohibit a performance comparison.' });
