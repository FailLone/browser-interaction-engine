import { describe, expect, it } from 'vitest';
import { canonical, hash } from '@interaction/core';
import { createOwnerDependencyCodec } from '../packages/adapter-playwright/src/owner-dependency-codec.js';
import type { CompactOwnerDependencies, OwnerDependencies, OwnerDependencyNode } from '../packages/adapter-playwright/src/types.js';

const codec = createOwnerDependencyCodec();
const node = (id: string, changes: Partial<OwnerDependencyNode> = {}): OwnerDependencyNode => ({ id, parentId: '', tag: 'input', attributes: {},
  childrenComplete: false, complete: true, reasons: [], ...changes });
function graph(): OwnerDependencies {
  const attributes = JSON.parse('{"__proto__":"kept","id":"field","data-value":"é😀\\ud800\\n\\u0000"}') as Record<string, string>;
  return { version: 'browser-owner-dependencies-v2', documentId: 'doc', baseURI: 'https://example.invalid/', limits: { nodes: 512, references: 64, bytes: 131072, depth: 16 },
    inventoryComplete: true, complete: false, reasons: ['target_not_captured'], selectorIds: ['local'], nativeInputIds: ['field', 'hidden'],
    nodes: [node('html', { tag: 'html', childrenComplete: true, children: [{ nodeId: 'field' }, { text: '0' }, { text: '' }], live: {}, associations: {}, resolved: {} }),
      node('field', { parentId: 'html', attributes, live: { value: '', checked: false, indeterminate: true, disabled: false, multiple: false, readOnly: true },
        associations: { formId: '', labelIds: [] }, resolved: { href: '' }, children: [] })],
    roots: [{ localId: 'local', instanceId: 'field', ownerId: 'html', closureId: 'html', complete: true, reasons: [] }],
    nativeRoots: [{ instanceId: 'hidden', ownerId: 'uncaptured-owner', closureId: 'uncaptured-owner', complete: false, reasons: ['target_not_captured'] }],
    references: [{ sourceId: 'field', attribute: 'aria-controls', token: 'absent', status: 'missing', targetIds: [] }],
    closures: [{ id: 'html', subtreeId: 'html', nodeIds: ['html', 'field'], referenceIds: [0], subtreeIds: ['html'], complete: false, reasons: ['missing_idref'] }] };
}
function empty(raw = graph()) { return { ...raw, nodes: [], references: [], closures: [] }; }
const byteLength = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

it('round trips raw semantics, optional empties, legal attribute keys and uncaptured IDs without granting completeness', () => {
  const raw = graph(), before = structuredClone(raw), wire = codec.encode(raw)!;
  expect(wire.version).toBe('browser-owner-dependencies-v3'); expect(byteLength(wire)).toBeLessThanOrEqual(131072);
  const decoded = codec.decode(wire)!;
  expect(canonical(decoded)).toBe(canonical(raw)); expect(hash(decoded)).toBe(hash(raw)); expect(raw).toEqual(before);
  expect(Object.hasOwn(decoded.nodes[1].attributes, '__proto__')).toBe(true); expect(decoded.nodes[1].attributes.__proto__).toBe('kept');
  expect(decoded.nodes[0]).toMatchObject({ live: {}, resolved: {}, associations: {} });
  expect(decoded.nodes[1]).toMatchObject({ associations: { formId: '', labelIds: [] }, children: [] });
  expect(decoded.nativeRoots![0]).toEqual(raw.nativeRoots![0]); expect(decoded.nodes.some(n => n.id === 'hidden')).toBe(false);
  expect(codec.encode(raw)).toEqual(wire);
});

it('preserves explicit lookup/ancestry only when present and rejects unknown profiles', () => {
  const legacy = graph(), raw = graph(); raw.ancestry = 'node-bounded-v1';
  raw.references[0].lookup = { scope: 'document-light-dom', documentId: 'doc', matches: 0 };
  expect(canonical(codec.decode(codec.encode(raw)))).toBe(canonical(raw));
  const decoded = codec.decode(codec.encode(legacy))!;
  expect(Object.hasOwn(decoded, 'ancestry')).toBe(false); expect(Object.hasOwn(decoded.references[0], 'lookup')).toBe(false);
  for (const change of [(r: any) => r.ancestry = 'unknown', (r: any) => r.references[0].lookup.scope = 'frame', (r: any) => r.references[0].lookup.matches = 3]) {
    const invalid = structuredClone(raw); change(invalid); expect(codec.encode(invalid)).toBeUndefined();
  }
});

it('does not normalize or upgrade legacy v1/v2 inputs through the v3 decoder', () => {
  const v2 = graph(), v1 = { ...graph(), version: 'browser-owner-dependencies-v1' as const };
  const before = [canonical(v1), canonical(v2)];
  expect(codec.decode(v1)).toBeUndefined(); expect(codec.decode(v2)).toBeUndefined(); expect(codec.encode(v1)).toBeUndefined();
  expect([canonical(v1), canonical(v2)]).toEqual(before);
});

it('incrementally accounts replacements and detaches rows and completed outputs from mutable input', () => {
  const raw = graph(), b = codec.createBuilder(empty(raw))!;
  for (const n of raw.nodes) expect(b.addNode(n)).toBe(true);
  expect(b.addReference(raw.references[0])).toBe(0); expect(b.addClosure(raw.closures[0])).toBe(true);
  expect(b.replaceNode(1, { ...raw.nodes[1], live: { value: 'changed' } })).toBe(true);
  const summary = { inventoryComplete: true, complete: false, reasons: [] };
  const first = b.finish(summary)!;
  expect(byteLength(first)).toBe(b.stats().wireBytes + byteLength(summary) - byteLength({ inventoryComplete: raw.inventoryComplete, complete: raw.complete, reasons: raw.reasons }));
  raw.nodes[0].tag = 'changed-after-append'; first.ids[0] = 'changed-after-finish';
  const second = b.finish(summary)!; expect(codec.decode(second)!.nodes[0].tag).toBe('html');
  expect(codec.decode(second)!.nodes[1].live).toEqual({ value: 'changed' });
  expect(byteLength(codec.decode(b.finish({ inventoryComplete: raw.inventoryComplete, complete: raw.complete, reasons: raw.reasons })))).toBe(b.stats().expandedBytes);
});

it('rolls back dictionaries, rows and both counters after an over-budget append or replacement', () => {
  const raw = empty(); raw.limits.bytes = 4000; const b = codec.createBuilder(raw)!;
  expect(b.addNode(node('first'))).toBe(true);
  const summary = { inventoryComplete: false, complete: false, reasons: [] }, before = b.finish(summary)!, counters = b.stats();
  expect(b.addNode(node('never-intern-this', { attributes: { payload: 'x'.repeat(5000) } }))).toBe(false);
  expect(b.stats().failure).toBe('byte_budget'); expect(b.finish(summary)).toEqual(before);
  expect(b.replaceNode(0, node('first', { parentId: 'never-intern-parent', attributes: { payload: 'x'.repeat(5000) } }))).toBe(false);
  expect(b.finish(summary)).toEqual(before); expect(b.stats()).toMatchObject({ wireBytes: counters.wireBytes, expandedBytes: counters.expandedBytes });
  expect(b.addNode(node('later'))).toBe(true); expect(codec.decode(b.finish(summary))!.nodes.map(n => n.id)).toEqual(['first', 'later']);
});

it('keeps root inventory replacements atomic and does not replace a root identity', () => {
  const raw = empty(), b = codec.createBuilder(raw)!;
  expect(b.replaceRoot(0, { ...raw.roots[0], complete: false, reasons: ['node_budget'] })).toBe(true);
  expect(b.replaceNativeRoot(0, { ...raw.nativeRoots![0], reasons: ['byte_budget'] })).toBe(true);
  const summary = { inventoryComplete: true, complete: false, reasons: [] }, before = b.finish(summary)!;
  expect(b.replaceRoot(0, { ...raw.roots[0], localId: 'wrong' })).toBe(false);
  expect(b.finish(summary)).toEqual(before);
});

describe('strict wire rejection', () => {
  const changes: [string, (w: any) => void][] = [
    ['fractional dictionary reference', w => w.nodes[0][0] = 0.5], ['negative non-absence reference', w => w.roots[0][0] = -1],
    ['out of range dictionary reference', w => w.nodes[0][0] = w.ids.length], ['duplicate dictionary strings', w => w.ids.push(w.ids[0])],
    ['extra node slot', w => w.nodes[0].push(0)], ['missing node slot', w => w.nodes[0].pop()],
    ['wrong optional slot', w => w.nodes[0][6] = false], ['bad boolean', w => w.nodes[0][4] = 0],
    ['bad native value', w => w.nodes[1][6].value = 3], ['invalid reference status', w => w.references[0][3] = 3],
    ['out of range reference row', w => w.closures[0][3] = [w.references.length]], ['duplicate node identity', w => w.nodes.push(w.nodes[0])],
    ['unknown header property', w => w.authorization = true], ['unknown ancestry', w => w.ancestry = 'all-ancestors'],
    ['missing native inventory', w => delete w.nativeInputIds], ['lookup missing document', w => w.references[0].push([w.ids.length, 0])],
    ['lookup invalid count', w => w.references[0].push([0, 3])], ['limits increased', w => w.limits.nodes = 769],
    ['prototype attribute value', w => w.nodes[0][3].x = { value: 'bad' }],
  ];
  it.each(changes)('rejects %s', (_name, change) => {
    const wire = structuredClone(codec.encode(graph())!); change(wire); expect(codec.decode(wire)).toBeUndefined();
  });
});

it('rejects wire size and decoded dictionary expansion independently', () => {
  const wire = codec.encode(graph())!;
  const tooLarge = structuredClone(wire); tooLarge.ids.push('x'.repeat(131072)); expect(codec.decode(tooLarge)).toBeUndefined();
  const bomb = structuredClone(wire); bomb.ids.push('x'.repeat(2000)); const index = bomb.ids.length - 1;
  bomb.roots = Array.from({ length: 500 }, () => [index, index, index, index, false, []]);
  expect(byteLength(bomb)).toBeLessThan(131072); expect(codec.decode(bomb)).toBeUndefined();
  const initial = empty(); initial.documentId = 'x'.repeat(1048576); expect(codec.createBuilder(initial)).toBeUndefined();
});

it('rejects cycles, accessors, sparse tuples and prototype tricks without invoking getters', () => {
  const invalid = graph() as any; invalid.nodes[0].attributes.loop = invalid; expect(codec.encode(invalid)).toBeUndefined();
  const wire = codec.encode(graph())!; const sparse = structuredClone(wire); delete (sparse.nodes[0] as any)[0]; expect(codec.decode(sparse)).toBeUndefined();
  let reads = 0; Object.defineProperty(wire.nodes[0][3], 'x', { enumerable: true, get() { reads++; return 'x'; } });
  expect(codec.decode(wire)).toBeUndefined(); expect(reads).toBe(0);
  for (const value of [codec.encode(graph())!, codec.encode(graph())!.nodes[0]]) {
    const bad = codec.encode(graph())!;
    Object.defineProperty(Array.isArray(value) ? bad.nodes[0] : bad, 'hidden', { value: 'not-in-json' });
    expect(codec.decode(bad)).toBeUndefined();
  }
});

it('compresses exact repeated typed IDs while preserving every raw dependency record', () => {
  const raw = graph(); raw.roots = []; raw.nodes = []; raw.closures = []; raw.references = []; raw.nativeRoots = []; raw.selectorIds = []; raw.nativeInputIds = [];
  for (let i = 0; i < 120; i++) {
    const id = `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:${i}`;
    raw.nodes.push(node(id)); raw.roots.push({ localId: id, instanceId: id, ownerId: id, closureId: id, complete: true, reasons: [] });
    raw.closures.push({ id, subtreeId: id, nodeIds: raw.nodes.map(n => n.id), referenceIds: [], subtreeIds: [id], complete: true, reasons: [] });
  }
  const wire = codec.encode(raw)!; expect(wire).toBeDefined(); expect(byteLength(raw)).toBeGreaterThan(131072);
  expect(byteLength(wire)).toBeLessThan(131072); expect(canonical(codec.decode(wire))).toBe(canonical(raw));
  // A representation example, not a wall-clock benchmark or a real page proof.
});

it('factory remains browser-serializable without imports or module helpers', () => {
  const isolated = new Function(`const __name = fn => fn; return (${createOwnerDependencyCodec.toString()})();`)() as ReturnType<typeof createOwnerDependencyCodec>;
  expect(canonical(isolated.decode(isolated.encode(graph())))).toBe(canonical(graph()));
});

describe('compact resource profile', () => {
  function initial(): OwnerDependencies {
    return { ...empty(), limits: { nodes: 768, references: 64, bytes: 196608, depth: 16 },
      roots: [], nativeRoots: [], selectorIds: [], nativeInputIds: [] };
  }
  const summary = { inventoryComplete: true, complete: false, reasons: [] };

  it('accepts 768 nodes and rejects the 769th without changing the bounded graph', () => {
    const builder = codec.createBuilder(initial())!;
    for (let i = 0; i < 768; i++) expect(builder.addNode(node(`node-${i}`))).toBe(true);
    const wire = builder.finish(summary)!;
    expect(codec.decode(wire)?.nodes).toHaveLength(768);
    expect(builder.addNode(node('node-768'))).toBe(false);
    expect(builder.stats().failure).toBe('node_budget'); expect(builder.finish(summary)).toEqual(wire);
    const extra = structuredClone(wire), index = extra.ids.push('node-768') - 1, extraNode = structuredClone(extra.nodes[0]);
    extraNode[0] = index; extra.nodes.push(extraNode);
    expect(codec.decode(extra)).toBeUndefined();
    const declared = structuredClone(wire); declared.limits.nodes = 769;
    expect(codec.decode(declared)).toBeUndefined();
    expect(codec.createBuilder({ ...initial(), limits: { ...initial().limits, nodes: 769 } })).toBeUndefined();
  });

  it('accepts wire up to 196608 bytes and rejects payload or declarations beyond that bound', () => {
    const builder = codec.createBuilder(initial())!;
    const value = node('large', { attributes: { payload: 'x'.repeat(150000) } });
    expect(builder.addNode(value)).toBe(true);
    const wire = builder.finish(summary)!;
    expect(byteLength(wire)).toBeGreaterThan(131072); expect(byteLength(wire)).toBeLessThan(196608);
    expect(codec.decode(wire)?.nodes).toEqual([value]);
    const boundary = structuredClone(wire);
    boundary.nodes[0][3].payload += 'x'.repeat(196608 - byteLength(boundary));
    expect(byteLength(boundary)).toBe(196608); expect(codec.decode(boundary)).toBeDefined();
    boundary.nodes[0][3].payload += 'x'; expect(codec.decode(boundary)).toBeUndefined();
    const declared = structuredClone(wire); declared.limits.bytes = 196609;
    expect(codec.decode(declared)).toBeUndefined();
    expect(builder.replaceNode(0, node('large', { attributes: { payload: 'x'.repeat(196608) } }))).toBe(false);
    expect(builder.stats().failure).toBe('byte_budget'); expect(builder.finish(summary)).toEqual(wire);
  });

  it('caps later payload transactionally while final summary still uses the hard byte bound', () => {
    const builder = codec.createBuilder(initial())!;
    expect(builder.addNode(node('required'))).toBe(true);
    const wire = builder.finish(summary)!, counters = builder.stats(), cap = counters.wireBytes + counters.reservedBytes + 256;
    expect(builder.capPayloadBytes(cap)).toBe(true);
    for (const invalid of [counters.wireBytes + counters.reservedBytes - 1, cap + 1, 196609, NaN, cap - 0.5]) {
      expect(builder.capPayloadBytes(invalid)).toBe(false);
      expect(builder.finish(summary)).toEqual(wire); expect(builder.stats()).toEqual(counters);
    }
    expect(builder.addNode(node('never-intern', { attributes: { payload: 'x'.repeat(1000) } }))).toBe(false);
    expect(builder.replaceNode(0, node('required', { parentId: 'never-intern-parent', attributes: { payload: 'x'.repeat(1000) } }))).toBe(false);
    expect(builder.stats().failure).toBe('byte_budget'); expect(builder.finish(summary)).toEqual(wire);
    expect(builder.addNode(node('small-optional'))).toBe(true);
    expect(codec.decode(builder.finish(summary))?.nodes.map(n => n.id)).toEqual(['required', 'small-optional']);
    const final = builder.finish({ ...summary, reasons: ['x'.repeat(2048)] })!;
    expect(byteLength(final)).toBeGreaterThan(cap); expect(byteLength(final)).toBeLessThan(196608);
    expect(codec.decode(final)?.reasons).toEqual(['x'.repeat(2048)]);
  });
});
