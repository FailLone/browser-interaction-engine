/** Preparation reads retained scripts only. --execute requires the root agent's
 * explicit authorization of a settled run and its exclusive temporary DB copy.
 * Reuse run9's fixed wrapper and run8's fixed audit; do not clone their inputs.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine';
const RETAINED = join(dirname(SCRIPT), '../real-okx-9/receipt-audit.mjs');
const RETAINED_SHA256 = 'd099ef3d4135873ce7746af0aa79872838da5ea2df1942c2d754c68e569afe8b';
const RUN_ID = '717bba24-03b5-487f-a96a-b60ef8cd9972';
const sha = value => createHash('sha256').update(value).digest('hex');
let wrapper = readFileSync(RETAINED, 'utf8');
if (sha(wrapper) !== RETAINED_SHA256) throw Error('RUN9_AUDIT_WRAPPER_CHANGED');
const transformations = [];
function replaceWrapper(name, before, after) {
  if (wrapper.split(before).length !== 2) throw Error(`EXPECTED_SINGLE_WRAPPER_TRANSFORM:${name}`);
  wrapper = wrapper.replace(before, after);
  transformations.push({ name, beforeSha256: sha(before), afterSha256: sha(after) });
}
const modules = Object.fromEntries(['@interaction/browser', '@interaction/core', '@interaction/storage-sqlite', '@interaction/adapter-playwright']
  .map(name => [name, import.meta.resolve(name)]));
replaceWrapper('typescript-resolution', "from 'typescript';", `from ${JSON.stringify(import.meta.resolve('typescript'))};`);
replaceWrapper('current-script', 'const SCRIPT = fileURLToPath(import.meta.url);', `const SCRIPT = ${JSON.stringify(SCRIPT)};`);
replaceWrapper('current-source-module-resolution', 'const moduleResolution = Object.fromEntries(names.map(name => [name, import.meta.resolve(name)]));',
  `const moduleResolution = ${JSON.stringify(modules)};`);
replaceWrapper('owned-v3-runs-only', "const RUNS = join(ROOT, '.data/okx-storage-acceptance-20261017-v2/runs');",
  "const RUNS = join(ROOT, '.data/okx-storage-acceptance-20261017-v3/runs');");
replaceWrapper('fixed-run-id', "if (!runDir.startsWith(realpathSync(RUNS) + sep) || dirname(runDir) !== realpathSync(RUNS)) throw Error('REQUIRES_ONE_CLOSED_V2_RUN_DIRECTORY');",
  `if (runDir !== join(realpathSync(RUNS), ${JSON.stringify(RUN_ID)})) throw Error('REQUIRES_FIXED_CLOSED_V3_RUN_DIRECTORY');`);
replaceWrapper('compiled-source-name', "fileName: 'run9-receipt-audit.ts'", "fileName: 'run10-receipt-audit.ts'");

// These diagnostics inspect retained producer facts only. The unchanged SDK
// reader remains responsible for graph reconstruction, authority and coverage.
function mandatorySummary(observation, localId) {
  if (!observation) return { observationAvailable: false, diagnosticOnly: true };
  const wire = observation.ownerDependencies, graph = auditDecodedGraph(observation);
  const base = { observationAvailable: true, observationId: observation.id, targetLocalId: localId,
    targetControlRequired: !!localId, targetCount: observation.controls.filter(c => c.localId === localId).length,
    wireVersion: wire?.version, compactDecodeRejected: wire?.version === 'browser-owner-dependencies-v3' && !graph,
    diagnosticOnly: true, completenessIsNotSdkConditionProof: true };
  if (!graph) return { ...base, graphAvailable: false };
  const nativeTags = ['input', 'select', 'textarea'];
  const observedSelectors = observation.controls.filter(c => c.checked != null || c.pressed != null || c.expanded != null || c.tag === 'select'
    || ['checkbox', 'radio', 'switch', 'tab', 'option', 'treeitem'].includes(c.role)).map(c => c.localId);
  const nativeControls = observation.controls.filter(c => nativeTags.includes(c.tag) || c.editable);
  const required = [...new Set([...(localId ? [localId] : []), ...graph.selectorIds, ...observedSelectors, ...nativeControls.map(c => c.localId)])];
  const sameUniqueSet = (a, b) => a.length === new Set(a).size && b.length === new Set(b).size
    && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const nodes = new Set(graph.nodes.map(n => n.id)), requiredClosures = new Set(), union = new Set();
  function rootSummary(roots, instanceId) {
    const root = roots.length === 1 ? roots[0] : undefined;
    if (root) requiredClosures.add(root.closureId);
    const closures = root ? graph.closures.filter(c => c.id === root.closureId) : [], closure = closures.length === 1 ? closures[0] : undefined;
    const missingNodes = closure?.nodeIds.filter(id => !nodes.has(id)) || [];
    const missingReferences = closure?.referenceIds.filter(id => !Number.isInteger(id) || id < 0 || !graph.references[id]) || [];
    if (closure) for (const id of closure.nodeIds) union.add(id);
    return { instanceId, rootCount: roots.length, ownerId: root?.ownerId, closureId: root?.closureId,
      rootComplete: root?.complete === true, rootReasons: root?.reasons, closureCount: closures.length,
      closureComplete: closure?.complete === true, closureReasons: closure?.reasons,
      nodeCount: closure?.nodeIds.length, referenceCount: closure?.referenceIds.length,
      missingNodes: missingNodes.length, missingReferences: missingReferences.length,
      retainedProducerComplete: !!root && root.instanceId === instanceId && root.complete && !root.reasons.length
        && !!closure && closure.complete && !closure.reasons.length && !missingNodes.length && !missingReferences.length };
  }
  const controls = required.map(id => {
    const matches = observation.controls.filter(c => c.localId === id), c = matches.length === 1 ? matches[0] : undefined;
    const row = rootSummary(graph.roots.filter(r => r.localId === id), c?.instanceId);
    return { localId: id, label: c?.name || c?.label, tag: c?.tag, controlCount: matches.length,
      target: id === localId, selector: observedSelectors.includes(id) || graph.selectorIds.includes(id),
      nativeOrEditable: !!c && (nativeTags.includes(c.tag) || c.editable), readiness: c?.readiness,
      ...row, retainedProducerComplete: !!c && row.retainedProducerComplete };
  });
  const nativeRoots = (graph.nativeRoots || []).map(root => rootSummary(
    (graph.nativeRoots || []).filter(candidate => candidate.instanceId === root.instanceId), root.instanceId));
  const closures = [...requiredClosures].map(id => graph.closures.filter(c => c.id === id));
  return { ...base, graphAvailable: true, semanticVersion: graph.version, limits: graph.limits, inventoryComplete: graph.inventoryComplete,
    graphComplete: graph.complete, graphReasons: graph.reasons, wireBytes: Buffer.byteLength(JSON.stringify(wire)),
    expandedBytes: Buffer.byteLength(JSON.stringify(graph)), allNodes: graph.nodes.length, allClosures: graph.closures.length,
    requiredSetMethod: 'target + union(retained selectorIds, observed selector predicate) + native/editable controls; nativeRoots are separately required',
    selectorInventoryMatches: sameUniqueSet(graph.selectorIds, observedSelectors),
    nativeInventoryMatches: graph.version === 'browser-owner-dependencies-v1' ? undefined
      : sameUniqueSet(graph.nativeInputIds || [], [...observation.controls.filter(c => nativeTags.includes(c.tag)).map(c => c.instanceId), ...(graph.nativeRoots || []).map(r => r.instanceId)]),
    requiredControls: controls.length, completeRequiredControls: controls.filter(r => r.retainedProducerComplete).length,
    requiredReadinessFailures: controls.filter(r => r.readiness).map(r => ({ localId: r.localId, readiness: r.readiness })),
    nativeRoots: nativeRoots.length, completeNativeRoots: nativeRoots.filter(r => r.retainedProducerComplete).length,
    requiredClosures: requiredClosures.size, completeRequiredClosures: closures.filter(rows => rows.length === 1 && rows[0].complete && !rows[0].reasons.length).length,
    requiredUnionNodes: union.size, retainedUnionNodes: [...union].filter(id => nodes.has(id)).length,
    target: controls.find(r => r.target), incompleteRequiredControls: controls.filter(r => !r.retainedProducerComplete),
    incompleteNativeRoots: nativeRoots.filter(r => !r.retainedProducerComplete),
    limitation: 'Counts inspect retained producer flags and membership, not full closure reconstruction, authority, state equality, arrival or execution permission.' };
}

const injected = [];
function sourceTransform(name, before, after) {
  injected.push(`replaceOnce(${JSON.stringify(name)}, ${JSON.stringify(before)}, ${JSON.stringify(after)});`);
}
sourceTransform('shared-diagnostic-graph-cache', 'function graphSummary(observation: Observation | undefined, localId: string | undefined) {',
  `const diagnosticGraphs = new WeakMap();
function auditDecodedGraph(observation) {
  const wire = observation?.ownerDependencies;
  if (!wire) return;
  if (!diagnosticGraphs.has(wire)) diagnosticGraphs.set(wire, wire.version === 'browser-owner-dependencies-v3' ? auditCodec.decode(wire) : wire);
  return diagnosticGraphs.get(wire);
}
${mandatorySummary.toString()}
function graphSummary(observation: Observation | undefined, localId: string | undefined) {`);
sourceTransform('use-shared-diagnostic-decode', "  const graph = wire?.version === 'browser-owner-dependencies-v3' ? auditCodec.decode(wire) : wire;",
  '  const graph = auditDecodedGraph(observation);');
sourceTransform('shared-diagnostic-observation-cache', '    const receiptRows = results.map(result => {',
  `    const diagnosticObservations = new Map();
    const readDiagnosticObservation = (sid, id) => {
      const key = JSON.stringify([sid, id]);
      if (!diagnosticObservations.has(key)) {
        try { diagnosticObservations.set(key, { value: host!.observation(sid, id) }); }
        catch (error) { diagnosticObservations.set(key, { error }); }
      }
      const retained = diagnosticObservations.get(key);
      if (retained.error) throw retained.error;
      return retained.value;
    };
    const receiptRows = results.map(result => {`);
sourceTransform('cached-before-read', 'before = host!.observation(original.sessionId, original.beforeId)', 'before = readDiagnosticObservation(original.sessionId, original.beforeId)');
sourceTransform('cached-after-read', 'after = host!.observation(original.sessionId, original.afterId)', 'after = readDiagnosticObservation(original.sessionId, original.afterId)');
sourceTransform('window-only-mandatory-summary', '    report.receipts = receiptRows;',
  `    report.receipts = receiptRows;
    report.windowMandatoryDependencies = windowAttempts.map(original => {
      let before, after, beforeReadError, afterReadError, boundaryExitTransition, boundaryTransitionReadError;
      try { before = readDiagnosticObservation(original.sessionId, original.beforeId); } catch (error) { beforeReadError = errorText(error); }
      try { if (original.afterId) after = readDiagnosticObservation(original.sessionId, original.afterId); } catch (error) { afterReadError = errorText(error); }
      if (original.status === 'succeeded' && original.action.boundary?.intent === 'exit') {
        try {
          if (!original.afterId) throw Error('SUCCESSFUL_EXIT_WITHOUT_AFTER_OBSERVATION');
          const transition = host!.interactionTransition(original.sessionId, original.beforeId, original.afterId);
          boundaryExitTransition = { verified: transition.verified, documentChanged: transition.documentChanged,
            exited: transition.exited, entered: transition.entered, navigated: transition.navigated,
            beforeBoundaryKeys: before?.boundaries?.map(boundary => boundary.key), afterBoundaryKeys: after?.boundaries?.map(boundary => boundary.key) };
        } catch (error) { boundaryTransitionReadError = errorText(error); }
      }
      return { attemptId: original.id, sessionId: original.sessionId, originalStatus: original.status,
        classification: classify(original), kind: original.action.kind, label: original.action.label,
        ...(original.action.kind === 'check' ? { checkValue: typeof original.action.value === 'boolean' ? original.action.value : undefined,
          checkValueIsBoolean: typeof original.action.value === 'boolean' } : {}),
        sdkBatchIncluded: results.some(result => result.source.sessionId === original.sessionId && result.source.attemptId === original.id),
        beforeId: original.beforeId, afterId: original.afterId, beforeReadError, afterReadError,
        boundaryExitTransition, boundaryTransitionReadError,
        mandatory: mandatorySummary(before, original.action.localId), dispatch: dispatchSummary(original, before, after) };
    });`);
replaceWrapper('append-window-diagnostics', 'const compiled = ts.transpileModule(source,', `${injected.join('\n')}\nconst compiled = ts.transpileModule(source,`);
const reuse = { path: RETAINED, sha256: RETAINED_SHA256, fixedRunId: RUN_ID, wrapperTransformations: transformations,
  preparationRevision: 2, priorPreparation: { path: join(dirname(SCRIPT), 'receipt-audit-prepared.json'),
    sha256: sha(readFileSync(join(dirname(SCRIPT), 'receipt-audit-prepared.json'))) },
  mandatoryWindowOnly: true, additionalReceiptConditionQueries: 0, originalBatchSelectionAndLoopUnchanged: true,
  additionalReadOnlyTransitionQueries: 'one per succeeded window boundary-exit receipt with an afterId; none for historical receipts',
  transitionGrantsCheckpointOrOperationArrival: false,
  transitionScopeNote: 'Observed boundary disappearance is separate from checkpoint/source/operation restoration; no arrival or coverage is inferred from this diagnostic.',
  booleanCheckValueRetained: true, graphAndObservationCaches: 'diagnostic query lifetime only' };
replaceWrapper('retained-wrapper-provenance', "const metadata = { format: 'retained-receipt-audit-wrapper-v1',",
  `const metadata = { retainedWrapper: ${JSON.stringify(reuse)}, format: 'retained-receipt-audit-wrapper-v1',`);

// The retained --prepare branch only transpiles and reports provenance. It does
// not import the generated audit module, inspect RUNS or open a database.
await import('data:text/javascript;base64,' + Buffer.from(wrapper).toString('base64'));
