import { canonical, hash } from '@interaction/core';
import type { Control, Observation } from './types.js';
import { interactionProjection } from './exploration.js';

type View = Pick<Observation, 'documentId' | 'url' | 'controls' | 'boundaries' | 'scroll'>;

/** Native field operations have a form owner. Arbitrary activation, submission,
 * unowned controls and cross-form relationships still require global validation.
 * This bounds DOM validation, not the business effects of application listeners.
 * Declared business context is always checked separately at execution time. */
export function nativeFormScope(control: Control, kind?: string) {
  if (!control.formOwner?.isolated || control.readOnly) return;
  const rules: Record<string, string> = { fill: 'native-text-entry/v1', check: 'native-checkable/v1', select: 'native-select/v1' };
  const supported = (operation: string) => control.actionBasis?.[operation]?.status === 'supported'
    && control.actionBasis[operation].evidence.some(e => e.source === 'html' && e.rule === rules[operation]);
  if (kind ? supported(kind) : Object.keys(rules).some(supported)) return control.formOwner.instanceId;
}

export function dependencyProjection(o: View, target: Control, kind?: string) {
  const scope = nativeFormScope(target, kind);
  if (!scope) return;
  return targetProjection(target, hash(interactionProjection({ ...o,
    controls: o.controls.filter(c => c.formOwner?.instanceId === scope),
  })));
}

const targetProjection = (target: Control, interaction: string) => canonical({ owner: target.formOwner,
  interaction, target: { instance: target.instanceId, rect: target.rect } });

/** One projection per form per read, rather than rescanning all fields for each
 * target. The target's geometry remains separate from unrelated field movement. */
export function dependencyProjections(o: View) {
  const forms = new Map<string, Control[]>();
  for (const control of o.controls) if (control.formOwner) {
    const members = forms.get(control.formOwner.instanceId) || [];
    members.push(control); forms.set(control.formOwner.instanceId, members);
  }
  const result = new Map<string, string>();
  for (const controls of forms.values()) {
    const targets = controls.filter(c => nativeFormScope(c));
    if (!targets.length) continue;
    const interaction = hash(interactionProjection({ ...o, controls }));
    for (const target of targets) result.set(target.instanceId, targetProjection(target, interaction));
  }
  return result;
}
