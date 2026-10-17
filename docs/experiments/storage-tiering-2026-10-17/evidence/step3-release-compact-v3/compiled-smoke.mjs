import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createOwnerDependencyCodec } from '@interaction/adapter-playwright';

// Check emitted public API only; no adapter/driver or browser is constructed.
const resolved = import.meta.resolve('@interaction/adapter-playwright');
assert.ok(resolved.startsWith('file://' + process.cwd() + '/packages/') && resolved.endsWith('/dist/index.js'), resolved);
assert.equal(typeof createOwnerDependencyCodec, 'function');
const codec = createOwnerDependencyCodec(), documentId = 'compiled-codec-document';
const node = (id, parentId, tag) => ({ id, parentId, tag, attributes: Object.create(null), childrenComplete: false, complete: true, reasons: [] });
const nodes = [node('html', '', 'html'), node('body', 'html', 'body'), node('section', 'body', 'section'), node('input', 'section', 'input')];
Object.assign(nodes[2], { childrenComplete: true, children: [{ nodeId: 'input' }] });
Object.assign(nodes[3], { childrenComplete: true, children: [], live: { value: 'A', checked: false, indeterminate: false, readOnly: false, multiple: false, disabled: false }, associations: { formId: '', labelIds: [] } });
Object.assign(nodes[3].attributes, { type: 'hidden', 'aria-controls': 'absent' });
const raw = { version: 'browser-owner-dependencies-v2', documentId, baseURI: 'https://fixture.invalid/',
  inventoryComplete: true, complete: true, reasons: [], ancestry: 'node-bounded-v1',
  limits: { nodes: 768, references: 64, bytes: 196608, depth: 16 }, selectorIds: [], nativeInputIds: ['input'], roots: [],
  nativeRoots: [{ instanceId: 'input', ownerId: 'section', closureId: 'section', complete: true, reasons: [] }], nodes,
  references: [{ sourceId: 'input', attribute: 'aria-controls', token: 'absent', status: 'missing', targetIds: [], lookup: { scope: 'document-light-dom', documentId, matches: 0 } }],
  closures: [{ id: 'section', subtreeId: 'section', nodeIds: ['html', 'body', 'section', 'input'], referenceIds: [0], subtreeIds: ['section'], complete: true, reasons: [] }] };
const compact = codec.encode(raw);
assert.ok(compact); assert.equal(compact.version, 'browser-owner-dependencies-v3');
assert.deepEqual(codec.decode(compact), raw);
const builder = codec.createBuilder({ ...raw, nodes: [], references: [], closures: [] });
assert.ok(builder); assert.equal(typeof builder.capPayloadBytes, 'function');
assert.equal(builder.capPayloadBytes(131072), true);
for (const item of raw.nodes) assert.equal(builder.addNode(item), true);
assert.equal(builder.addReference(raw.references[0]), 0);
assert.equal(builder.addClosure(raw.closures[0]), true);
assert.deepEqual(codec.decode(builder.finish({ inventoryComplete: true, complete: true, reasons: [] })), raw);
const report = { node: process.version, resolved, publicCodecFactory: 'passed', publicPayloadCap: 'passed',
  compactVersion: compact.version, exactRoundtrip: true, incrementalRoundtrip: true,
  wireBytes: Buffer.byteLength(JSON.stringify(compact)), wireSha256: createHash('sha256').update(JSON.stringify(compact)).digest('hex'),
  browserDriverCalls: 0, openedPersistentTaskDatabases: 0,
  scope: 'Compiled codec API and exact data roundtrip only; no receipt permission, live recovery, or performance conclusion.' };
writeFileSync(process.env.BIE_RELEASE_CODEC_RESULT, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
// Exactly one execution of the immutable existing retained-receipt checkpoint.
await import('./legacy-compiled-smoke.mjs');
