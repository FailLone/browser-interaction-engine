import type { Observation } from '@interaction/browser';
import { builtinRulePlugins, ClippedControlTracker, ObservedOcclusionTracker, type RulePlugin } from '@interaction/rules';

/** Explicit fixture-only contracts, bound by the host to one session and its
 * captured identities. The tested page cannot opt itself into an error policy. */
export function ruleDefectPlugins(baseline: Observation): readonly RulePlugin[] {
  if (new URL(baseline.url).pathname !== '/rule-defects.html') throw new Error('Expected the dedicated rule defect fixture');
  const identity = (testId: string) => {
    const controls = baseline.controls.filter(c => c.selector === `#${testId}`);
    if (controls.length !== 1 || !controls[0].identityId || controls[0].hypothesisId) throw new Error(`Unambiguous fixture identity required: ${testId}`);
    return controls[0].identityId;
  };
  const blocked = identity('blocked-button'), clipped = identity('clipped-button');
  return builtinRulePlugins.map<RulePlugin>(plugin => {
    if (plugin.id === 'observed-text-truncation') return plugin;
    return { ...plugin, description: `${plugin.description} 本演示会话另有明确的测试约定。`, create: () => {
      const ordinary = plugin.create();
      const strict = plugin.id === 'observed-occlusion' ? new ObservedOcclusionTracker({ requirements: [{
        identityId: blocked, kind: 'sampled-pointer-at-observed-position',
        reason: '测试约定：确认测试订单按钮在每个观察位置至少有一个可点击采样点。',
        evidence: ['fixture-contract:rule-defects/v1#blocked-button'],
      }] }) : new ClippedControlTracker({ rule: { requirements: [{
        identityId: clipped, kind: 'unclipped-by-nonscroll-container',
        reason: '测试约定：保存测试设置按钮不得被非滚动容器裁切。',
        evidence: ['fixture-contract:rule-defects/v1#clipped-button'],
      }] } });
      return { run: (reader, task) => (task.sessionId === baseline.sessionId ? strict : ordinary).run(reader, task) };
    } };
  });
}
