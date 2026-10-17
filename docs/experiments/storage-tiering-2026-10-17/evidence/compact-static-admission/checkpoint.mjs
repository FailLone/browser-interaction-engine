import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reuse the exact, retained two-frame mapping harness. Keep source evidence once.
// Execute only after all three collector contracts have a fixed commit.
const here = dirname(fileURLToPath(import.meta.url));
const template = join(here, '../native-capture-budget-checkpoint/checkpoint.mjs');
const original = readFileSync(template, 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
if (sha(original) !== 'c90d406d4267a5439f1c03591cb1adcb6cfe7bb655450c8384f40a32852b6f15') throw Error('Retained harness changed');
let source = original;
const replace = (from, to) => {
  if (source.split(from).length !== 2) throw Error(`Expected one harness site: ${from.slice(0, 100)}`);
  source = source.replace(from, to);
};
source = source.replaceAll('import.meta.url', JSON.stringify(import.meta.url));
replace("const COLLECTOR = 'packages/adapter-playwright/src/owner-dependencies.ts';", "const COLLECTOR = 'packages/adapter-playwright/src/owner-dependencies.ts';\nconst CODEC = 'packages/adapter-playwright/src/owner-dependency-codec.ts';");
replace('const beforeCopy = hashFile(COPY);', `if (sha(readFileSync(join(ROOT, CODEC))) !== sha(execFileSync('git', ['show', argv[2] + ':' + CODEC], { cwd: ROOT }))) throw Error('Codec differs from fixed commit');\nconst beforeCopy = hashFile(COPY);`);
replace('const { collectOwnerDependencies } = await import(pathToFileURL(join(ROOT, COLLECTOR)));', 'const { collectOwnerDependencies } = await import(pathToFileURL(join(ROOT, COLLECTOR)));\nconst { createOwnerDependencyCodec } = await import(pathToFileURL(join(ROOT, CODEC)));');
replace('const graph = (${collectOwnerDependencies.toString()})(input.binding.map(row => row.control), elements, instance, input.documentId, input.limits);', 'const codec = (${createOwnerDependencyCodec.toString()})();\n        const wire = (${collectOwnerDependencies.toString()})(input.binding.map(row => row.control), elements, instance, input.documentId, input.limits, (${createOwnerDependencyCodec.toString()}));\n        const graph = codec.decode(wire);\n        if (!graph) return { status: "compact_decode_rejected", mapping, collectorCalled: true, wireVersion: wire.version, wireBytes: new TextEncoder().encode(JSON.stringify(wire)).byteLength };');
replace('graph: { version: graph.version, inventoryComplete:', 'graph: { version: wire.version, semanticVersion: graph.version, ancestry: graph.ancestry, wireBytes: new TextEncoder().encode(JSON.stringify(wire)).byteLength, expandedBytes: new TextEncoder().encode(JSON.stringify(graph)).byteLength, inventoryComplete:');
replace('required: { controls: roots.length, completeControls:', 'required: { unionNodes: new Set([...roots, ...nativeRoots].flatMap(root => graph.closures.find(c => c.id === root.closureId)?.nodeIds || [])).size, incompleteClosures: graph.closures.filter(c => [...roots, ...nativeRoots].some(r => r.closureId === c.id) && !c.complete).map(c => ({ id: c.id, nodes: c.nodeIds.length, reasons: c.reasons })), controls: roots.length, completeControls:');
replace("format: 'native-capture-static-budget-checkpoint-v1'", "format: 'compact-capture-static-admission-v1'");
replace('collector: hashFile(join(ROOT, COLLECTOR)), diagnosis:', `collector: hashFile(join(ROOT, COLLECTOR)), codec: hashFile(join(ROOT, CODEC)), reusedHarness: { path: ${JSON.stringify(template)}, sha256: ${JSON.stringify(sha(original))} }, reason: 'New incremental compact collector plus explicit absence and node-bounded ancestry contracts; previous required evidence exceeded raw byte/depth bounds. This is one admission check, not a performance or restore test.', diagnosis:`);
const start = source.indexOf('  preparationRetry: {');
const end = source.indexOf('  database:', start);
if (start < 0 || end < 0) throw Error('Old preparation metadata not found');
source = source.slice(0, start) + source.slice(end);
await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
