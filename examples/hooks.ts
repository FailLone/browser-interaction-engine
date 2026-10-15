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

/** Upper-layer policy over explicitly configured regions; no business inference in the engine.
 * Create the session with decisionScopes: ['region'].
 * Update goal.version and observe again when changing the test objective.
 */
export function createExplorationHooks(goal: {
  version: string;
  regions: Record<string, 'all' | 'defer' | 'skip' | { sampleLabels: string[] }>;
}): EngineHooks {
  return {
    context: () => ({ testGoal: { value: goal.version, status: 'known', source: 'test-plan' } }),
    explorationDecision: group => {
      if (group.kind !== 'region') return undefined;
      const policy = goal.regions[group.label];
      if (!policy) return undefined; // Use the durable event/command path for an undecided scope.
      const basis = { source: 'test-plan', evidence: [`Goal ${goal.version}: explicit region policy for ${group.label}`] };
      if (typeof policy === 'string') return { ...basis, mode: policy };
      const members = group.members.filter(m => policy.sampleLabels.includes(m.label));
      // Labels are caller configuration, never identity proof. Require one exact
      // observed case per requested label before submitting actual member keys.
      if (!policy.sampleLabels.length || new Set(policy.sampleLabels).size !== policy.sampleLabels.length
        || policy.sampleLabels.some(label => members.filter(m => m.label === label).length !== 1)) return undefined;
      return { ...basis, mode: 'sample', memberKeys: members.map(m => m.key) };
    },
  };
}
