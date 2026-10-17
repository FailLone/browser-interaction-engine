import { expect, it, vi } from 'vitest';
import { observeRecoveryCall, type AcceptanceRecoveryApi } from '../scripts/okx-storage-acceptance.js';

const apis: AcceptanceRecoveryApi[] = ['reachCheckpoint', 'reachExplorationTarget', 'reachControlReviewTarget', 'returnToObservedSource'];
const successful = { reachCheckpoint: 'REACHED_VERIFIED', reachExplorationTarget: 'TARGET_REACHED', reachControlReviewTarget: 'CURRENT_REVIEWABLE', returnToObservedSource: 'SOURCE_REACHED' };

it.each(apis)('%s records a returned success without changing its result or requesting stop', async api => {
  const result = { status: successful[api], attemptIds: ['actual-recovery-attempt'], checkpointVerified: api === 'reachCheckpoint' };
  const report = vi.fn(), stop = vi.fn(), clock = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(145);
  await expect(observeRecoveryCall(api, 'session', async () => result, report, stop, clock)).resolves.toBe(result);
  expect(report.mock.calls).toEqual([[{ outcome: 'returned', api, sessionId: 'session', elapsedMs: 45, result }]]);
  expect(stop).not.toHaveBeenCalled();
});

it.each(apis)('%s retains the existing non-success result guard', async api => {
  const result = { status: 'UNVERIFIED', attemptIds: ['unknown-recovery-attempt'], reason: 'unknown_execution_outcome' };
  const order: string[] = [], report = vi.fn((_row: unknown) => order.push('report')), stop = vi.fn((_reason: string, _details: unknown) => order.push('stop'));
  await expect(observeRecoveryCall(api, 'session', async () => result, report, stop)).resolves.toBe(result);
  expect(order).toEqual(['report', 'stop']);
  expect(report.mock.calls[0][0]).toMatchObject({ outcome: 'returned', result });
  expect(stop).toHaveBeenCalledExactlyOnceWith('recovery_not_verified', { api, sessionId: 'session', result });
});

it.each(apis)('%s records a retryable exception and stops before rethrowing the same object', async api => {
  const error = Object.assign(new Error('Browser cursor changed'), { code: 'STALE_OBSERVATION' });
  const order: string[] = [], reports: unknown[] = [], stops: unknown[] = [];
  const clock = vi.fn().mockReturnValueOnce(200).mockReturnValueOnce(275);
  const invoke = api === 'reachCheckpoint' ? () => { throw error; } : async () => { throw error; };
  const call = observeRecoveryCall(api, 'session', invoke,
    row => { reports.push(row); order.push('report'); },
    (reason, details) => { stops.push({ reason, details }); order.push('stop'); }, clock);
  await expect(call.catch(caught => { order.push('caller'); throw caught; })).rejects.toBe(error);
  const failure = { outcome: 'threw', api, sessionId: 'session', elapsedMs: 75, code: 'STALE_OBSERVATION' };
  expect(reports).toEqual([failure]);
  expect(stops).toEqual([{ reason: 'recovery_failed', details: failure }]);
  expect(order).toEqual(['report', 'stop', 'caller']);
  expect(failure).not.toHaveProperty('status');
  expect(failure).not.toHaveProperty('attemptIds');
});

it('still requests stop and preserves the SDK error if diagnostic reporting fails', async () => {
  const original = Object.assign(new Error('Original SDK error'), { code: 'PRECONDITIONS_CHANGED' }), stop = vi.fn();
  await expect(observeRecoveryCall('returnToObservedSource', 'session', async () => { throw original; },
    () => { throw new Error('diagnostic failure'); }, stop)).rejects.toBe(original);
  expect(stop).toHaveBeenCalledWith('recovery_failed', expect.objectContaining({ outcome: 'threw', code: 'PRECONDITIONS_CHANGED' }));
});
