import type { Task } from './types.js';

type ClockTask = Pick<Task, 'usage' | 'activeSince' | 'pauseRequestedAt' | 'updatedAt' | 'durationUncertainty'>;
/** A persisted activity proves the runner was alive then, not when it later
 * stopped or whether an in-flight operation succeeded. Never charge downtime. */
export function settleInterruptedClock(task: ClockTask, recoveredAt: number, activity: { source: string; at: number }[], missingActiveWindow = false) {
  const startedAt = task.activeSince;
  if (startedAt === undefined && !missingActiveWindow) { delete task.pauseRequestedAt; return; }
  const evidence = [
    { source: 'task.updatedAt', at: Date.parse(task.updatedAt) },
    ...(task.pauseRequestedAt === undefined ? [] : [{ source: 'pauseRequestedAt', at: task.pauseRequestedAt }]),
    ...activity
  ];
  const validStart = typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt >= 0 && startedAt <= recoveredAt;
  const valid = evidence.filter(item => Number.isFinite(item.at) && validStart && item.at >= startedAt! && item.at <= recoveredAt);
  const observedThrough = valid.reduce<{ source: string; at: number } | undefined>((last, item) => !last || item.at > last.at ? item : last, undefined);
  const invalidClockEvidence = evidence.filter(item => !Number.isFinite(item.at) || item.at > recoveredAt).map(item => item.source);
  const countedMs = validStart ? Math.max(0, (observedThrough?.at ?? startedAt!) - startedAt!) : 0;
  // This is only an upper bound on unmeasured activity, not elapsed usage: the
  // interval includes an unknown amount of downtime. Clock anomalies are unbounded.
  const upperBoundMs = validStart && !invalidClockEvidence.length ? Math.max(0, recoveredAt - (observedThrough?.at ?? startedAt!)) : null;
  task.usage.durationMs += countedMs;
  const previous = task.durationUncertainty;
  task.durationUncertainty = {
    interruptions: (previous?.interruptions ?? 0) + 1,
    additionalMsUpperBound: previous?.additionalMsUpperBound === null || upperBoundMs === null ? null : (previous?.additionalMsUpperBound ?? 0) + upperBoundMs,
    budgetBasis: 'persisted-activity-lower-bound'
  };
  delete task.activeSince; delete task.pauseRequestedAt;
  return { startedAt, missingActiveSince: startedAt === undefined, recoveredAt, observedThrough, countedMs, unmeasuredMs: { lowerBound: 0, upperBound: upperBoundMs }, invalidClockEvidence,
    budgetBasis: 'persisted-activity-lower-bound', exactStopTimeKnown: false, operationOutcomeInferred: false };
}
