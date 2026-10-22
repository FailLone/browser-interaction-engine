import { z } from 'zod';
import { asJson, defineSentinelRule, exempt, pass, rectSchema, review, unknown } from './core.js';

export const continuityEvidenceSchema = z
  .object({
    sameTarget: z.boolean(),
    complete: z.boolean(),
    intendedReflow: z.boolean(),
    userInitiatedMotion: z.boolean(),
    reducedMotion: z.boolean(),
    samples: z
      .array(
        z
          .object({
            at: z.string().datetime({ offset: true }),
            contentKey: z.string().min(1),
            breakpoint: z.string().min(1),
            rect: rectSchema,
            scroll: z.object({ x: z.number(), y: z.number() }).strict(),
            visible: z.boolean(),
            moving: z.boolean(),
          })
          .strict(),
      )
      .min(2)
      .max(500),
  })
  .strict();
export const continuityRule = defineSentinelRule(
  {
    id: 'UIK-R008',
    name: '过渡位置与动效审查',
    kind: 'review',
    moving: true,
    description: '跟踪同一目标在过渡中的定位线索，区分真实内容变化、有意重排和动效偏好。',
  },
  continuityEvidenceSchema,
  (c, d) => {
    if (
      !d.sameTarget ||
      !d.complete ||
      Date.parse(d.samples.at(-1)!.at) !== Date.parse(c.page.capture.capturedAt) ||
      d.samples.some((s, i) => i > 0 && Date.parse(s.at) <= Date.parse(d.samples[i - 1].at))
    )
      return unknown('A complete, ordered same-target timeline ending at this capture is required');
    if (d.intendedReflow || d.userInitiatedMotion)
      return exempt('The movement is an explained reflow or user-initiated animation');
    if (!d.samples.some(s => s.visible)) return unknown('The target was not visible in any recorded sample');
    const first = d.samples[0];
    if (d.samples.some(s => s.contentKey !== first.contentKey || s.breakpoint !== first.breakpoint))
      return unknown('Content or breakpoint changed; establish whether the movement was necessary');
    const moved = d.samples.some(
      s =>
        Math.abs(s.rect.x + s.scroll.x - first.rect.x - first.scroll.x) > 1 ||
        Math.abs(s.rect.y + s.scroll.y - first.rect.y - first.scroll.y) > 1,
    );
    const blinked = d.samples.some(s => s.visible !== first.visible);
    const motionConflict = d.reducedMotion && d.samples.some(s => s.moving);
    const facts = { moved, blinked, motionConflict, samples: asJson(d.samples) };
    return moved || blinked || motionConflict
      ? review('The unchanged task has observed movement, visibility changes or motion-preference concerns', facts)
      : pass('The observed timeline preserves location and visibility without conflicting motion', facts);
  },
);
