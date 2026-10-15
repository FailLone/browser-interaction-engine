import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  clippingRequirementProposalSchema, occlusionRequirementProposalSchema, textRequirementProposalSchema,
  requirementProposalBaseSchema, requirementSourceSchema, ruleRequirementProposalSchema,
  imageAspectRatioRequirementProposalSchema,
  textBackgroundRequirementProposalSchema, imageResourceRequirementProposalSchema,
  clippedControlOptionsSchema, observedClippingOptionsSchema, observedOcclusionOptionsSchema,
  textTruncationOptionsSchema, observedTextTruncationOptionsSchema, sampledOcclusionRule, scrollRecoveryOptionsSchema,
  type ClippingRequirementProvider, type OcclusionRequirementProvider, type TextRequirementProvider,
  type RuleRequirementProvider, type RuleRequirementProposal,
} from '@interaction/rules';

const envelope = {
  schemaVersion: 1, status: 'proposed',
  target: { sessionId: 'session', observationId: 'observation', captureId: 'capture', documentId: 'document',
    nodeId: 'node', instanceId: 'instance', identityId: 'identity', scopeId: 'modal-cycle' },
  source: { kind: 'project-specification', reference: 'spec:primary-action' },
  reason: 'The scoped control must meet this requirement', evidence: ['spec:primary-action', 'capture:capture'],
};
const cases = [
  { ruleId: 'observed-occlusion', requirement: 'sampled-pointer-at-observed-position', schema: occlusionRequirementProposalSchema },
  { ruleId: 'clipped-control', requirement: 'unclipped-by-nonscroll-container', schema: clippingRequirementProposalSchema },
  { ruleId: 'text-truncation', requirement: 'full-text-inline', schema: textRequirementProposalSchema },
  { ruleId: 'image-aspect-ratio', requirement: 'preserve-aspect-ratio', schema: imageAspectRatioRequirementProposalSchema },
  { ruleId: 'text-background', requirement: 'distinct-solid-label-colors', schema: textBackgroundRequirementProposalSchema },
  { ruleId: 'image-resource', requirement: 'no-image-load-error', schema: imageResourceRequirementProposalSchema },
];
const proposal = (entry: typeof cases[number]) => ({ ...envelope, ruleId: entry.ruleId, ruleVersion: '1.0.0', requirement: entry.requirement,
  ...(entry.ruleId === 'image-aspect-ratio' ? { resource: { currentSrc: 'https://fixture.test/image.png', naturalWidth: 200, naturalHeight: 100, loadEpoch: 0 } } : {}),
  ...(entry.ruleId === 'image-resource' ? { resource: { currentSrc: 'https://fixture.test/image.png', sourceKey: 'source' } } : {}),
  ...(entry.ruleId === 'text-background' ? { label: [{ nodeId: 'text', text: 'Label' }] } : {}) });

it.each(cases)('preserves $ruleId provenance and target binding through its own and shared validator', entry => {
  for (const source of [envelope.source,
    { kind: 'agent-judgment', agentId: 'agent', basis: 'cited-specification' },
    { kind: 'agent-judgment', agentId: 'agent', basis: 'inference' }]) {
    const input = { ...proposal(entry), source };
    expect(entry.schema.parse(input)).toEqual(input);
    expect(ruleRequirementProposalSchema.parse(input)).toEqual(input);
  }
});

it.each(cases)('rejects adopted states, incomplete bindings and unsupported fields for $ruleId', entry => {
  const input = proposal(entry);
  for (const status of ['accepted', 'confirmed', 'rejected']) expect(entry.schema.safeParse({ ...input, status }).success).toBe(false);
  for (const key of ['sessionId', 'observationId', 'captureId', 'documentId', 'nodeId', 'instanceId'] as const) {
    const target: Partial<typeof envelope.target> = { ...envelope.target }; delete target[key];
    expect(entry.schema.safeParse({ ...input, target }).success).toBe(false);
  }
  for (const patch of [{ evidence: [] }, { evidence: ['  '] }, { reason: ' ' }, { ruleVersion: '2.0.0' }, { approved: true }]) {
    expect(entry.schema.safeParse({ ...input, ...patch }).success).toBe(false);
    expect(ruleRequirementProposalSchema.safeParse({ ...input, ...patch }).success).toBe(false);
  }
});

it('does not reinterpret a requirement for another rule, tracker alias or active probe', () => {
  for (const entry of cases) for (const other of cases.filter(c => c !== entry)) {
    expect(ruleRequirementProposalSchema.safeParse({ ...proposal(entry), requirement: other.requirement }).success).toBe(false);
    expect(other.schema.safeParse(proposal(entry)).success).toBe(false);
  }
  for (const ruleId of ['sampled-occlusion', 'observed-clipping', 'observed-text-truncation', 'scroll-recovery', 'unknown-rule']) {
    expect(ruleRequirementProposalSchema.safeParse({ ...proposal(cases[0]), ruleId }).success).toBe(false);
  }
});

it('retains the text proposal format, optional identity/scope, and every existing text requirement', () => {
  const { identityId: _identity, scopeId: _scope, ...target } = envelope.target;
  for (const requirement of ['full-text-inline', 'allow-elision', 'full-text-via-alternative']) {
    const input = { ...proposal(cases[2]), target, requirement };
    expect(textRequirementProposalSchema.parse(input)).toEqual(input);
    expect(ruleRequirementProposalSchema.parse(input)).toEqual(input);
  }
});

it('keeps common source claims strict and bounded without inferring authority', () => {
  expect(requirementProposalBaseSchema.parse(envelope)).toEqual(envelope);
  for (const source of [
    { kind: 'project-specification', reference: ' ' },
    { kind: 'agent-judgment', agentId: 'agent' },
    { kind: 'agent-judgment', agentId: 'agent', basis: 'approved' },
    { kind: 'agent-judgment', agentId: 'agent', basis: 'inference', accepted: true },
    { kind: 'project-specification', reference: 'spec', agentId: 'agent' },
  ]) expect(requirementSourceSchema.safeParse(source).success).toBe(false);
  expect(requirementProposalBaseSchema.safeParse({ ...envelope, evidence: Array(33).fill('evidence') }).success).toBe(false);
  expect(requirementProposalBaseSchema.safeParse({ ...envelope, reason: 'x'.repeat(4001) }).success).toBe(false);
});

it('exports discoverable JSON schemas and provider types for the installed rules', () => {
  const schema = z.toJSONSchema(ruleRequirementProposalSchema);
  expect(schema.oneOf?.map(branch => typeof branch === 'object' ? branch.properties?.ruleId : undefined))
    .toEqual(cases.map(entry => ({ type: 'string', const: entry.ruleId })));
  // Compile-time consumers of the public API; these are not registered or run.
  const occlusion: OcclusionRequirementProvider = { id: 'occlusion-provider', version: '1', propose: async () => [occlusionRequirementProposalSchema.parse(proposal(cases[0]))] };
  const clipping: ClippingRequirementProvider = { id: 'clipping-provider', version: '1', propose: async () => [clippingRequirementProposalSchema.parse(proposal(cases[1]))] };
  const text: TextRequirementProvider = { id: 'text-provider', version: '1', propose: async () => [textRequirementProposalSchema.parse(proposal(cases[2]))] };
  const providers: RuleRequirementProvider[] = [occlusion, clipping, text];
  const explicit: RuleRequirementProvider<RuleRequirementProposal> = providers[0];
  expect(explicit.id).toBe('occlusion-provider');
});

it('refuses to feed a proposal into any existing explicit requirement or provider option', () => {
  const occlusion = occlusionRequirementProposalSchema.parse(proposal(cases[0]));
  const clipping = clippingRequirementProposalSchema.parse(proposal(cases[1]));
  const text = textRequirementProposalSchema.parse(proposal(cases[2]));
  // Even adding the old discriminator must not strip proposal fields and grant it authority.
  const withKind = { ...clipping, kind: clipping.requirement, identityId: clipping.target.identityId };
  expect(observedOcclusionOptionsSchema.safeParse({ requirements: [occlusion] }).success).toBe(false);
  expect(clippedControlOptionsSchema.safeParse({ requirements: [clipping] }).success).toBe(false);
  expect(clippedControlOptionsSchema.safeParse({ requirements: [withKind] }).success).toBe(false);
  expect(observedClippingOptionsSchema.safeParse({ rule: { requirements: [clipping] } }).success).toBe(false);
  expect(textTruncationOptionsSchema.safeParse({ requirements: [text] }).success).toBe(false);
  expect(observedTextTruncationOptionsSchema.safeParse({ rule: { requirements: [text] } }).success).toBe(false);
  expect(scrollRecoveryOptionsSchema.safeParse({ requiredNow: occlusion }).success).toBe(false);
  expect(() => sampledOcclusionRule.configure({ requirements: [occlusion] })).toThrow();
  for (const schema of [observedOcclusionOptionsSchema, clippedControlOptionsSchema, observedClippingOptionsSchema, textTruncationOptionsSchema, observedTextTruncationOptionsSchema]) {
    expect(schema.safeParse({ provider: { id: 'agent' } }).success).toBe(false);
  }
});

it('keeps legacy explicit requirements valid without treating them as proposals', () => {
  const common = { identityId: 'identity', reason: 'Explicit host requirement', evidence: ['spec:action'] };
  const occlusion = { ...common, kind: 'sampled-pointer-at-observed-position' };
  const clipping = { ...common, kind: 'unclipped-by-nonscroll-container' };
  expect(observedOcclusionOptionsSchema.parse({ requirements: [occlusion] }).requirements).toEqual([occlusion]);
  expect(clippedControlOptionsSchema.parse({ requirements: [clipping] }).requirements).toEqual([clipping]);
  expect(observedClippingOptionsSchema.parse({ rule: { requirements: [clipping] } }).rule.requirements).toEqual([clipping]);
  expect(ruleRequirementProposalSchema.safeParse(occlusion).success).toBe(false);
  expect(ruleRequirementProposalSchema.safeParse(clipping).success).toBe(false);
});
