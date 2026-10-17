/** Prepare without input access:
 * node --import tsx --conditions=development <this-file> --prepare
 * Execute only after closure and an explicitly supplied exclusive copy:
 * node --import tsx --conditions=development <this-file> --execute --engine-dir <copy> --run-dir <closed-v2-run>
 * The retained run-8 audit, batch queries and safety checks remain the implementation.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine';
const TEMPLATE = join(ROOT, 'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-8/receipt-audit.ts');
const TEMPLATE_SHA256 = 'e7ebad3dd1b2f7b8dfd6fe2120427945aa2633d35a2bc154c9a02c2db24fe1fb';
const OUTPUT = join(dirname(SCRIPT), 'receipt-audit.json');
const RUNS = join(ROOT, '.data/okx-storage-acceptance-20261017-v2/runs');
const sha = value => createHash('sha256').update(value).digest('hex');
const args = process.argv.slice(2);
const prepare = args.length === 1 && args[0] === '--prepare';
if (!prepare && (args.length !== 5 || args[0] !== '--execute' || args[1] !== '--engine-dir' || args[3] !== '--run-dir')) {
  throw Error('REQUIRES_PREPARE_OR_EXPLICIT_EXECUTE_ENGINE_DIR_RUN_DIR');
}
const template = readFileSync(TEMPLATE, 'utf8');
if (sha(template) !== TEMPLATE_SHA256) throw Error('RETAINED_AUDIT_TEMPLATE_CHANGED');
const names = ['@interaction/browser', '@interaction/core', '@interaction/storage-sqlite', '@interaction/adapter-playwright'];
const moduleResolution = Object.fromEntries(names.map(name => [name, import.meta.resolve(name)]));
for (const [name, url] of Object.entries(moduleResolution)) {
  const expected = join(ROOT, 'packages', name.slice('@interaction/'.length), 'src/index.ts');
  if (realpathSync(fileURLToPath(url)) !== realpathSync(expected)) throw Error(`CURRENT_SOURCE_RESOLUTION_REQUIRED:${name}`);
}
let source = template;
const transformations = [];
function replaceOnce(name, before, after) {
  if (source.split(before).length !== 2) throw Error(`EXPECTED_SINGLE_TRANSFORM:${name}`);
  source = source.replace(before, after);
  transformations.push({ name, beforeSha256: sha(before), afterSha256: sha(after) });
}
for (const name of names.slice(0, 3)) replaceOnce(`source-import:${name}`, `from '${name}'`, `from ${JSON.stringify(moduleResolution[name])}`);
replaceOnce('fixed-root-and-wrapper-script',
  "const SCRIPT = fileURLToPath(import.meta.url), ROOT = resolve(dirname(SCRIPT), '../../../../..');",
  `const SCRIPT = ${JSON.stringify(SCRIPT)}, ROOT = ${JSON.stringify(ROOT)};\nimport { createOwnerDependencyCodec } from ${JSON.stringify(moduleResolution['@interaction/adapter-playwright'])};\nconst auditCodec = createOwnerDependencyCodec();`);
replaceOnce('source-resolution-provenance',
  "Object.fromEntries(['@interaction/browser', '@interaction/core', '@interaction/storage-sqlite'].map(name => [name, import.meta.resolve(name)]))",
  JSON.stringify(moduleResolution));
replaceOnce('diagnostic-compact-decode', '  const graph = observation.ownerDependencies;',
  "  const wire = observation.ownerDependencies;\n  const graph = wire?.version === 'browser-owner-dependencies-v3' ? auditCodec.decode(wire) : wire;");
replaceOnce('diagnostic-wire-presence', '    graphPresent: !!graph, targetCount:',
  "    graphPresent: !!wire, wireVersion: wire?.version, compactDecodeRejected: wire?.version === 'browser-owner-dependencies-v3' && !graph, targetCount:");
replaceOnce('diagnostic-wire-and-semantic-versions', '  return { ...base, version: graph.version, inventoryComplete:',
  '  return { ...base, version: wire!.version, semanticVersion: graph.version, ancestry: graph.ancestry, inventoryComplete:');
replaceOnce('diagnostic-wire-and-expanded-bytes', 'retainedJsonBytes: Buffer.byteLength(JSON.stringify(graph)),',
  'retainedJsonBytes: Buffer.byteLength(JSON.stringify(wire)), expandedJsonBytes: Buffer.byteLength(JSON.stringify(graph)),');
replaceOnce('diagnostic-native-counts', 'selectors: graph.selectorIds.length },',
  'selectors: graph.selectorIds.length, nativeInputs: graph.nativeInputIds?.length, nativeRoots: graph.nativeRoots?.length },');
replaceOnce('explicit-audit-entry', 'async function main() {', 'async function main(auditReuse: unknown) {');
replaceOnce('audit-reuse-provenance', "{ format: 'offline-operation-receipt-audit-v1', createdAt:",
  "{ format: 'offline-operation-receipt-audit-v1', auditReuse, createdAt:");
replaceOnce('export-without-automatic-execution', 'if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) await main();', 'export { main };');

const compiled = ts.transpileModule(source, { fileName: 'run9-receipt-audit.ts', reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, sourceMap: false } });
const diagnostics = compiled.diagnostics?.filter(row => row.category === ts.DiagnosticCategory.Error) || [];
if (diagnostics.length) throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: value => value, getCurrentDirectory: () => ROOT, getNewLine: () => '\n' }));
const metadata = { format: 'retained-receipt-audit-wrapper-v1', template: { path: TEMPLATE, sha256: TEMPLATE_SHA256 },
  wrapper: { path: SCRIPT, sha256: sha(readFileSync(SCRIPT)) }, transformedTypeScriptSha256: sha(source),
  transpiledModuleSha256: sha(compiled.outputText), typescriptVersion: ts.version, transformations, moduleResolution,
  diagnosticOnlyDecode: true, dispatchHashesOriginalWire: true, sdkBatchLoopUnchanged: true, output: OUTPUT };
if (prepare) {
  console.log(JSON.stringify({ prepared: true, executed: false, databaseOpened: false, ...metadata }, null, 2));
} else {
  const engineDir = resolve(args[2]), runDir = realpathSync(args[4]);
  if (!runDir.startsWith(realpathSync(RUNS) + sep) || dirname(runDir) !== realpathSync(RUNS)) throw Error('REQUIRES_ONE_CLOSED_V2_RUN_DIRECTORY');
  // The unchanged audit checks closure, exclusive-copy location and all exports
  // before it constructs SqliteStore. It never opens an original engine database.
  process.argv = [process.argv[0], SCRIPT, '--engine-dir', engineDir, '--run-dir', runDir, '--output', OUTPUT];
  const { main } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputText).toString('base64'));
  await main(metadata);
}
