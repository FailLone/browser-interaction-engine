import { z } from 'zod';
import { asJson, contains, defineSentinelRule, exempt, fail, pass, rectSchema, unknown } from './core.js';

export const reachabilityEvidenceSchema = z
  .object({
    allowed: z.boolean(),
    viewportChanged: z.boolean(),
    supportedViewport: z.boolean(),
    requiredPaths: z.array(z.string().min(1)).min(1).max(100),
    paths: z
      .array(
        z
          .object({
            id: z.string().min(1),
            exhausted: z.boolean(),
            /** The host records every available path; the plugin never scrolls. */
            samples: z
              .array(
                z
                  .object({
                    viewport: rectSchema,
                    target: rectSchema,
                    operable: z.boolean().optional(),
                  })
                  .strict(),
              )
              .min(1)
              .max(100),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const reachabilityRule = defineSentinelRule(
  {
    id: 'UIK-D003',
    name: '视口变化后的操作可达性',
    kind: 'defect',
    offscreen: true,
    description: '必要操作在支持的视口变化后，经所有可用滚动路径仍应可辨认并操作。',
  },
  reachabilityEvidenceSchema,
  (_c, d) => {
    if (!d.allowed || !d.viewportChanged || !d.supportedViewport)
      return exempt('The operation is not allowed or the supported viewport-change trigger is absent');
    if (
      new Set(d.requiredPaths).size !== d.requiredPaths.length ||
      new Set(d.paths.map(p => p.id)).size !== d.paths.length
    )
      return unknown('Scroll paths are ambiguous');
    const samples = d.paths.flatMap(p => p.samples);
    if (samples.some(s => !s.target.width || !s.target.height || !s.viewport.width || !s.viewport.height))
      return unknown('A collapsed target or viewport cannot establish viewport unreachability');
    const reached = samples.some(s => contains(s.viewport, s.target, 1) && s.operable === true);
    const facts = { paths: asJson(d.paths), requiredPaths: d.requiredPaths };
    if (reached) return pass('A recorded scroll path reaches the complete, operable target', facts);
    if (d.requiredPaths.some(id => !d.paths.some(p => p.id === id && p.exhausted)))
      return unknown(
        'Not every available scroll path was exhausted; a static off-screen position is insufficient',
        facts,
      );
    // Being on-screen but unclickable is an occlusion/interaction question, not viewport loss.
    if (samples.some(s => contains(s.viewport, s.target, 1)))
      return unknown('The target can be shown; its operability needs separate evidence', facts);
    return fail('After all declared available scroll paths, the necessary target still cannot be fully shown', facts);
  },
);
