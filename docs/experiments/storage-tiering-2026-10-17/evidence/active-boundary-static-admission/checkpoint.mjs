import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// One new failing frame, with the same retained mapping harness. Source HTML,
// observations and audit DB are referenced in place, never copied into results.
const here = dirname(fileURLToPath(import.meta.url));
const previous = join(here, '../compact-static-admission/checkpoint.mjs');
let wrapper = readFileSync(previous, 'utf8');
if (createHash('sha256').update(wrapper).digest('hex') !== '2895b378f72d06b14b23bdc14f7f216b422f439727e0c98327e112c3aab0fd52') throw Error('Previous checkpoint changed');
wrapper = wrapper.replace('fileURLToPath(import.meta.url)', `fileURLToPath(${JSON.stringify(import.meta.url)})`);
wrapper = wrapper.replace('JSON.stringify(import.meta.url)', JSON.stringify(JSON.stringify(import.meta.url)));
const edits = [
  ['evidence/real-okx-8/collection-diagnosis.json', 'evidence/real-okx-9/mandatory-diagnosis.json'],
  ['bie-run8-receipt-audit-5a3n2u5m', 'bie-run9-receipt-audit-0ky2fc2g'],
  ['const diagnosisBytes = readFileSync(DIAGNOSIS), diagnosis = JSON.parse(diagnosisBytes);', `const diagnosisBytes = readFileSync(DIAGNOSIS), recorded = JSON.parse(diagnosisBytes);
const settledCopy = JSON.parse(readFileSync(join(OUT, '../real-okx-9/audit-copy.json')));
const diagnosis = { databaseAfter: { sha256: settledCopy.sha256 }, targets: [{ beforeId: recorded.observationId, localId: recorded.missingRequiredClosure.targetLocalId, label: recorded.missingRequiredClosure.label }], observations: [] };`],
  ["const ids = [diagnosis.targets[0].beforeId, diagnosis.targets.find(row => row.label === '1W').beforeId];", 'const ids = [diagnosis.targets[0].beforeId];'],
  ['if (new Set(ids).size !== 2)', 'if (new Set(ids).size !== 1)'],
  ['Two representative before observations are required', 'One run9 Close before observation is required'],
  ['const detail = observation => {', `diagnosis.observations = observations.map(o => ({ observationId: o.id, graph: { limits: o.ownerDependencies.limits },
  manifest: hashFile(join(ROOT, '.data/okx-storage-acceptance-20261017-v2/engine/evidence', o.evidence.artifacts.details.key + '.meta.json')) }));
const detail = observation => {`],
  ['const input = { binding, targetLocalId:', `const active = observation.overlays?.at(-1);
      const priorityLocalIds = active && active.key === observation.boundaries?.at(-1)?.key ? [...new Set([...active.exitControlIds, ...active.controlIds])] : [];
      const input = { binding, priorityLocalIds, targetLocalId:`],
  ['input.documentId, input.limits, (${createOwnerDependencyCodec.toString()})', 'input.documentId, undefined, (${createOwnerDependencyCodec.toString()}), input.priorityLocalIds'],
  ['const required = new Set([...input.requiredIds, input.targetLocalId]);', 'const required = new Set([...input.requiredIds, ...input.priorityLocalIds, input.targetLocalId]);'],
  ['observationsDecoded: 2', 'observationsDecoded: 1'],
  ["format: 'compact-capture-static-admission-v1'", "format: 'active-boundary-static-admission-v1'"],
  ['New incremental compact collector plus explicit absence and node-bounded ancestry contracts; previous required evidence exceeded raw byte/depth bounds. This is one admission check, not a performance or restore test.',
   'Run9 retained Close owner was optional and incomplete. Check explicit current-boundary priority on this single frozen frame, preserving global selector/native dependencies and the hard bounds. No old graph, receipt, coverage or arrival is upgraded.'],
];
const dispatch = "await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));";
if (wrapper.split(dispatch).length !== 2) throw Error('Expected one checkpoint dispatch');
wrapper = wrapper.replace(dispatch, edits.map(([from, to]) => `replace(${JSON.stringify(from)}, ${JSON.stringify(to)});`).join('\n') + '\n' + dispatch);
await import('data:text/javascript;base64,' + Buffer.from(wrapper).toString('base64'));
