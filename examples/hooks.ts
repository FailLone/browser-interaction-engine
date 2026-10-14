import type { EngineHooks } from '@interaction/browser';

export function createHooks(samplesByLabel: Record<string, string>): EngineHooks {
  return {
    samples: control => samplesByLabel[control.label] === undefined ? undefined : [samplesByLabel[control.label]],
    actions: actions => actions, // Return a filtered list or supplement actions targeting observed controls.
    context: () => ({ environment: { value: 'test', status: 'known', source: 'caller-configuration' } }),
    choose: (items, { observation }) => (items.find(i => i.stateId === observation.stateId) || items[0])?.id || null,
    identity: () => undefined, // Preserve uncertainty until an external caller submits evidence.
    verify: () => ({ result: 'pass', evidence: ['No additional application-specific verification configured.'] }),
    accept: () => ({ accepted: false, evidence: ['No relaxed acceptance rule configured.'] }),
    check: (_attempt, { observation }) => observation.controls.filter(c => !c.name && c.visible).map(c => ({ source: 'unnamed-control-check', severity: 'warning', message: 'Visible interactive control has no collected accessible label.', evidence: [c.identityId!, c.selector] })),
    // Add reset only when the application can actually reset its test data.
  };
}
