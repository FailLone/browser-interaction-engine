// Prepared only. After root authorizes a closed exclusive copy, reuse the fixed
// run10 audit once. No extra receipt batch or historical target diagnostics.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url), here = dirname(SCRIPT);
const reference = join(here, '../real-okx-10/receipt-audit.mjs');
const expected = '3480d77f8f6f12c485d726ae7b03b89c8944e667e7fc6409424630c4a0a8c3f6';
const priorPreparation = join(here, '../real-okx-10/receipt-audit-prepared-v2.json');
const priorPreparationSha256 = '44640b143a316538dddbf08b84a8ba13d5eccf16d875a41ce86cf75139460859';
const sha = value => createHash('sha256').update(value).digest('hex');
let source = readFileSync(reference, 'utf8');
if (sha(source) !== expected || sha(readFileSync(priorPreparation)) !== priorPreparationSha256) throw Error('RETAINED_RUN10_AUDIT_CHANGED');
const transformations = [];
function replaceOnce(name, before, after, count = 1) {
  if (source.split(before).length !== count + 1) throw Error(`EXPECTED_AUDIT_WRAPPER_TRANSFORM:${name}`);
  source = source.replaceAll(before, after);
  transformations.push({ name, occurrences: count, beforeSha256: sha(before), afterSha256: sha(after) });
}
const modules = Object.fromEntries(['@interaction/browser', '@interaction/core', '@interaction/storage-sqlite', '@interaction/adapter-playwright']
  .map(name => [name, import.meta.resolve(name)]));
replaceOnce('run11-script', '\nconst SCRIPT = fileURLToPath(import.meta.url);\n', `\nconst SCRIPT = ${JSON.stringify(SCRIPT)};\n`);
replaceOnce('run11-id', "const RUN_ID = '717bba24-03b5-487f-a96a-b60ef8cd9972';", "const RUN_ID = '01958656-8614-4f9b-b571-a182b5cd8bbc';");
replaceOnce('current-package-resolution', "const modules = Object.fromEntries(['@interaction/browser', '@interaction/core', '@interaction/storage-sqlite', '@interaction/adapter-playwright']\n  .map(name => [name, import.meta.resolve(name)]));", `const modules = ${JSON.stringify(modules)};`);
replaceOnce('typescript-resolution', "JSON.stringify(import.meta.resolve('typescript'))", `JSON.stringify(${JSON.stringify(import.meta.resolve('typescript'))})`);
replaceOnce('owned-v4-run', '.data/okx-storage-acceptance-20261017-v3/runs', '.data/okx-storage-acceptance-20261017-v4/runs');
replaceOnce('owned-v4-label', 'owned-v3-runs-only', 'owned-v4-runs-only');
replaceOnce('owned-v4-guard', 'REQUIRES_FIXED_CLOSED_V3_RUN_DIRECTORY', 'REQUIRES_FIXED_CLOSED_V4_RUN_DIRECTORY');
replaceOnce('source-name', "'run10-receipt-audit.ts'", "'run11-receipt-audit.ts'");
replaceOnce('previous-preparation-reference', "join(dirname(SCRIPT), 'receipt-audit-prepared.json')", JSON.stringify(priorPreparation), 2);
replaceOnce('preparation-revision', 'preparationRevision: 2,', 'preparationRevision: 1,');
const reuse = { path: reference, sha256: expected, priorPreparationSha256, transformations,
  originalReceiptBatchAndDiagnosticLogicUnchanged: true, sourceDirectoryVersion: 4, frozenPriorDirectoryVersion: 3 };
replaceOnce('retained-run10-provenance', 'const reuse = { path: RETAINED,', `const reuse = { previousWindowWrapper: ${JSON.stringify(reuse)}, path: RETAINED,`);

// Inherited --prepare remains text/transpile only; --execute retains formal
// closure, exclusive-copy, write/driver, original-wire and source-hash checks.
await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
