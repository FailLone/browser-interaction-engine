import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractionEngine, type EngineHooks, type ExplorationGroupProposal, type ExplorationGroupResolution, type ExplorationReviewMaterial } from '@interaction/core';
import { MemoryStore } from '@interaction/storage-memory';
import { SqliteStore } from '@interaction/storage-sqlite';
import { CounterAdapter, type CounterObservation } from '../examples/counter-adapter.js';

const evidence = [{ source: 'test', rule: 'observed-owner/v1', facts: { owner: 'counter' } }];
const reason = { source: 'test', evidence: ['Explicitly chosen work'] };
const proposal = (key: string, ids: string[]): ExplorationGroupProposal => ({ key, kind: 'custom', label: key, conditions: { goal: 'counter' },
  collection: { key: 'owner', label: 'Counter work', evidence }, actionIds: ids, traversalActionIds: [], evidence });
const scopes: EngineHooks<CounterObservation>['explorationScopes'] = actions => ['region', 'branch'].map(k => proposal(k, actions.map(a => a.id)));
const engineFor = (hooks: EngineHooks<CounterObservation> = {}) => new InteractionEngine({ adapter: new CounterAdapter(), persistence: new MemoryStore(), hooks: { explorationScopes: scopes, ...hooks } });
const resolutions = (material: ExplorationReviewMaterial): ExplorationGroupResolution[] => material.groups.map(g => ({ groupId: g.id, revision: g.revision, decision: { ...reason, mode: 'all' } }));

it('returns detached read-only material with exact overlaps and preserves independent grants', async () => {
  const e = engineFor();
  try {
    const s = await e.createSession({ maxActions: 1 }); const before = e.store.events(s.id);
    const m = e.explorationReviewMaterial(s.id);
    expect(m.collections).toHaveLength(1); expect(m.collections[0].groupIds).toHaveLength(2);
    expect(m.requestedGroupIds).toEqual([]); expect(m.overlaps).toEqual([{ groupIds: m.groups.map(g => g.id).sort(), caseKeys: [m.groups[0].members[0].key] }]);
    m.groups[0].status = 'decided'; m.collections[0].groupIds.length = 0;
    expect(e.explorationReviewMaterial(s.id).groups[0].status).toBe('pending'); expect(e.store.events(s.id)).toEqual(before);
    const batch = resolutions(e.explorationReviewMaterial(s.id)); batch[1].decision = { ...reason, mode: 'defer' };
    await e.decideExplorationGroups(s.id, batch);
    expect(e.session(s.id).actionCount).toBe(0); expect(e.getFrontier(s.id)[0].reason).toBe('exploration_deferred_by_caller');
    const latest = resolutions(e.explorationReviewMaterial(s.id)); await e.decideExplorationGroups(s.id, latest);
    expect(e.getFrontier(s.id)[0].status).toBe('pending'); expect(e.session(s.id).actionCount).toBe(0);
    await e.explore(s.id); await e.waitForIdle(); expect(e.observation(s.id).count).toBe(1);
    expect(e.store.events(s.id).filter(ev => ev.type === 'exploration.groups_decided')).toHaveLength(2);
  } finally { await e.close(); }
});

for (const storage of ['memory', 'sqlite']) it(`rejects entire invalid batches with no partial state or decision events (${storage})`, async () => {
  const directory = storage === 'sqlite' ? mkdtempSync(join(tmpdir(), 'review-batch-')) : undefined;
  const e = new InteractionEngine({ adapter: new CounterAdapter(), persistence: directory ? new SqliteStore(directory) : new MemoryStore(), hooks: { explorationScopes: scopes } });
  try {
    const s = await e.createSession({}); await e.stop(s.id); const other = await e.createSession({});
    const original = e.explorationReviewMaterial(s.id); const frontier = e.getFrontier(s.id);
    const batch = resolutions(original); const foreign = resolutions(e.explorationReviewMaterial(other.id))[0];
    const failures = [
      [batch[0], { ...batch[1], revision: 999 }], [batch[0], foreign], [batch[0], batch[0]],
      [batch[0], { ...batch[1], decision: { ...reason, mode: 'sample', memberKeys: ['unobserved'] } }],
      [batch[0], { ...batch[1], decision: { ...reason, mode: 'sample', memberKeys: [original.groups[1].members[0].key, original.groups[1].members[0].key] } }],
      [], [batch[0], { ...batch[1], decision: { mode: 'all' } }],
    ];
    for (const failure of failures) {
      await expect(e.decideExplorationGroups(s.id, failure as ExplorationGroupResolution[])).rejects.toBeDefined();
      expect(e.explorationReviewMaterial(s.id)).toEqual(original); expect(e.getFrontier(s.id)).toEqual(frontier);
      expect(e.store.events(s.id).filter(ev => ['exploration.group_decided', 'exploration.groups_decided'].includes(ev.type))).toEqual([]);
    }
    await e.decideExplorationGroups(s.id, batch);
    expect(e.explorationReviewMaterial(s.id).groups.every(g => g.status === 'decided')).toBe(true);
  } finally { await e.close(); if (directory) rmSync(directory, { recursive: true, force: true }); }
});

it('calls one batch hook ahead of individual hooks, excludes new scopes from previous grants, and keeps membership updates queryable', async () => {
  const materials: ExplorationReviewMaterial[] = []; let extra = false;
  const e = engineFor({ explorationScopes: actions => [...scopes!(actions, {} as never) as ExplorationGroupProposal[], ...(extra ? [proposal('later', actions.map(a => a.id))] : [])],
    explorationReview: m => { materials.push(structuredClone(m)); const out = resolutions(m).filter(r => m.requestedGroupIds.includes(r.groupId)); if (materials.length === 1) { m.groups.length = 0; return out; } },
    explorationDecision: () => { throw new Error('Individual hook must not run'); }, explorationGroup: () => { throw new Error('Alias must not run'); } });
  try {
    const s = await e.createSession({ maxActions: 1 }); await e.observe(s.id); expect(materials).toHaveLength(1);
    await e.execute(s.id, e.actions(s.id)[0].id, 'advance');
    expect(materials).toHaveLength(1); expect(e.explorationReviewMaterial(s.id).groups[0].members).toHaveLength(2);
    extra = true; await e.observe(s.id); expect(materials).toHaveLength(2);
    expect(materials[1].groups).toHaveLength(3); expect(materials[1].requestedGroupIds).toHaveLength(1);
    const latest = e.explorationReviewMaterial(s.id); expect(latest.groups.find(g => g.label === 'later')?.status).toBe('pending');
    expect(e.getFrontier(s.id).filter(f => !f.attempts.length).every(f => f.status === 'deferred')).toBe(true);
    expect(e.store.events(s.id).filter(ev => ev.type === 'exploration.review_requested')).toHaveLength(2);
    expect(e.store.events(s.id).filter(ev => ev.type === 'hook.error')).toEqual([]);
  } finally { await e.close(); }
});

it.each(['throw', 'empty', 'unknown', 'malformed', 'invalid-sample'] as const)('keeps all decisions pending for %s batch hook output', async failure => {
  const e = engineFor({ explorationReview: m => {
    if (failure === 'throw') throw new Error('Unavailable');
    if (failure === 'empty') return [];
    if (failure === 'malformed') return null as unknown as ExplorationGroupResolution[];
    const batch = resolutions(m);
    if (failure === 'unknown') batch[1].groupId = 'not-presented';
    else batch[1].decision = { ...reason, mode: 'sample', memberKeys: ['unobserved'] };
    return batch;
  }, explorationDecision: () => ({ ...reason, mode: 'all' }) });
  try {
    const s = await e.createSession({}); await e.explore(s.id); await e.waitForIdle();
    expect(e.session(s.id).actionCount).toBe(0); expect(e.explorationReviewMaterial(s.id).groups.every(g => g.decisions.length === 0)).toBe(true);
  } finally { await e.close(); }
});

it('ignores late batch results after a hook timeout', async () => {
  let finish!: () => void;
  const e = engineFor({ explorationReview: m => new Promise(resolve => { finish = () => resolve(resolutions(m)); }) });
  try {
    const s = await e.createSession({}); finish(); await e.observe(s.id);
    expect(e.explorationReviewMaterial(s.id).groups.every(g => g.status === 'pending')).toBe(true);
    expect(e.store.events(s.id).some(ev => ev.type === 'hook.error')).toBe(true);
  } finally { await e.close(); }
});

it('versions changed review provenance and never merges conflicting owner declarations', async () => {
  let changed = false;
  const e = engineFor({ explorationScopes: actions => ['A', 'B'].map(key => ({ ...proposal(key, actions.map(a => a.id)),
    collection: { key: 'same-key', label: 'Same label', evidence: [{ source: 'test', rule: 'owner', facts: { owner: key === 'B' && changed ? 'different' : 'same' } }] } })) });
  try {
    const s = await e.createSession({}); const old = e.explorationReviewMaterial(s.id); expect(old.collections).toHaveLength(1);
    changed = true; await e.observe(s.id); const next = e.explorationReviewMaterial(s.id); expect(next.collections).toHaveLength(2);
    await expect(e.decideExplorationGroups(s.id, resolutions(old))).rejects.toMatchObject({ code: 'STALE_GROUP_DECISION' });
    expect(next.groups.every(g => g.status === 'pending')).toBe(true);
  } finally { await e.close(); }
});

it('excludes invalidated scopes from current material and rejects a batch containing one without changing its valid peer', async () => {
  let goal = 'first';
  const e = engineFor({ explorationScopes: actions => ['A', 'B'].map(key => ({ ...proposal(key, actions.map(a => a.id)), conditions: { goal: key === 'B' ? goal : 'fixed' } })) });
  try {
    const s = await e.createSession({}); const old = e.explorationReviewMaterial(s.id); goal = 'changed'; await e.observe(s.id);
    const current = e.explorationReviewMaterial(s.id);
    expect(current.groups.some(g => g.id === old.groups[1].id)).toBe(false);
    await expect(e.decideExplorationGroups(s.id, resolutions(old))).rejects.toMatchObject({ code: 'EXPLORATION_SCOPE_INVALIDATED' });
    expect(e.explorationReviewMaterial(s.id)).toEqual(current);
    expect(e.store.events(s.id).filter(ev => ['exploration.group_decided', 'exploration.groups_decided'].includes(ev.type))).toEqual([]);
  } finally { await e.close(); }
});
