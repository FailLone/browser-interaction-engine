import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { hash } from '@interaction/core';
import { type ActionAttempt, type ActionCandidate, type Observation } from '@interaction/browser';
import { ExplorerPlugin, ExplorerStore, type PlanItem, type Round, type Task } from '@interaction/explorer-plugin';
import { browserOperationKey, legacyBrowserOperationKey } from '../packages/adapter-playwright/src/exploration.js';
import { formBinding } from '../packages/adapter-playwright/src/util.js';
import { POLICY_VERSION } from '../packages/explorer-plugin/src/decision-policy.js';
import { migrateOperationConditions, operationConditionPolicy, scopeFor, includesScope } from '../packages/explorer-plugin/src/policy.js';
import { conditionSplitIssues } from '../packages/explorer-plugin/src/plan-state.js';
import { projectObligations } from '../packages/explorer-plugin/src/obligation-lifecycle.js';
import { completedOperations } from '../packages/explorer-plugin/src/completion-evidence.js';
import { explorerFixture, fakeProviders } from './explorer-plugin-helpers.js';
import { pageOf } from './helpers.js';

const html = `<form id="settings"><select id="mode" aria-label="Mode" hidden><option value="A">A</option><option value="B">B</option></select></form>
<form id="commands"><button id="run" type="button" onclick="window.executed=(window.executed||[]).concat(mode.value);mode.value=mode.value==='A'?'B':'A'">Run</button></form>
<button id="later" type="button" disabled>Later</button>`;
const options = { headless: true, exploration: 'controls', executionPolicy: 'interface-only', settleMs: 0, observeTimeoutMs: 100,
  regionExploration: 'off', pageExploration: 'all', listExploration: 'all', interfaceActions: [{ kind: 'click' }] };
function runAction(host: Awaited<ReturnType<typeof explorerFixture>>['host'], sid: string, o = host.observation(sid)) {
  return host.actions(sid, o.id).find(a => a.kind === 'click' && a.localId === o.controls.find(c => c.stableKey === 'id:run')!.localId)!;
}
/** Frozen no-related-selector encoding from 253a0fd. The hidden cross-form mode
 * was absent from v1; this is independent of the new versioned decoder. */
function storedV1Key(a: ActionCandidate, o: Observation) {
  const c = o.controls.find(c => c.localId === a.localId)!, r = o.regions.find(r => r.key === c.region), context = c.identityContext;
  return hash({ scope: { url: o.url, ...(r ? { region: r.label } : {}), label: a.label, role: c.role, stableKey: c.stableKey, kind: a.kind },
    context: o.context, targetBinding: { context: { scope: context?.scope, binding: context?.binding }, form: formBinding(c) } });
}
function oldItem(o: Observation, a: ActionCandidate): PlanItem {
  return { id: 'persisted-v1-pending', title: 'Run', scope: scopeFor(a, o), prerequisites: [], completion: 'Observe a successful action',
    required: true, dispatchScope: false, status: 'pending', reason: 'observed_in_scope', operationConditionKey: storedV1Key(a, o),
    evidence: [{ sessionId: o.sessionId, observationId: o.id }], attempts: [] };
}
async function fixture(includeLater=true) {
  const f = await explorerFixture(includeLater?html:html.replace(/<button id="later"[\s\S]*$/, '')), path = join(f.dir, 'plugin-v1.sqlite'), providers = fakeProviders(f.url);
  let plugin = new ExplorerPlugin(f.host, new ExplorerStore(path), providers);
  const session = await f.host.createSession({ ...options, url: f.url }), source = f.host.observation(session.id), action = runAction(f.host, session.id);
  const created = plugin.create({ url: f.url, sessionOptions: { executionPolicy: 'interface-only', headless: true, settleMs: 0, observeTimeoutMs: 100 }, budget: { rounds: 1, actions: 10 } });
  plugin.revise(created.id, { items: [{ title: 'Encountered clicks', scope: { url: f.url, kind: 'click' }, prerequisites: [], completion: 'Observe encountered branches', required: true, reason: 'User scope' }] });
  const task = plugin.store.task(created.id), round: Round = { id: 'persisted-round', number: 1, sessionId: session.id, startedAt: new Date().toISOString(),
    status: 'paused', policyVersion: POLICY_VERSION, actions: 0, stack: [], entryPath: [], reentries: [], tried: [], reviewed: [], noProgress: 0 };
  task.rounds = [round]; task.usage.rounds = 1; task.status = 'paused'; task.plan.push(oldItem(source, action)); plugin.store.save(task);
  return { ...f, source, action, task, providers, get plugin() { return plugin; }, restart: async () => { await plugin.close(); plugin = new ExplorerPlugin(f.host, new ExplorerStore(path), providers); },
    close: async () => { await plugin.close(); await f.close(); } };
}

it('reopens a genuinely persisted v1 pending row, upgrades its exact source hint, and executes A/B without granting completion on migration', async () => {
  const f = await fixture();
  try {
    const legacy = f.task.plan.at(-1)!, before = structuredClone(legacy);
    expect(legacy.operationConditionKey).toBe(legacyBrowserOperationKey(f.action, f.source));
    expect(legacy.operationConditionKey).not.toBe(browserOperationKey(f.action, f.source));
    await f.restart();
    expect(f.plugin.view(f.task.id).task.plan.at(-1)).toEqual(before);
    const execute = f.host.execute.bind(f.host), atDispatch: PlanItem[] = [];
    vi.spyOn(f.host, 'execute').mockImplementation(async (...args) => {
      atDispatch.push(structuredClone(f.plugin.store.task(f.task.id).plan.find(i => i.id === legacy.id)!));
      return execute(...args);
    });
    f.plugin.start(f.task.id); await f.plugin.waitForIdle();
    const view = f.plugin.view(f.task.id), upgraded = view.task.plan.find(i => i.id === legacy.id)!;
    expect(atDispatch[0]).toMatchObject({ status: 'pending', attempts: [], operationConditionPolicy, conditionMigration: { status: 'migrated', fromKey: before.operationConditionKey, toKey: browserOperationKey(f.action, f.source) } });
    expect(atDispatch[0].resolvedBy).toBeUndefined(); expect(atDispatch[0].coverageResolvedBy).toBeUndefined();
    expect(upgraded).toMatchObject({ status: 'succeeded', conditionMigration: { reason: 'retained_source_key_verified', sources: [{ sessionId: f.source.sessionId, observationId: f.source.id, actionId: f.action.id }] } });
    const attempts = f.host.list<ActionAttempt>(f.source.sessionId, 'attempt').filter(a => a.action.label === 'Run');
    expect(attempts.map(a => a.status)).toEqual(['succeeded', 'succeeded']);
    expect(await pageOf(f.host).evaluate(() => (window as any).executed)).toEqual(['A', 'B']);
    expect(view.events.filter(e => e.type === 'operation.conditions_migrated')).toHaveLength(1);
    expect(view.events.find(e => e.type === 'operation.conditions_migrated')?.data).toMatchObject({ currentExecution: false, coverageGranted: false, historicalResultsUnchanged: true });
    const current = f.host.observation(f.source.sessionId), a = runAction(f.host, f.source.sessionId);
    expect(completedOperations(f.host, view.task, current, [a]).has(a)).toBe(true);
    expect(f.providers.calls).toEqual([]);
  } finally { await f.close(); }
});

it('splits an already-invalidated coarse v1 A/B row and completes both children without treating the parent as successful', async () => {
  const f = await fixture(false);
  try {
    await pageOf(f.host).evaluate(() => { (document.querySelector('#mode') as HTMLSelectElement).value = 'B'; });
    const b = await f.host.observe(f.source.sessionId), actionB = runAction(f.host, b.sessionId), legacy = f.task.plan.at(-1)!;
    expect(storedV1Key(actionB, b)).toBe(legacy.operationConditionKey);
    expect(browserOperationKey(actionB, b)).not.toBe(browserOperationKey(f.action, f.source));
    legacy.evidence.push({ sessionId: b.sessionId, observationId: b.id });
    legacy.status='blocked';legacy.reason='condition_policy_invalidated:multiple_current_conditions';legacy.conditionMigration={status:'invalidated',fromKey:legacy.operationConditionKey!,reason:'multiple_current_conditions',sources:[{...legacy.evidence[0],actionId:f.action.id},{...legacy.evidence[1],actionId:actionB.id}]};
    f.plugin.store.save(f.task); await f.restart();
    f.plugin.start(f.task.id); await f.plugin.waitForIdle();
    const view = f.plugin.view(f.task.id), invalid = view.task.plan.find(i => i.id === legacy.id)!;
    expect(view.task).toMatchObject({ status: 'completed', reason: 'current_plan_verified' });
    expect(invalid).toMatchObject({ status: 'superseded', required:true, reason: 'condition_scope_split', operationConditionKey: legacy.operationConditionKey,
      attempts: [], conditionMigration: { status: 'split', reason: 'retained_sources_split',previousInvalidation:{reason:'multiple_current_conditions'} } });
    const children=view.task.plan.filter(item=>item.conditionLineage?.parentItemId===legacy.id);
    expect(children).toHaveLength(2);expect(children.every(item=>item.status==='succeeded'&&item.attempts.length===1)).toBe(true);
    expect(conditionSplitIssues(view.task.plan).size).toBe(0);
    expect(invalid.resolvedBy).toBeUndefined(); expect(invalid.coverageResolvedBy).toBeUndefined();
    expect(view.task.obligations?.entries.find(i => i.itemId === legacy.id)).toMatchObject({ state: 'superseded', reason: 'original_scope_transferred_to_children' });
    expect(await pageOf(f.host).evaluate(() => (window as any).executed)).toEqual(['B', 'A']);
    expect(view.task.rounds).toHaveLength(1);
    const sources = vi.spyOn(f.host, 'actions');
    expect(migrateOperationConditions(view.task, f.host)).toEqual([]); expect(sources).not.toHaveBeenCalled();
    expect(f.providers.calls).toEqual([]);
  } finally { await f.close(); }
});

it('restarts with an unknown recovery result and blocks before key migration, observation or new session', async () => {
  const f = await fixture();
  try {
    const attempt = await f.host.execute(f.source.sessionId, f.action.id, 'unconfirmed-recovery');
    f.host.store.put('attempt', { ...attempt, purpose: 'recovery', status: 'unknown', reason: 'Result lost before durable confirmation' });
    await f.restart();
    const create = vi.spyOn(f.host, 'createSession'), observe = vi.spyOn(f.host, 'observe'), execute = vi.spyOn(f.host, 'execute');
    f.plugin.start(f.task.id); await f.plugin.waitForIdle();
    const view = f.plugin.view(f.task.id), original = view.task.plan.find(i => i.id === 'persisted-v1-pending')!;
    expect(view.task).toMatchObject({ status: 'blocked', reason: 'UNKNOWN_DISPATCH_REQUIRES_REVIEW' });
    expect(original).toEqual(f.task.plan.at(-1)); expect(original.conditionMigration).toBeUndefined();
    expect(view.events.some(e => e.type === 'operation.conditions_migrated')).toBe(false);
    expect(create).not.toHaveBeenCalled(); expect(observe).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect(f.host.list<ActionAttempt>(f.source.sessionId, 'attempt').find(a => a.id === attempt.id)?.status).toBe('unknown');
  } finally { await f.close(); }
});

it('never migrates a mismatched, ambiguous or missing retained source by name and never changes attempted rows', async () => {
  const f = await fixture();
  try {
    const source = f.source, action = f.action, missing = oldItem(source, action), ambiguous = oldItem(source, action), mismatch = oldItem(source, action), attempted = oldItem(source, action);
    missing.id = 'missing'; missing.evidence[0].observationId = 'absent';
    ambiguous.id = 'ambiguous'; ambiguous.evidence[0].observationId = 'ambiguous';
    mismatch.id = 'mismatched'; mismatch.operationConditionKey = 'unrelated-key';
    attempted.id = 'unknown'; attempted.attempts.push({ roundId: 'r', outcome: 'unknown' });
    const plan = [missing, ambiguous, mismatch, attempted];
    const host = { observation: (_: string, oid?: string) => { if (oid === 'absent') throw Error('missing'); return oid === 'ambiguous' ? { ...source, id: oid } : source; },
      actions: (_: string, oid?: string) => oid === 'ambiguous' ? [action, { ...action, id: 'duplicate' }].map(a => ({ ...a, observationId: oid })) : [action] };
    const changes = migrateOperationConditions({ plan }, host);
    expect(changes.map(c => c.audit.reason)).toEqual(['missing_source', 'source_not_unique', 'source_key_mismatch']);
    expect(plan.slice(0, 3).every(i => i.status === 'blocked' && i.operationConditionKey !== browserOperationKey(action, source) && !i.resolvedBy)).toBe(true);
    expect(attempted.conditionMigration).toBeUndefined(); expect(attempted.attempts).toEqual([{ roundId: 'r', outcome: 'unknown' }]);
    const projection = projectObligations(host, { plan }, source, [action]).projection;
    expect(projection.entries.slice(0, 3).every(e => e.state === 'unreachable')).toBe(true);
    expect(migrateOperationConditions({ plan }, host)).toEqual([]);
  } finally { await f.close(); }
});

it('keeps selector-free legacy operation keys byte compatible and upgrades metadata without granting success', async () => {
  const f = await explorerFixture('<button id="run" type="button">Run</button>');
  try {
    const s = await f.host.createSession({ ...options, url: f.url }), o = f.host.observation(s.id), a = runAction(f.host, s.id);
    const item = { ...oldItem(o, a), operationConditionKey: legacyBrowserOperationKey(a, o) };
    expect(browserOperationKey(a, o)).toBe(item.operationConditionKey);
    expect(migrateOperationConditions({ plan: [item] }, f.host)).toHaveLength(1);
    expect(item).toMatchObject({ status: 'pending', attempts: [], operationConditionPolicy, conditionMigration: { status: 'migrated', fromKey: item.operationConditionKey, toKey: item.operationConditionKey } });
    expect(item.resolvedBy).toBeUndefined();
  } finally { await f.close(); }
});

it('does not borrow a sibling observation to narrow a keyed v1 obligation whose original source is missing', async () => {
  const f = await fixture();
  try {
    const old = f.task.plan.at(-1)!;
    old.evidence = [];
    f.task.plan.push({ ...structuredClone(old), id: 'current-peer', operationConditionKey: browserOperationKey(f.action, f.source), operationConditionPolicy,
      evidence: [{ sessionId: f.source.sessionId, observationId: f.source.id }] });
    f.plugin.store.save(f.task); await f.restart();
    f.plugin.start(f.task.id); await f.plugin.waitForIdle();
    const view = f.plugin.view(f.task.id), retained = view.task.plan.find(i => i.id === old.id)!;
    expect(retained).toMatchObject({ status: 'blocked', reason: 'condition_policy_invalidated:missing_source', evidence: [], attempts: [], conditionMigration: { status: 'invalidated', reason: 'missing_source' } });
    expect(retained.operationConditionKey).toBe(old.operationConditionKey);
    expect(view.task).toMatchObject({ status: 'blocked', reason: 'condition_policy_invalidated' });
    expect(view.events.filter(e => e.type === 'scope.source_recovered')).toEqual([]);
    expect(await pageOf(f.host).evaluate(() => (window as any).executed)).toEqual(['A', 'B']);
  } finally { await f.close(); }
});

async function splitSource(f: Awaited<ReturnType<typeof fixture>>) {
  await pageOf(f.host).evaluate(() => { (document.querySelector('#mode') as HTMLSelectElement).value = 'B'; });
  const b = await f.host.observe(f.source.sessionId), parent=f.task.plan.find(item=>item.id==='persisted-v1-pending')!;
  parent.evidence.push({sessionId:b.sessionId,observationId:b.id});
  expect(migrateOperationConditions(f.task,f.host)).toHaveLength(1);
  expect(parent.status).toBe('superseded');
  return {b,parent,children:f.task.plan.filter(item=>item.conditionLineage?.parentItemId===parent.id)};
}

it('fails closed when transferred children are missing, rebound, unauthorized, excluded, or lose their retained source',async()=>{
  const f=await fixture();try{
    const {parent,children}=await splitSource(f),original=structuredClone(f.task.plan);
    const cases:[string,(plan:PlanItem[])=>void][]=[
      ['missing_child',plan=>plan.splice(plan.findIndex(item=>item.id===children[0].id),1)],
      ['child_authority_mismatch',plan=>{plan.find(item=>item.id===children[0].id)!.required=false;}],
      ['child_authority_mismatch',plan=>{plan.find(item=>item.id===children[0].id)!.dispatchScope=true;}],
      ['child_scope_mismatch',plan=>{plan.find(item=>item.id===children[0].id)!.scope.label='Other target';}],
      ['child_source_mismatch',plan=>{plan.find(item=>item.id===children[0].id)!.evidence=[];}],
      ['child_condition_mismatch',plan=>{plan.find(item=>item.id===children[0].id)!.operationConditionKey='wrong-mode';}],
      ['child_exclusion_mismatch',plan=>{plan.find(item=>item.id===children[0].id)!.status='excluded';}],
      ['missing_split_audit',plan=>{delete plan.find(item=>item.id===parent.id)!.conditionMigration;}],
    ];
    const reads=vi.spyOn(f.host,'observation');
    for(const [reason,change] of cases){
      const plan=structuredClone(original);change(plan);
      expect(conditionSplitIssues(plan).get(parent.id)).toBe(reason);
      const projection=projectObligations(f.host,{plan},f.source,[]).projection;
      expect(projection.entries.find(entry=>entry.itemId===parent.id)).toMatchObject({state:'unreachable',reason:`condition_split_invalid:${reason}`});
      reads.mockClear();expect(migrateOperationConditions({plan},f.host)).toHaveLength(1);expect(reads).not.toHaveBeenCalled();
      expect(plan.find(item=>item.id===parent.id)).toMatchObject({status:'blocked',required:true,reason:`condition_split_invalid:${reason}`});
      expect(migrateOperationConditions({plan},f.host)).toEqual([]);
    }
  }finally{await f.close();}
});

it('prepares all children before an ID collision and retains the complete old gap without a partial split',async()=>{
  const f=await fixture();try{
    const original=structuredClone(f.task.plan);await splitSource(f);
    const parent=f.task.plan.find(item=>item.id==='persisted-v1-pending')!,collision=structuredClone(f.task.plan.find(item=>item.id===parent.conditionMigration!.children![1].itemId)!);
    const plan=[...original,collision];plan.find(item=>item.id===parent.id)!.evidence=structuredClone(parent.evidence);
    const before=structuredClone(plan);
    migrateOperationConditions({plan},f.host);
    expect(plan).toHaveLength(before.length);expect(plan.at(-1)).toEqual(collision);
    expect(plan.find(item=>item.id===parent.id)).toMatchObject({status:'blocked',reason:'condition_policy_invalidated:child_id_collision'});
    expect(plan.filter(item=>item.conditionLineage?.parentItemId===parent.id)).toHaveLength(1);
  }finally{await f.close();}
});

it('leaves overflowing and ambiguous selector sources as gaps even when the legacy operation key verifies',async()=>{
  const f=await fixture();try{
    for(const reason of ['overflow','ambiguous']){
      const source=structuredClone(f.source),mode=source.controls.find(control=>control.stableKey==='id:mode')!;
      const copies=reason==='overflow'?33:1;
      for(let i=0;i<copies;i++)source.controls.push({...structuredClone(mode),localId:`extra-${i}`,stableKey:reason==='overflow'?`id:extra-${i}`:mode.stableKey});
      const item=oldItem(source,f.action),host={observation:()=>source,actions:()=>[f.action]};
      expect(legacyBrowserOperationKey(f.action,source)).toBe(item.operationConditionKey);
      migrateOperationConditions({plan:[item]},host);
      expect(item).toMatchObject({status:'blocked',reason:'condition_policy_invalidated:source_conditions_unverified',conditionMigration:{status:'invalidated',version:2}});
      expect(item.conditionMigration?.children).toBeUndefined();
    }
  }finally{await f.close();}
});

it('settles the A child through current SDK history while B remains untested, and retains its condition after explicit supplement',async()=>{
  const f=await fixture();try{
    const {children,parent}=await splitSource(f),keyA=browserOperationKey(f.action,f.source),childA=children.find(item=>item.operationConditionKey===keyA)!,childB=children.find(item=>item!==childA)!;
    await pageOf(f.host).evaluate(()=>{(document.querySelector('#mode') as HTMLSelectElement).value='A';});
    const before=await f.host.observe(f.source.sessionId),action=runAction(f.host,before.sessionId),attempt=await f.host.execute(before.sessionId,action.id,'existing-A-history');
    const ref={sessionId:attempt.sessionId,observationId:attempt.afterId!,attemptId:attempt.id};
    f.task.plan.push({...oldItem(before,action),id:'verified-A-history',operationConditionKey:keyA,operationConditionPolicy,status:'succeeded',resolvedBy:ref,evidence:[{sessionId:before.sessionId,observationId:before.id},ref],attempts:[{roundId:f.task.rounds[0].id,outcome:'succeeded',evidence:ref}]});
    const runtime=f.plugin as unknown as {settleScopes(task:Task,o:Observation,incomplete:Set<string>,only:boolean):void;recordOutcome(task:Task,attempt:ActionAttempt,ids:string[]):void};
    const comparisons=vi.spyOn(f.host,'operationCorrespondences'),current=f.host.observation(before.sessionId);
    runtime.settleScopes(f.task,current,new Set(),true);
    expect(comparisons).toHaveBeenCalled();
    expect(childA).toMatchObject({status:'succeeded',attempts:[],coverageResolvedBy:{observation:{observationId:current.id}}});
    expect(childA.resolvedBy).toBeUndefined();expect(childB.status).toBe('pending');expect(childB.coverageResolvedBy).toBeUndefined();expect(parent.status).toBe('superseded');
    f.plugin.store.save(f.task);
    expect(()=>f.plugin.revise(f.task.id,{itemIds:[parent.id]},true)).toThrowError(expect.objectContaining({code:'SUPERSEDED_SCOPE_SELECT_CHILDREN'}));
    const revised=f.plugin.revise(f.task.id,{itemIds:[childA.id]},true),selected=revised.plan.find(item=>item.id===childA.id)!;
    expect(selected.dispatchScope).toBe(true);expect(conditionSplitIssues(revised.plan).size).toBe(0);
    const b=runAction(f.host,before.sessionId);
    expect(includesScope(revised.plan,b,current)).toBeUndefined();
    const bAttempt=await f.host.execute(before.sessionId,b.id,'actual-B-not-A');
    runtime.recordOutcome(revised,bAttempt,[selected.id]);
    expect(selected).toMatchObject({status:'pending',attempts:[]});expect(selected.resolvedBy).toBeUndefined();
    expect(revised.plan.find(item=>item.id===parent.id)?.status).toBe('superseded');
  }finally{await f.close();}
});

it('blocks a persisted split with changed child authority before observation, session creation or dispatch',async()=>{
  const f=await fixture();try{
    const {children,parent}=await splitSource(f);
    children[0].dispatchScope=true;
    f.plugin.store.save(f.task);await f.restart();
    const create=vi.spyOn(f.host,'createSession'),observe=vi.spyOn(f.host,'observe'),execute=vi.spyOn(f.host,'execute');
    f.plugin.start(f.task.id);await f.plugin.waitForIdle();
    const view=f.plugin.view(f.task.id);
    expect(view.task).toMatchObject({status:'blocked',reason:'condition_split_invalid'});
    expect(view.task.plan.find(item=>item.id===parent.id)).toMatchObject({status:'blocked',reason:'condition_split_invalid:child_authority_mismatch'});
    expect(create).not.toHaveBeenCalled();expect(observe).not.toHaveBeenCalled();expect(execute).not.toHaveBeenCalled();
    expect(view.task.plan.filter(item=>item.conditionLineage?.parentItemId===parent.id)).toHaveLength(2);
  }finally{await f.close();}
});
