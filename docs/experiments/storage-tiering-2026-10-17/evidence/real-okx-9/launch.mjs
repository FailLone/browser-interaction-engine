import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reuse the existing owned-run launcher; no provider values enter evidence.
const here = dirname(fileURLToPath(import.meta.url));
const original = readFileSync(join(here, '../real-okx-8/launch.mjs'), 'utf8');
if (createHash('sha256').update(original).digest('hex') !== '6cab3eedbcbd15da6a82238f8e99db42541b29d7c9c4b53cf677664273b84e3f') throw Error('Prior launcher changed');
let source = original.replaceAll('import.meta.url', JSON.stringify(import.meta.url));
const replace = (from, to) => {
  if (source.split(from).length !== 2) throw Error(`Expected one launcher site: ${from}`);
  source = source.replace(from, to);
};
replace('.data/okx-storage-acceptance-20261017-v1', '.data/okx-storage-acceptance-20261017-v2');
replace("'--resume','--rounds','1','--actions','40','--model-requests','150','--minutes','12','--sample-seconds','30','--stall-minutes','10'",
  "'--resume','--extend-budget','--rounds','1','--actions','20','--model-requests','80','--minutes','8','--sample-seconds','30','--stall-minutes','5'");
replace("const saved=parseEnv", "const preparation=JSON.parse(readFileSync(join(here,'preparation.json'),'utf8'));\nif(preparation.revision!==revision||preparation.destination!==directory||!preparation.sourceUnchanged)throw Error('Continuation preparation does not match this revision');\nconst saved=parseEnv");
replace('First real continuation after step3 release and receipt-condition checkpoint; no performance A/B claim',
  'One bounded continuation after compact evidence admission and release checks: verify observed arrival followed by effective coverage. Preserve prior usage/debt; explicit budget addition of one window. No performance A/B or exhaustion claim.');
await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
