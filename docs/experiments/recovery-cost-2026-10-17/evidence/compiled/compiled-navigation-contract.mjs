
import assert from 'node:assert/strict';
import ts from 'typescript';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { InteractionEngine } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { RetainedPersistence } from '@interaction/storage-retained';
const file = resolve('.data/navigation-public-types.mts');
writeFileSync(file, `
import { BoundedEntityChanges, type EntityChanges, type Persistence } from '@interaction/core';
import type { BrowserEngine } from '@interaction/browser';
import type { RetainedPersistence } from '@interaction/storage-retained';
declare const engine: BrowserEngine, retained: RetainedPersistence, store: Persistence;
type NotAny<T> = 0 extends (1 & T) ? false : true;
type Assert<T extends true> = T;
type FeedIsTyped = Assert<NotAny<ReturnType<NonNullable<Persistence['entityChanges']>>>>;
const changes: EntityChanges | undefined = store.entityChanges?.('attempt', 's');
const wrapped: EntityChanges | undefined = retained.entityChanges?.('attempt', 's');
const browser: EntityChanges | undefined = engine.store.entityChanges?.('attempt', 's');
const cacheable: false | undefined = changes?.cacheable;
new BoundedEntityChanges().changes('attempt', 's');
`);
const options = {module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022, strict: true, skipLibCheck: true, noEmit: true, types: ['node'], customConditions: []};
const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([file], options));
if (diagnostics.length) throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCurrentDirectory: ts.sys.getCurrentDirectory, getCanonicalFileName: x => x, getNewLine: () => '\n'}));
const backing = new MemoryStore(), engine = new InteractionEngine({ persistence: backing });
try {
  assert.equal(typeof engine.store.entityChanges, 'function');
  const initial = engine.store.entityChanges('attempt', 'fixture-session');
  backing.put('attempt', { id: 'fixture-attempt', sessionId: 'fixture-session', status: 'unknown' });
  const delta = engine.store.entityChanges('attempt', 'fixture-session', initial.token);
  assert.equal(delta.reset, false); assert.deepEqual(delta.ids, ['fixture-attempt']);
  const legacy = new Proxy(new MemoryStore(), {get(target, key) {
    if (key === 'entityChanges') return undefined;
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  }});
  const wrapper = new RetainedPersistence(legacy, { sweepIntervalMs: 0 });
  try { assert.equal(wrapper.entityChanges, undefined); } finally { wrapper.close(); }
  console.log('Compiled navigation feed public types, BrowserEngine forwarding, and legacy fallback: passed');
} finally { await engine.close(); }
