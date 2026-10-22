import { z } from 'zod';
import { asJson, defineSentinelRule, exempt, fail, pass, unknown } from './core.js';

export const transitionEvidenceSchema = z
  .object({
    operationId: z.string().min(1),
    attempt: z.string().min(1),
    complete: z.boolean(),
    samples: z
      .array(
        z
          .object({
            at: z.string().datetime({ offset: true }),
            operationId: z.string().min(1),
            attempt: z.string().min(1),
            phase: z.enum(['loading', 'closing', 'success', 'empty', 'failure']),
            feedback: z.enum(['loading', 'content', 'empty', 'failure', 'none']),
            feedbackOperationId: z.string().min(1),
            feedbackAttempt: z.string().min(1),
            previousResultMarked: z.boolean(),
            contentCount: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(2)
      .max(500),
  })
  .strict();
export const transientStateRule = defineSentinelRule(
  {
    id: 'UIK-D006',
    name: '过渡状态与终态反馈',
    kind: 'defect',
    moving: true,
    description: '同一轮操作仍在加载或关闭时，不把内部过渡误报为确定的失败或空结果。',
  },
  transitionEvidenceSchema,
  (c, d) => {
    const last = d.samples.at(-1)!;
    if (
      !d.complete ||
      Date.parse(last.at) !== Date.parse(c.page.capture.capturedAt) ||
      d.samples.some(
        (s, i) =>
          s.operationId !== d.operationId ||
          s.attempt !== d.attempt ||
          (i > 0 && Date.parse(s.at) <= Date.parse(d.samples[i - 1].at)),
      )
    )
      return unknown(
        'A complete, ordered timeline ending at this capture for the same operation and attempt is required',
      );
    const active = d.samples.filter(s => s.phase === 'loading' || s.phase === 'closing');
    if (!active.length) return exempt('The recorded states are confirmed terminal results');
    const facts = { operationId: d.operationId, attempt: d.attempt, samples: asJson(d.samples) };
    for (const sample of active) {
      const same = sample.feedbackOperationId === d.operationId && sample.feedbackAttempt === d.attempt;
      if (!same && sample.previousResultMarked) continue;
      if (!same)
        return unknown(
          'Feedback cannot be associated with the current attempt or an explicitly marked previous result',
          facts,
        );
      if (sample.feedback !== 'empty' && sample.feedback !== 'failure') continue;
      if (
        sample.phase === 'closing' &&
        !d.samples.some(s => Date.parse(s.at) < Date.parse(sample.at) && s.contentCount > 0)
      )
        return unknown('Closing feedback needs evidence that nonempty content existed before internal cleanup', facts);
      return fail(
        'A recorded in-progress state presents a terminal empty/failure message for the current attempt',
        facts,
      );
    }
    return pass(
      'The recorded in-progress samples preserve content or accurately distinguish current and previous feedback',
      facts,
    );
  },
);
