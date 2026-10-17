// Root must confirm review-present-source-release and main merge before --run.
// This prepared wrapper does not add a new protocol, budget policy or stop gate.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let wrapper = readFileSync(join(here, '../real-okx-9/launch.mjs'), 'utf8');
if (createHash('sha256').update(wrapper).digest('hex') !== 'f13089610a28c708c8f87b43600ad0ab7d938b407abf44535aff24a916a2ae0c') throw Error('Retained launcher changed');
const replaceWrapper = (from, to) => {
  if (wrapper.split(from).length !== 2) throw Error('Expected one retained launcher transform site');
  wrapper = wrapper.replace(from, to);
};
replaceWrapper('const here = dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(here)};`);
replaceWrapper("let source = original.replaceAll('import.meta.url', JSON.stringify(import.meta.url));",
  `let source = original.replaceAll('import.meta.url', ${JSON.stringify(JSON.stringify(import.meta.url))});`);
const dispatch = "await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));";
const edits = [
  ['.data/okx-storage-acceptance-20261017-v2', '.data/okx-storage-acceptance-20261017-v4'],
  ['const saved=parseEnv', "execFileSync('git',['merge-base','--is-ancestor','f3c4316',revision],{cwd:root,stdio:'ignore'});\nconst saved=parseEnv"],
  ['One bounded continuation after compact evidence admission and release checks: verify observed arrival followed by effective coverage. Preserve prior usage/debt; explicit budget addition of one window. No performance A/B or exhaustion claim.',
    'One bounded continuation solely to verify the confirmed current_review_occurrence_present fallback defect fixed by f3c4316: with no active boundary and a fresh source proving the review instance present, do not fall back to the older checkpoint for that item. Then assess strict arrival and subsequent effective condition coverage independently. Preserve prior usage, plan and failure debt; same 8 minutes/20 actions/80 model requests/1 round and stop gates, one explicit budget increment. No performance A/B, assumed recovery success or exhaustion claim.'],
];
replaceWrapper(dispatch, edits.map(([from, to]) => `replace(${JSON.stringify(from)}, ${JSON.stringify(to)});`).join('\n') + '\n' + dispatch);
await import('data:text/javascript;base64,' + Buffer.from(wrapper).toString('base64'));
