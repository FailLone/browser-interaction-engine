import { z } from 'zod';

/** Namespaced evidence contract. Unknown optional capabilities remain visible as unsupported. */
export const inspectionCapabilities = {
  protocolVersion: 1,
  supported: ['web.environment', 'web.dom', 'web.layout', 'web.styles', 'web.screenshot', 'web.aria', 'web.runtime'],
  phases: ['settled', 'timeout'],
  unsupported: ['intermediate', 'iframe-dom', 'shadow-dom', 'text-fragments', 'pixel-occlusion', 'arbitrary-live-probes', 'await-inspector'],
  explicitProbes: ['hover', 'focus', 'scroll'],
  queriesChangePage: false,
  consistency: 'components_have_individual_timestamps',
  collectors: [{ id: 'playwright.spatial', version: 1, schemaVersion: 1, requiresLivePage: true, effects: 'read', budget: 'evidence-options' }],
} as const;
export const captureProfileSchema = z.object({
  id: z.string().min(1).max(100).default('spatial'), version: z.literal(1).default(1),
  required: z.array(z.string().min(1).max(100)).max(32).default(['web.environment', 'web.dom', 'web.layout', 'web.styles']),
  optional: z.array(z.string().min(1).max(100)).max(32).default(['web.screenshot', 'web.aria', 'web.runtime']),
  onIncomplete: z.enum(['report', 'pause']).default('report'),
}).strict().prefault({});
export const inspectionOptionsSchema = z.object({
  profile: captureProfileSchema,
  consumers: z.array(z.object({
    id: z.string().min(1).max(100), leaseMs: z.number().int().min(1000).max(3600000).default(60000),
    maxLeaseMs: z.number().int().min(1000).max(86400000).default(600000),
  }).strict().refine(c => c.leaseMs <= c.maxLeaseMs, 'leaseMs cannot exceed maxLeaseMs')).max(16).default([]),
}).strict().refine(o => new Set(o.consumers.map(c => c.id)).size === o.consumers.length, 'Consumer IDs must be unique');
export type CaptureProfile = z.output<typeof captureProfileSchema>;
export type InspectionOptions = z.output<typeof inspectionOptionsSchema>;
export type InspectionOptionsInput = z.input<typeof inspectionOptionsSchema>;
export function validateCaptureProfile(input: unknown) {
  const profile = captureProfileSchema.parse(input);
  const supported = new Set<string>(inspectionCapabilities.supported);
  const unsupportedRequired = profile.required.filter(c => !supported.has(c));
  return { valid: unsupportedRequired.length === 0, profile, unsupportedRequired, unsupportedOptional: profile.optional.filter(c => !supported.has(c)), capabilities: inspectionCapabilities };
}
