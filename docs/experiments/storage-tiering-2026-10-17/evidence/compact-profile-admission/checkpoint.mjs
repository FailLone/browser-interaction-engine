import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only the failed required-input frame is rerun. Original inputs stay in place.
const here = dirname(fileURLToPath(import.meta.url));
const previous = join(here, '../compact-static-admission/checkpoint.mjs');
let wrapper = readFileSync(previous, 'utf8');
if (createHash('sha256').update(wrapper).digest('hex') !== '2895b378f72d06b14b23bdc14f7f216b422f439727e0c98327e112c3aab0fd52') throw Error('Previous checkpoint changed');
// Preserve the inner wrapper's literal search needle.
wrapper = wrapper.replace('fileURLToPath(import.meta.url)', `fileURLToPath(${JSON.stringify(import.meta.url)})`);
wrapper = wrapper.replace('JSON.stringify(import.meta.url)', JSON.stringify(JSON.stringify(import.meta.url)));
const edits = [
  ["const ids = [diagnosis.targets[0].beforeId, diagnosis.targets.find(row => row.label === '1W').beforeId];", "const ids = [diagnosis.targets.find(row => row.label === '1W').beforeId];"],
  ['if (new Set(ids).size !== 2)', 'if (new Set(ids).size !== 1)'],
  ['Two representative before observations are required', 'One previously failing before observation is required'],
  ['input.documentId, input.limits, (${createOwnerDependencyCodec.toString()})', 'input.documentId, undefined, (${createOwnerDependencyCodec.toString()})'],
  ['observationsDecoded: 2', 'observationsDecoded: 1'],
  ["format: 'compact-capture-static-admission-v1'", "format: 'compact-capture-profile-admission-v1'"],
  ['New incremental compact collector plus explicit absence and node-bounded ancestry contracts; previous required evidence exceeded raw byte/depth bounds. This is one admission check, not a performance or restore test.',
   'The failed frame has a measured minimum of 515 required nodes, exceeding the old 512 limit. Verify the new bounded required-evidence profile and optional cap on only this frame. Complete proof requirements are unchanged; this is not a performance or restore test.'],
];
const dispatch = "await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));";
if (wrapper.split(dispatch).length !== 2) throw Error('Expected one checkpoint dispatch');
wrapper = wrapper.replace(dispatch, edits.map(([from, to]) => `replace(${JSON.stringify(from)}, ${JSON.stringify(to)});`).join('\n') + '\n' + dispatch);
try { await import('data:text/javascript;base64,' + Buffer.from(wrapper).toString('base64')); }
catch (error) { console.error(error.message); process.exitCode = 1; }
