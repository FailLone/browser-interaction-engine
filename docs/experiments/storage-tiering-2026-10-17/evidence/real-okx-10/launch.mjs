import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let wrapper = readFileSync(join(here, '../real-okx-9/launch.mjs'), 'utf8');
if (createHash('sha256').update(wrapper).digest('hex') !== 'f13089610a28c708c8f87b43600ad0ab7d938b407abf44535aff24a916a2ae0c') throw Error('Retained launcher changed');
// Keep its literal edit needles intact while rebinding this owned output path.
wrapper = wrapper.replace('fileURLToPath(import.meta.url)', `fileURLToPath(${JSON.stringify(import.meta.url)})`);
wrapper = wrapper.replace('JSON.stringify(import.meta.url)', JSON.stringify(JSON.stringify(import.meta.url)));
const dispatch = "await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));";
if (wrapper.split(dispatch).length !== 2) throw Error('Expected one launcher dispatch');
const edits = [
  ['.data/okx-storage-acceptance-20261017-v2', '.data/okx-storage-acceptance-20261017-v3'],
  ['One bounded continuation after compact evidence admission and release checks: verify observed arrival followed by effective coverage. Preserve prior usage/debt; explicit budget addition of one window. No performance A/B or exhaustion claim.',
   'One bounded continuation after active-boundary capture and local-exit scheduling fixes. Check current permitted exit, then fresh observations and effective exploration coverage; retain strict recovery failures and all prior debt. Same stop gates and budgets; no performance A/B or exhaustion claim.'],
];
wrapper = wrapper.replace(dispatch, edits.map(([from, to]) => `replace(${JSON.stringify(from)}, ${JSON.stringify(to)});`).join('\n') + '\n' + dispatch);
await import('data:text/javascript;base64,' + Buffer.from(wrapper).toString('base64'));
