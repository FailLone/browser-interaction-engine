import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A diagnostic-only wrapper around the already retained, reviewed fixture.
// It neither changes the product nor writes/retains a graph with relaxed limits.
const here = dirname(fileURLToPath(import.meta.url));
const templatePath = join(here, 'checkpoint.mjs');
const ROOT = '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine';
const collectorPath = join(ROOT, 'packages/adapter-playwright/src/owner-dependencies.ts');
const sha = value => createHash('sha256').update(value).digest('hex');
const expectedTemplate = 'c90d406d4267a5439f1c03591cb1adcb6cfe7bb655450c8384f40a32852b6f15';
const expectedCollector = '11cc1cb66b860c35c3df4c774d0be27a5de0458dccda1e780521c0616a9ad724';
let template = readFileSync(templatePath, 'utf8');
if (sha(template) !== expectedTemplate || sha(readFileSync(collectorPath)) !== expectedCollector) throw Error('Frozen template or collector changed');
const { collectOwnerDependencies } = await import(pathToFileURL(collectorPath));
const originalCollector = collectOwnerDependencies.toString();
const replacements = [];
function replaceExactly(source, from, to, name, expected = 1) {
  const count = source.split(from).length - 1;
  if (count !== expected) throw Error(`${name}: expected ${expected} anchor, saw ${count}`);
  replacements.push({ name, matches: count, removedSha256: sha(from), addedSha256: sha(to) });
  return source.split(from).join(to);
}
let diagnosticCollector = originalCollector;
diagnosticCollector = replaceExactly(diagnosticCollector,
  'if(bytes+additional>limits.bytes){reasons.add("byte_budget");return false}', '', 'bypass aggregate reserve refusal');
diagnosticCollector = replaceExactly(diagnosticCollector,
  'if(bytes>limits.bytes){reasons.add("byte_budget");return incompleteInventory()}', '', 'bypass initial aggregate refusal');
diagnosticCollector = replaceExactly(diagnosticCollector,
  'if(size(result)>limits.bytes){reasons.add("byte_budget");return incompleteInventory()}', '', 'bypass final aggregate clear');

function summarizeCosts(graph, input, mapping) {
  const encoder = new TextEncoder(), bytes = value => encoder.encode(JSON.stringify(value)).byteLength;
  const requiredIds = new Set([...input.requiredIds, input.targetLocalId]);
  const requiredRoots = [...requiredIds].map(localId => graph.roots.find(root => root.localId === localId) || { localId, complete: false, reasons: ['root_not_retained'] });
  const nativeRoots = graph.nativeRoots || [];
  const requiredClosureIds = new Set([...requiredRoots, ...nativeRoots].map(root => root.closureId).filter(Boolean));
  const requiredClosures = graph.closures.filter(closure => requiredClosureIds.has(closure.id));
  const requiredNodeIds = new Set(requiredClosures.flatMap(closure => closure.nodeIds));
  const requiredReferenceIds = new Set(requiredClosures.flatMap(closure => closure.referenceIds));
  const requiredNodes = graph.nodes.filter(node => requiredNodeIds.has(node.id));
  const requiredReferences = graph.references.filter((_, index) => requiredReferenceIds.has(index));
  const projectRoot = root => ({ localId: root.localId, instanceId: root.instanceId, ownerId: root.ownerId, closureId: root.closureId,
    diagnosticClosureComplete: root.complete, reasons: root.reasons });
  const reasonCounts = roots => roots.reduce((counts, root) => {
    for (const reason of root.reasons) counts[reason] = (counts[reason] || 0) + 1;
    return counts;
  }, {});
  const members = Object.fromEntries(Object.entries(graph).map(([key, value]) => [key, {
    valueBytes: bytes(value), memberBytes: bytes({ [key]: value }) - 2,
    ...(Array.isArray(value) ? { entries: value.length } : {}),
  }]));
  const framingBytes = 2 + Math.max(0, Object.keys(graph).length - 1);
  const serializedBytes = bytes(graph), sumMemberBytes = Object.values(members).reduce((sum, item) => sum + item.memberBytes, 0);
  if (serializedBytes !== framingBytes + sumMemberBytes) throw Error('JSON component accounting does not reconcile');
  const categories = {
    nodes: members.nodes.memberBytes, closures: members.closures.memberBytes, roots: members.roots.memberBytes,
    nativeRoots: members.nativeRoots?.memberBytes || 0, references: members.references.memberBytes,
    inventories: members.selectorIds.memberBytes + (members.nativeInputIds?.memberBytes || 0),
  };
  categories.headerAndFraming = serializedBytes - Object.values(categories).reduce((sum, value) => sum + value, 0);
  const countIds = values => values.length;
  const rootMetadata = { controlRoots: bytes(graph.roots), nativeRoots: bytes(nativeRoots), inventories: bytes(graph.selectorIds) + bytes(graph.nativeInputIds || []),
    allClosureMetadata: bytes(graph.closures), requiredClosureMetadata: bytes(requiredClosures) };
  const requiredRecordBytes = { nodes: bytes(requiredNodes), closures: bytes(requiredClosures), roots: bytes(requiredRoots),
    nativeRoots: bytes(nativeRoots), references: bytes(requiredReferences), inventories: bytes(graph.selectorIds) + bytes(graph.nativeInputIds || []) };
  const nodeFields = {};
  for (const node of graph.nodes) for (const [key, value] of Object.entries(node)) {
    const row = nodeFields[key] ||= { records: 0, valueBytes: 0, memberBytes: 0 };
    row.records++; row.valueBytes += bytes(value); row.memberBytes += bytes({ [key]: value }) - 2;
  }
  const closureMembership = graph.closures.reduce((totals, closure) => {
    totals.nodeIdOccurrences += closure.nodeIds.length;
    totals.nodeIdArrayBytes += bytes(closure.nodeIds);
    totals.referenceIdOccurrences += closure.referenceIds.length;
    totals.subtreeIdOccurrences += (closure.subtreeIds || []).length;
    return totals;
  }, { nodeIdOccurrences: 0, nodeIdArrayBytes: 0, referenceIdOccurrences: 0, subtreeIdOccurrences: 0 });
  const incompleteRefs = graph.references.map((ref, index) => ({ ...ref, index })).filter(ref => ref.status !== 'unique').map(ref => ({
    index: ref.index, sourceId: ref.sourceId, attribute: ref.attribute, token: ref.token, status: ref.status,
    targetIds: ref.targetIds, required: requiredReferenceIds.has(ref.index),
  }));
  return { status: 'diagnostic_only_aggregate_byte_limit_bypassed', collectorCalled: true, proofEligible: false, mapping,
    graph: { version: graph.version, limits: graph.limits, diagnosticInventoryComplete: graph.inventoryComplete,
      diagnosticComplete: graph.complete, reasons: graph.reasons, nodes: graph.nodes.length, roots: graph.roots.length,
      nativeRoots: nativeRoots.length, closures: graph.closures.length, references: graph.references.length,
      nativeInputs: graph.nativeInputIds?.length, originalByteCeiling: graph.limits.bytes, diagnosticBytes: serializedBytes,
      exceedsOriginalByteCeiling: serializedBytes > graph.limits.bytes },
    costs: { serializedBytes, categories, members, framingBytes, sumMemberBytes, accountingReconciled: true, rootMetadata, nodeFields,
      closureMembership, requiredRecordBytes, requiredRecordArraysBytes: Object.values(requiredRecordBytes).reduce((sum, value) => sum + value, 0),
      requiredRecordsCaveat: 'Subset arrays use the current representation and original reference indexes. They omit unrelated roots/closures and are not a valid complete inventory or a lower bound for another encoding.' },
    required: { controls: requiredRoots.length, diagnosticCompleteControls: requiredRoots.filter(root => root.complete).length,
      diagnosticCompleteNativeRoots: nativeRoots.filter(root => root.complete).length, nativeRoots: nativeRoots.length,
      closures: requiredClosures.length, capturedUnionNodes: requiredNodes.length, referenceUnion: requiredReferences.length,
      rootReasonCounts: reasonCounts(requiredRoots), nativeRootReasonCounts: reasonCounts(nativeRoots),
      incompleteRoots: requiredRoots.filter(root => !root.complete).map(projectRoot), incompleteNativeRoots: nativeRoots.filter(root => !root.complete).map(projectRoot) },
    failures: { allControlRootReasonCounts: reasonCounts(graph.roots), nativeRootReasonCounts: reasonCounts(nativeRoots), incompleteReferences: incompleteRefs,
      nodeBudgetClosureCount: graph.closures.filter(closure => closure.reasons.includes('node_budget')).length,
      requiredNodeBudgetClosures: requiredClosures.filter(closure => closure.reasons.includes('node_budget')).map(closure => ({ id: closure.id, capturedNodes: closure.nodeIds.length, reasons: closure.reasons })) },
    generatedGraphPersisted: false, currentUrl: location.href, baseURI: document.baseURI };
}

template = replaceExactly(template, "const OUTPUT = join(OUT, 'result.json');", "const OUTPUT = join(OUT, 'cost-result.json');", 'separate single output');
template = replaceExactly(template, 'fileURLToPath(import.meta.url)', `fileURLToPath(${JSON.stringify(import.meta.url)})`, 'wrapper file provenance', 2);
template = replaceExactly(template, "const { collectOwnerDependencies } = await import(pathToFileURL(join(ROOT, COLLECTOR)));",
  `const memoryCollector = ${JSON.stringify(diagnosticCollector)};`, 'diagnostic-only memory function');
template = replaceExactly(template, '${collectOwnerDependencies.toString()}', '${memoryCollector}', 'use memory function');
const start = template.indexOf('        const counts = {};');
const endAnchor = '          generatedGraphPersisted: false, currentUrl: location.href, baseURI: document.baseURI };';
const end = template.indexOf(endAnchor, start) + endAnchor.length;
if (start < 0 || end < start || template.indexOf(endAnchor, end) !== -1) throw Error('Analysis return block is not unique');
template = replaceExactly(template, template.slice(start, end), `        return (${summarizeCosts.toString()})(graph, input, mapping);`, 'return cost summary only');
template = replaceExactly(template, "format: 'native-capture-static-budget-checkpoint-v1'", "format: 'native-capture-static-cost-diagnosis-v1'", 'diagnostic report format');
const prepStart = template.indexOf('  preparationRetry: { reason:');
const prepEnd = template.indexOf('  database: { before:', prepStart);
if (prepStart < 0 || prepEnd < prepStart) throw Error('Prior checkpoint-specific retry block absent');
template = replaceExactly(template, template.slice(prepStart, prepEnd), '', 'do not attribute prior launch to this diagnosis');
const diagnostics = { template: { path: templatePath, sha256: expectedTemplate }, originalCollectorSourceSha256: sha(originalCollector),
  diagnosticCollectorSourceSha256: sha(diagnosticCollector), transformations: replacements,
  proofEligible: false, collectorProductChanged: false, limitsChanged: false,
  retainedByteChecks: 'Field attribute/text/live-value limits remain 131072; only aggregate allocation and final serialization refusals are bypassed.',
  reason: 'The original bounded checkpoint cleared its graph; this separate single diagnosis determines where aggregate bytes are spent.',
  boundedCheckpoint: { path: join(here, 'result.json'), sha256: sha(readFileSync(join(here, 'result.json'))) } };
const insertAt = "if (!report.originalEvidence.unchanged) throw Error('Original source evidence changed');";
template = replaceExactly(template, insertAt, `${insertAt}\nreport.diagnostic = ${JSON.stringify(diagnostics)};\nreport.diagnostic.transformedTemplateSha256 = process.env.BIE_STATIC_COST_TEMPLATE_HASH;`, 'retain transform provenance');
// The final module hash is passed as data; no provider/browser/database setting is changed.
const transformedHash = sha(template);
const previousHash = process.env.BIE_STATIC_COST_TEMPLATE_HASH;
process.env.BIE_STATIC_COST_TEMPLATE_HASH = transformedHash;
try { await import(`data:text/javascript;base64,${Buffer.from(template).toString('base64')}`); }
finally {
  if (previousHash === undefined) delete process.env.BIE_STATIC_COST_TEMPLATE_HASH; else process.env.BIE_STATIC_COST_TEMPLATE_HASH = previousHash;
}
if (sha(readFileSync(templatePath)) !== expectedTemplate || sha(readFileSync(collectorPath)) !== expectedCollector) throw Error('Original template or product collector changed');
