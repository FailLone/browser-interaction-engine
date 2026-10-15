import { canonical, contextKey, currentExplorationDecision, EngineError, hash, now, type ActionAttempt, type FrontierItemView, type IdentityHypothesis, type ReachResult } from '@interaction/core';
import type { ContinuationRecord, Intervention, InterventionMaterial, InterventionResponseInput, InterventionResponseRecord } from '@interaction/adapter-playwright';
import type { BrowserEngine } from './index.js';

const unique = (xs: string[]) => [...new Set(xs)].sort();
const option = (command: string, label: string, effect: string) => ({ command, label, effect });
const observe = option('observe', '重新观察', '只更新现场材料；不批准操作或恢复业务状态');
interface Snapshot { id: string; sessionId: string; revision: string; entries: Record<string, string>; changes: InterventionMaterial['changes'] }
const changes = (items: Intervention[], previous: Record<string, string> = {}) => ({
  added: items.filter(i => !previous[i.id]).map(i => i.id),
  changed: items.filter(i => previous[i.id] && previous[i.id] !== i.conditionKey).map(i => i.id),
  retired: Object.keys(previous).filter(id => !items.some(i => i.id === id)),
});

/** A read model over authoritative records, not a second permission system. */
export class Interventions {
  constructor(private engine: BrowserEngine) {}
  material(sid: string, since?: string): InterventionMaterial {
    const e = this.engine, o = e.observation(sid), session = e.session(sid), frontier = e.getFrontier(sid), actions = e.actions(sid);
    const outstanding = frontier.filter(f => !['executed', 'superseded'].includes(f.status) && !f.coverage.equivalentTo);
    const items: Intervention[] = [];
    const add = (kind: Intervention['kind'], key: string, title: string, reason: string, priority: number,
      work: FrontierItemView[], options: Intervention['options'], source: unknown, extra: Partial<Intervention> = {}) => {
      const item: Intervention = { id: hash({ sid, kind, key }), conditionKey: '', kind, title, reason, priority,
        status: 'awaiting_decision', current: true, blocking: 'work', dependsOn: [],
        affected: { frontierIds: unique(work.map(f => f.id)), controlIds: unique(work.flatMap(f => f.action.localId ? [f.action.localId] : [])),
          groupIds: unique(work.flatMap(f => f.explorationGroups?.map(g => g.groupId) || [])), attemptIds: unique(work.flatMap(f => f.attempts)) },
        evidence: { observationIds: [o.id], recordIds: [], messages: [] }, material: [], options, subject: {}, ...extra };
      // The observation binds even an otherwise unchanged slow response. The
      // underlying command performs its own live and domain-specific checks.
      item.conditionKey = hash({ observationId: o.id, source, item }); items.push(item); return item;
    };
    const global: string[] = [];
    const critical = o.gaps.filter(g => g.critical);
    if (critical.length) global.push(add('observation', o.instanceScope, '当前观察不完整', 'OBSERVATION_INCOMPLETE', 0, outstanding, [observe], critical,
      { blocking: 'session', status: 'blocked', material: [{ resource: 'observation' }], evidence: { observationIds: [o.id], recordIds: [], messages: critical.map(g => `${g.code}: ${g.message}`) } }).id);

    const continuations = e.list<ContinuationRecord>(sid, 'continuation');
    const verified = continuations.filter(r => r.verifiedRecovery);
    const recovered = new Set(verified.flatMap(r => r.verifiedRecovery!.attemptIds));
    const unknown = e.list<ActionAttempt>(sid, 'attempt').filter(a => a.status === 'unknown' && !recovered.has(a.id));
    const boundary = e.boundaryExitMaterial(sid), exitFailure = e.blockingBoundaryExit(sid);
    if (unknown.length || exitFailure) {
      const ids = unique([...unknown.map(a => a.id), ...(exitFailure ? [exitFailure.attemptId] : [])]);
      global.push(add('execution', 'unverified-outcome', '需要确认操作后的状态', 'EXECUTION_OUTCOME_UNVERIFIED', 1,
        outstanding.filter(f => f.attempts.some(id => ids.includes(id))), [observe], { ids, exitFailure },
        { blocking: 'session', status: 'failed', affected: { frontierIds: outstanding.filter(f => f.attempts.some(id => ids.includes(id))).map(f => f.id), controlIds: [], groupIds: [], attemptIds: ids },
          subject: { resultId: exitFailure?.id }, material: [{ resource: 'attempts' }, { resource: 'boundary-exit' }],
          evidence: { observationIds: unique([o.id, ...unknown.map(a => a.beforeId)]), recordIds: ids,
            messages: ['未知结果不自动重试。恢复后先核验原退出契约；无法仅凭页面确认时，用 continueExploration.recovery 提交预期并由外部状态验证器确认，原操作结果不改写。'] } }).id);
    }
    let environment: Intervention | undefined;
    if (session.dirty) environment = add('environment', 'business-state', '业务状态可能已改变', 'EXTERNAL_STATE_REQUIRES_VERIFICATION', 2,
      outstanding.filter(f => !!f.recovery), [observe], { dirty: session.dirty, attemptIds: session.dirtyAttemptIds },
      { blocking: 'none', status: 'blocked', material: [{ resource: 'recoveries' }, { resource: 'attempts' }],
        evidence: { observationIds: [o.id], recordIds: session.dirtyAttemptIds || [], messages: ['可继续满足条件的当前工作；不能把刷新或重新观察当作业务恢复。外部恢复通过 continueExploration.recovery 验证。'] } });

    let exit: Intervention | undefined;
    const viableExit = boundary.exits.some(x => !x.blockers.length && actions.some(a => a.id === x.actionId && !a.excluded)
      && outstanding.some(f => f.status === 'pending' && f.action.id === x.actionId));
    if (boundary.boundary && (!viableExit || boundary.review?.status === 'deferred' || session.stopReason === 'ACTIVE_BOUNDARY_BLOCKED')) {
      exit = add('boundary', boundary.episodeId || boundary.boundary.key, '需要确定当前弹层的退出方式', 'BOUNDARY_EXIT_REQUIRED', 10,
        outstanding.filter(f => f.reason === 'outside_active_boundary' || f.action.boundary?.key === boundary.boundary!.key),
        [option('reviewBoundaryExit', '审阅退出或暂缓', '批准一次候选尝试；执行后仍验证关闭和保留条件'), observe], boundary,
        { status: boundary.review?.status === 'deferred' ? 'deferred' : 'awaiting_decision', subject: { boundaryKey: boundary.boundary.key },
          material: [{ resource: 'boundary-exit' }], evidence: { observationIds: [o.id], recordIds: boundary.attempts.map(a => a.id), messages: ['派发成功不表示弹层关闭；失败的同一出口不自动重复。'] } });
    }
    const region = e.regionReviewMaterial(sid);
    let partition: Intervention | undefined;
    if (region.enabled && (region.unassignedControlIds.length || region.unassignedPageTraversal)) {
      partition = add('region', o.instanceScope, '确认尚未划分的探索区域', 'REGION_REVIEW_REQUIRED', 20,
        outstanding.filter(f => f.reason === 'region_review_required'),
        [option('reviewRegions', '确认或补审区域', '划分范围；新范围的深度需要另行决定'), ...(region.reuseCandidates?.length ? [option('reuseRegionReviews', '接受当前区域映射', '生成绑定当前文档的新划分')] : []), observe], region,
        { subject: { localIds: region.unassignedControlIds }, material: [{ resource: 'region-review' }], dependsOn: exit ? [exit.id] : [] });
    }
    const controlMaterial = e.controlReviewMaterial(sid);
    for (const c of controlMaterial.controls.filter(c => c.needsReview)) {
      const localId = c.control.localId, work = outstanding.filter(f => f.action.localId === localId);
      const outside = !!boundary.boundary && !boundary.boundary.controlIds.includes(localId);
      const task = add('control', `${o.instanceScope}:${localId}`, c.control.name || c.control.role || '未确认控件', 'CONTROL_PURPOSE_REQUIRED', 30, work,
        [option('reviewControls', '确认当前操作用途', '仅批准有依据的当前操作'), option('classifyControls', '分类候选', '区分可交互、展示、容器或仍需判断；不计执行覆盖'),
          ...(c.reuseCandidates?.length ? [option('reuseControlReviews', '接受用途复用', '重新校验当前目标并生成新用途审阅')] : []),
          option('probe', '受控探测', '显式执行一次 hover/focus；不保证无副作用'), observe], c,
        { subject: { localIds: [localId] }, affected: { frontierIds: work.map(f => f.id), controlIds: [localId], groupIds: unique(work.flatMap(f => f.explorationGroups?.map(g => g.groupId) || [])), attemptIds: unique(work.flatMap(f => f.attempts)) },
          material: [{ resource: 'control-review', subjectId: localId }, { resource: 'control-classification', subjectId: localId }],
          dependsOn: outside && exit ? [exit.id] : [] });
      if (partition && region.unassignedControlIds.includes(localId) && outside) task.dependsOn.push(partition.id);
    }
    const review = e.explorationReviewMaterial(sid), depth = e.explorationDecisionReuseMaterial(sid);
    for (const g of review.groups) {
      const d = currentExplorationDecision(g)?.decision;
      if (d && !['defer', 'skip'].includes(d.mode)) continue;
      const work = outstanding.filter(f => f.explorationGroups?.some(r => r.groupId === g.id));
      const localIds = unique(g.members.filter(m => m.observationId === o.id).flatMap(m => m.localId || actions.find(a => a.id === m.actionId)?.localId || []));
      // A depth choice can skip unknown members or select a known subset. It
      // must not wait for every member's purpose to be reviewed first.
      const deps: string[] = [];
      if (partition && localIds.some(id => region.unassignedControlIds.includes(id))) deps.push(partition.id);
      const current = g.binding === 'context' ? g.contextKey === contextKey(o.context) && (g.kind !== 'page' || g.proposalKey === `page:${o.url}`) : g.instanceScope === o.instanceScope;
      add('exploration', g.id, `决定探索范围：${g.label}`, g.decisions.at(-1)?.invalidation?.reason || (d?.mode === 'defer' ? 'EXPLORATION_DEFERRED' : d?.mode === 'skip' ? 'EXPLORATION_SKIPPED' : 'EXPLORATION_DECISION_REQUIRED'),
        g.kind === 'page' ? 15 : 40, work,
        [option('decideExplorationGroup', '穷尽、抽样、暂缓或本轮不测', '仅改变该范围的调度决定，不执行操作'), option('decideExplorationGroups', '批量决定当前范围', '同时满足其他范围的独立约束'),
          ...(depth.candidates.some(c => c.groupId === g.id) ? [option('reuseExplorationDecisions', '接受当前深度映射', '只生成当前决定，不继承历史覆盖')] : []),
          ...(g.kind === 'similar-list' ? [option('reviewListPurpose', '审阅列表用途', '列表用途与深度决定独立')] : [])], { g, candidates: depth.candidates.filter(c => c.groupId === g.id) },
        { current, status: d?.mode === 'defer' ? 'deferred' : d?.mode === 'skip' ? 'skipped' : 'awaiting_decision', blocking: d?.mode === 'skip' ? 'none' : 'work', dependsOn: deps,
          subject: { groupId: g.id }, material: [{ resource: 'exploration-review', subjectId: g.id }, { resource: 'exploration-decision-reuse', subjectId: g.id }] });
    }
    for (const h of e.list<IdentityHypothesis>(sid, 'hypothesis').filter(h => h.status === 'pending')) {
      const work = outstanding.filter(f => f.reason === 'identity_ambiguous' && f.action.controlId === h.provisionalIdentityId);
      if (!work.length) continue; // Ambiguous historical identity alone does not block exact current execution.
      add('identity', h.id, '确认历史控件身份', 'IDENTITY_AMBIGUOUS', 45, work,
        [option('resolveIdentity', '确认身份关系', '必须带当前审阅守卫；不凭名称合并控件'), observe], h,
        { current: o.controls.some(c => c.hypothesisId === h.id), subject: { hypothesisId: h.id }, material: [{ resource: 'hypotheses', subjectId: h.id }] });
    }
    const recoveries = new Map<string, FrontierItemView[]>();
    for (const f of outstanding.filter(f => f.recovery && f.status === 'blocked')) { const key = f.recovery!.resultId; recoveries.set(key, [...recoveries.get(key) || [], f]); }
    for (const [rid, work] of recoveries) {
      const result = e.store.get<ReachResult>('reach', rid);
      if (!result) continue;
      add('recovery', rid, '恢复所属界面后继续', result.reason, 50, work,
        [option('reachCheckpoint', '按已验证路径尝试恢复', '不跳过恢复校验；可能执行已获准恢复操作'), observe], result,
        { status: 'blocked', current: work.some(f => f.action.observationId === o.id), subject: { checkpointId: result.checkpointId },
          material: [{ resource: 'recoveries', subjectId: rid }], dependsOn: environment ? [environment.id] : [],
          evidence: { observationIds: unique([o.id, ...result.observationId ? [result.observationId] : []]), recordIds: [rid, ...result.attemptIds], messages: result.diagnostics?.strategies || [] } });
    }
    const scan = e.discoveryScanMaterial(sid);
    const omissions = o.gaps.filter(g => !g.critical && !['INTERACTION_STABLE', 'EVIDENCE_CAPTURE_RETRIED'].includes(g.code));
    if (omissions.length) add('discovery', o.instanceScope, '当前发现与证据缺口', 'DISCOVERY_OR_EVIDENCE_INCOMPLETE', 60, [],
      [...(scan.discovery?.targets.length ? [option('supplementDiscovery', '有界补采', '指定实际漏扫位置和预算，不扩大操作批准')] : []), observe], scan,
      { blocking: 'none', status: 'blocked', material: [{ resource: 'discovery-scan' }], evidence: { observationIds: [o.id], recordIds: [], messages: omissions.map(g => `${g.code}: ${g.message}`) } });
    const lastContinuation = continuations.at(-1);
    if (lastContinuation && ['needs_review', 'failed', 'interrupted'].includes(lastContinuation.status)) {
      add('recovery', 'continuation-check', '上次继续验证尚未通过', lastContinuation.error?.code || 'CONTINUATION_REQUIRES_REVIEW', 5, [], [observe], lastContinuation,
        { blocking: 'none', status: lastContinuation.status === 'failed' ? 'failed' : 'blocked', subject: { resultId: lastContinuation.id },
          material: [{ resource: 'continuations', subjectId: lastContinuation.id }],
          evidence: { observationIds: unique([o.id, lastContinuation.beforeId, ...lastContinuation.afterId ? [lastContinuation.afterId] : []]), recordIds: [lastContinuation.id],
            messages: [lastContinuation.error?.message || '依据下列检查修复条件，读取当前材料并用新 requestId 再次调用 continueExploration；不会重试旧操作。',
              ...lastContinuation.checks.filter(c => c.result !== 'pass').map(c => `${c.name}: ${c.result}${c.evidence?.length ? ` — ${c.evidence.join('; ')}` : ''}`)] } });
    }
    // Account for remaining causes instead of losing them behind recognized categories.
    const represented = new Set(items.flatMap(i => i.affected.frontierIds));
    const reasons = new Map<string, FrontierItemView[]>();
    for (const f of outstanding.filter(f => !represented.has(f.id) && ['blocked', 'failed', 'unknown', 'deferred', 'skipped'].includes(f.status))) {
      const key = canonical({ reason: f.reason || f.status, scope: f.stateId });
      reasons.set(key, [...reasons.get(key) || [], f]);
    }
    for (const [key, work] of reasons) add('recovery', key, '待处理的执行限制', work[0].reason || work[0].status, 70, work, [observe], work,
      { status: work.some(f => ['failed', 'unknown'].includes(f.status)) ? 'failed' : work.every(f => f.status === 'skipped') ? 'skipped' : work.every(f => f.status === 'deferred') ? 'deferred' : 'blocked', current: work.some(f => f.action.observationId === o.id),
        material: [{ resource: 'frontier' }], evidence: { observationIds: unique(work.map(f => f.action.observationId)), recordIds: unique(work.flatMap(f => f.attempts)), messages: unique(work.flatMap(f => f.unblock || [])) } });
    if (session.actionCount >= session.options.maxActions || session.elapsedMs >= session.options.maxDurationMs || session.stopReason?.includes('BUDGET')) {
      global.push(add('budget', 'session-budget', '本轮运行预算已用完', 'BUDGET_EXHAUSTED', 0, [], [], { actionCount: session.actionCount, maxActions: session.options.maxActions, elapsedMs: session.elapsedMs, maxDurationMs: session.options.maxDurationMs },
        { blocking: 'session', status: 'blocked', evidence: { observationIds: [o.id], recordIds: [], messages: ['恢复不会重置已消耗的运行预算。'] } }).id);
    }
    // Pending requests must not change their own condition key before validation.
    // Only terminal records contribute restart diagnostics to a current task.
    const terminalResponses = new Map<string, InterventionResponseRecord>();
    for (const r of e.list<InterventionResponseRecord>(sid, 'intervention-response')) {
      if (!['queued', 'applying'].includes(r.status)) terminalResponses.set(r.input.interventionId, r);
    }
    for (const item of items) {
      const response = terminalResponses.get(item.id);
      if (response?.status === 'interrupted') {
        item.evidence.recordIds = unique([...item.evidence.recordIds, response.id]);
        item.evidence.messages.push('上次答复在进程中断时未完成；核对原记录后重新决定，旧请求不会自动重放。');
        item.material.push({ resource: 'intervention-responses', subjectId: response.id });
      }
      if (!global.includes(item.id)) item.dependsOn.push(...global);
      item.dependsOn = unique(item.dependsOn.filter(id => id !== item.id));
      item.conditionKey = hash({ key: item.conditionKey, dependencies: item.dependsOn, interruptedResponseId: response?.status === 'interrupted' ? response.id : undefined });
    }
    const remaining = items.splice(0).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)), ordered = new Set<string>();
    while (remaining.length) {
      const index = remaining.findIndex(i => i.dependsOn.every(id => ordered.has(id)));
      if (index < 0) throw new EngineError('INTERVENTION_DEPENDENCY_CYCLE', 'Intervention dependencies must form an acyclic graph');
      const [item] = remaining.splice(index, 1); items.push(item); ordered.add(item.id);
    }
    const revision = hash({ observationId: o.id, entries: items.map(i => [i.id, i.conditionKey]) });
    const previous = e.store.get<Snapshot>('intervention-snapshot', since ? `${sid}:${since}` : `${sid}:latest`);
    if (since && !previous) throw new EngineError('UNKNOWN_INTERVENTION_REVISION', 'Read current intervention material; requested revision is not retained');
    return { version: 'interventions/v1', sessionId: sid, observationId: o.id, revision, items,
      readyIds: items.filter(i => !i.dependsOn.length && !['skipped', 'deferred'].includes(i.status)).map(i => i.id), sessionBlockerIds: global,
      changes: !since && previous?.revision === revision ? previous.changes : changes(items, previous?.entries),
      limitation: 'Retired requests are no longer current requests, not successful tests. Deferred/skipped work, historical outcomes and discovery gaps remain in their original audit. Responses never grant unrelated purpose, identity, replay or recovery permission.' };
  }
  sync(sid: string) {
    if (!this.engine.session(sid).currentObservationId) return;
    const m = this.material(sid), store = this.engine.store;
    if (store.get<Snapshot>('intervention-snapshot', `${sid}:latest`)?.revision === m.revision) return;
    const snapshot: Snapshot = { id: `${sid}:${m.revision}`, sessionId: sid, revision: m.revision, entries: Object.fromEntries(m.items.map(i => [i.id, i.conditionKey])), changes: m.changes };
    store.transaction(() => {
      store.put('intervention-snapshot', snapshot); store.put('intervention-snapshot', { ...snapshot, id: `${sid}:latest` });
      this.engine.publishInterventions(sid, 'interventions.updated', { observationId: m.observationId, revision: m.revision, changes: m.changes, readyIds: m.readyIds, sessionBlockerIds: m.sessionBlockerIds });
    });
  }
  validate(sid: string, input: InterventionResponseInput) {
    const m = this.material(sid), item = m.items.find(i => i.id === input.interventionId), c = input.command;
    if (!item || item.conditionKey !== input.conditionKey) throw new EngineError('STALE_INTERVENTION', 'Read current material and decide again', { observationId: m.observationId, revision: m.revision, changes: m.changes });
    if (!item.options.some(o => o.command === c.type)) throw new EngineError('INVALID_INTERVENTION_RESPONSE', 'This response does not handle the selected request');
    const fail = () => { throw new EngineError('INVALID_INTERVENTION_RESPONSE', 'Response targets must belong to this request and its current material'); };
    const observation = 'review' in c ? (c.review as { observationId?: string }).observationId : 'classification' in c ? c.classification.observationId : 'scan' in c ? c.scan.observationId : 'observationId' in c ? c.observationId : undefined;
    if (observation && observation !== m.observationId) fail();
    if (c.type === 'decideExplorationGroup' && c.groupId !== item.subject.groupId) fail();
    if (c.type === 'decideExplorationGroups' && c.resolutions.some(r => r.groupId !== item.subject.groupId)) fail();
    if (c.type === 'reuseExplorationDecisions' && c.review.decisions.some(r => r.groupId !== item.subject.groupId)) fail();
    if (c.type === 'reviewListPurpose' && c.review.groupId !== item.subject.groupId) fail();
    if (c.type === 'reviewBoundaryExit' && c.review.boundaryKey !== item.subject.boundaryKey) fail();
    if (c.type === 'resolveIdentity' && (c.hypothesisId !== item.subject.hypothesisId || c.guard?.observationId !== m.observationId)) fail();
    if (c.type === 'reachCheckpoint' && c.checkpointId !== item.subject.checkpointId) fail();
    const targets = c.type === 'reviewControls' || c.type === 'reuseControlReviews' ? c.review.reviews.map(r => r.localId) : c.type === 'classifyControls' ? c.classification.classifications.map(r => r.localId) : c.type === 'probe' || c.type === 'scrollProbe' ? [c.localId] : [];
    if (targets.some(id => !item.subject.localIds?.includes(id))) fail();
    return item;
  }
  recover() {
    for (const kind of ['intervention-response', 'continuation']) for (const r of this.engine.store.list<InterventionResponseRecord | ContinuationRecord>(kind)) {
      if (!['queued', 'applying', 'verifying'].includes(r.status)) continue;
      r.status = 'interrupted'; r.error = { code: 'PROCESS_RESTART', message: 'Read current records and verify the scene; an interrupted request is never replayed automatically' };
      r.finishedAt = now(); this.engine.store.put(kind, r);
      this.engine.publishInterventions(r.sessionId, 'interventions.interrupted', { kind, recordId: r.id, requestId: r.requestId });
    }
  }
}
