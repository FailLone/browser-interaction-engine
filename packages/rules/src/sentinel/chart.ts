import { z } from 'zod';
import { asJson, defineSentinelRule, exempt, fail, pass, targetSchema, unknown } from './core.js';

export const chartEvidenceSchema = z
  .object({
    mappingsComplete: z.boolean(),
    alternativesChecked: z.boolean(),
    series: z
      .array(
        z
          .object({
            id: z.string().min(1),
            required: z.boolean(),
            identifiers: z
              .array(
                z
                  .object({
                    target: targetSchema,
                    identifies: z.string().min(1),
                    reachable: z.boolean(),
                    readable: z.boolean(),
                  })
                  .strict(),
              )
              .max(100),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    annotations: z
      .array(
        z
          .object({
            target: targetSchema,
            intendedSeries: z.string().min(1),
            observedSeries: z.string().min(1).optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const chartRule = defineSentinelRule(
  {
    id: 'UIK-D008',
    name: '图表系列与注释归属',
    kind: 'defect',
    description: '按可信系列身份检查可达标识和注释归属，不按固定颜色或相邻距离猜测。',
  },
  chartEvidenceSchema,
  (c, d) => {
    const ids = new Set(d.series.map(s => s.id));
    if (!d.mappingsComplete || ids.size !== d.series.length)
      return unknown('The series mapping is incomplete or ambiguous');
    if (d.series.length < 2 && !d.annotations.length)
      return exempt('A single series without reference annotations needs no redundant labeling');
    for (const series of d.series) for (const label of series.identifiers) c.resolve(label.target);
    for (const annotation of d.annotations) c.resolve(annotation.target);
    if (d.annotations.some(a => !ids.has(a.intendedSeries) || (a.observedSeries && !ids.has(a.observedSeries))))
      return unknown('An annotation refers to an object outside the verified series mapping');
    const wrong = d.annotations.filter(a => a.observedSeries && a.observedSeries !== a.intendedSeries);
    if (wrong.length)
      return fail('An observed annotation points to a different series than its verified owner', {
        annotations: asJson(wrong),
      });
    const missing = d.series.filter(
      s => s.required && !s.identifiers.some(i => i.identifies === s.id && i.reachable && i.readable),
    );
    if (missing.length && d.alternativesChecked)
      return fail('Necessary series have no readable, reachable identity after checking available alternatives', {
        series: missing.map(s => s.id),
      });
    if (missing.length || !d.alternativesChecked || d.annotations.some(a => !a.observedSeries))
      return unknown('Series alternatives or annotation anchors remain unverified');
    return pass('Necessary series can be identified and all recorded annotation anchors match their verified owners');
  },
);
