import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// This diagnostic never attaches to a browser or opens the original database.
// Run once after the collector commit is fixed; an existing result is immutable.
const ROOT = '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine';
const OUT = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(OUT, 'result.json');
const DIAGNOSIS = join(ROOT, 'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-8/collection-diagnosis.json');
const COPY = '/private/var/folders/s9/dy_jbdrs3fn1qzt_gnsy4tgw0000gn/T/bie-run8-receipt-audit-5a3n2u5m/engine/engine.sqlite';
const COLLECTOR = 'packages/adapter-playwright/src/owner-dependencies.ts';
const argv = process.argv.slice(2);
if (argv.length !== 3 || argv[0] !== '--execute' || argv[1] !== '--native-commit' || !/^[a-f0-9]{40}$/.test(argv[2])) {
  throw Error('Explicit --execute --native-commit <40-character commit> required; preparation does not execute.');
}
if (existsSync(OUTPUT)) throw Error('Refusing to overwrite the single retained result');
const sha = value => createHash('sha256').update(value).digest('hex');
const hashFile = path => { const bytes = readFileSync(path); return { path, bytes: bytes.length, sha256: sha(bytes) }; };
const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
git(['merge-base', '--is-ancestor', argv[2], 'HEAD']);
if (sha(readFileSync(join(ROOT, COLLECTOR))) !== sha(execFileSync('git', ['show', `${argv[2]}:${COLLECTOR}`], { cwd: ROOT }))) {
  throw Error('Current collector differs from the specified native commit');
}
const beforeCopy = hashFile(COPY);
const diagnosisBytes = readFileSync(DIAGNOSIS), diagnosis = JSON.parse(diagnosisBytes);
const sidecars = () => ['-wal', '-shm'].map(suffix => existsSync(`${COPY}${suffix}`) ? hashFile(`${COPY}${suffix}`) : { path: `${COPY}${suffix}`, exists: false });
const beforeSidecars = sidecars();
if (beforeSidecars.some(row => row.path.endsWith('-wal') && row.bytes > 0) || beforeCopy.sha256 !== diagnosis.databaseAfter.sha256) {
  throw Error('Audit copy differs from the settled diagnosis or contains a nonempty WAL');
}
const ids = [diagnosis.targets[0].beforeId, diagnosis.targets.find(row => row.label === '1W').beforeId];
if (new Set(ids).size !== 2) throw Error('Two representative before observations are required');
const { ObservationObjectStore } = await import(pathToFileURL(join(ROOT, 'packages/storage-sqlite/src/observation-store.ts')));
const { decodeStoredEntity } = await import(pathToFileURL(join(ROOT, 'packages/storage-sqlite/src/entity-codec.ts')));
const { collectOwnerDependencies } = await import(pathToFileURL(join(ROOT, COLLECTOR)));
const Database = createRequire(join(ROOT, 'packages/storage-sqlite/package.json'))('better-sqlite3');
const db = new Database(COPY, { readonly: true, fileMustExist: true });
let observations;
try {
  const objects = new ObservationObjectStore(db, () => { throw Error('Read-only resolver attempted a write'); });
  const get = db.prepare("SELECT kind,id,session_id,json,compressed_json FROM entities WHERE kind='observation' AND id=?");
  observations = ids.map(id => { const row = get.get(id); if (!row) throw Error(`Observation absent: ${id}`); return decodeStoredEntity(row, objects.resolve); });
} finally { db.close(); }
const afterCopy = hashFile(COPY);
const afterSidecars = sidecars();
if (beforeCopy.sha256 !== afterCopy.sha256) throw Error('Audit copy bytes changed');
const touched = new Map();
const readEvidence = path => {
  const bytes = readFileSync(path), digest = sha(bytes), previous = touched.get(path);
  if (previous && previous !== digest) throw Error('Original evidence changed during read');
  touched.set(path, digest); return bytes;
};
const detail = observation => {
  const reference = diagnosis.observations.find(row => row.observationId === observation.id);
  const manifestPath = reference.manifest.path, manifestBytes = readEvidence(manifestPath), manifest = JSON.parse(manifestBytes);
  if (sha(manifestBytes) !== reference.manifest.sha256) throw Error('Manifest differs from the closed diagnosis');
  const bytes = Buffer.concat((manifest.blocks || [manifest]).map(block => {
    if (!/^[a-f0-9]{64}\.(gz|bin)$/.test(block.blob)) throw Error('Unexpected blob path');
    const raw = readEvidence(join(dirname(manifestPath), 'blobs', block.blob));
    const value = block.encoding === 'gzip' ? gunzipSync(raw, { maxOutputLength: block.bytes }) : raw;
    if (value.length !== block.bytes || sha(value) !== block.sha256) throw Error('Evidence block integrity failure');
    return value;
  }));
  if (bytes.length !== manifest.bytes || sha(bytes) !== manifest.sha256 || manifest.sha256 !== observation.evidence.artifacts.details.sha256) throw Error('Details integrity failure');
  const parsed = JSON.parse(bytes);
  if (parsed.observationId !== observation.id || parsed.documentId !== observation.documentId || parsed.dom.htmlTruncated) throw Error('Wrong or truncated HTML');
  return { parsed, reference };
};
const selectorDependency = control => control.checked != null || control.pressed != null || control.expanded != null || control.tag === 'select'
  || ['checkbox', 'radio', 'switch', 'tab', 'option', 'treeitem'].includes(control.role);
const isNative = control => ['input', 'select', 'textarea'].includes(control.tag) || control.editable;
const { chromium } = createRequire(join(ROOT, 'packages/adapter-playwright/package.json'))('playwright');
const browser = await chromium.launch({ headless: true, args: ['--disable-background-networking', '--disable-component-update', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'] });
const results = [];
try {
  for (const observation of observations) {
    const { parsed, reference } = detail(observation), dom = parsed.dom;
    const target = diagnosis.targets.find(row => row.beforeId === observation.id);
    const nodes = new Map(dom.nodes.map(node => [node.id, node]));
    const pathFor = id => {
      const path = []; let node = nodes.get(id);
      if (!node) return undefined;
      while (node.parentId) {
        const parent = nodes.get(node.parentId); if (!parent) return undefined;
        const elements = parent.children.filter(child => nodes.get(child)?.nodeType === 'element');
        const index = elements.indexOf(node.id); if (index < 0) return undefined;
        path.unshift(index); node = parent;
      }
      return node.id === dom.rootId ? path : undefined;
    };
    const binding = observation.controls.map(control => ({ control, detailNode: nodes.get(control.instanceId), detailPath: pathFor(control.instanceId) }));
    const context = await browser.newContext({ javaScriptEnabled: true, serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, permissions: [] });
    const requests = { inMemoryDocuments: 0, blocked: 0 }, originalUrl = dom.page.url;
    // CSP keeps scripting-enabled HTML parsing (including noscript) but rejects
    // every page script/resource. The only fulfilled request is this memory body.
    await context.route('**/*', route => {
      const request = route.request();
      if (requests.inMemoryDocuments === 0 && request.isNavigationRequest() && request.frame().parentFrame() === null && request.url() === originalUrl) {
        requests.inMemoryDocuments++;
        return route.fulfill({ status: 200, contentType: 'text/html', headers: { 'content-security-policy': "default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; style-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; form-action 'none'" }, body: dom.html });
      }
      requests.blocked++; return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    try {
      await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const input = { binding, targetLocalId: target.localId, requiredIds: observation.controls.filter(c => selectorDependency(c) || isNative(c)).map(c => c.localId), documentId: observation.documentId, limits: reference.graph.limits };
      const result = await page.evaluate(`(() => {
        const __name = fn => fn;
        const input = ${JSON.stringify(input)};
        const elements = [], ids = new WeakMap(), mapped = new Map(), issues = [];
        let detailPathChecks = 0, bindingChecks = 0;
        const sameAttributes = (el, expected, exact) => {
          const actual = Object.fromEntries([...el.attributes].map(a => [a.name, a.value]));
          return (!exact || Object.keys(actual).length === Object.keys(expected).length)
            && Object.entries(expected).every(([key, value]) => actual[key] === value);
        };
        for (const row of input.binding) {
          const c = row.control; let matches;
          try { matches = document.querySelectorAll(c.selector); } catch { issues.push({ localId: c.localId, reason: 'invalid_retained_selector' }); continue; }
          if (matches.length !== 1) { issues.push({ localId: c.localId, reason: 'retained_selector_not_unique', matches: matches.length }); continue; }
          const el = matches[0];
          if (el.tagName.toLowerCase() !== c.tag || mapped.has(el)) { issues.push({ localId: c.localId, reason: mapped.has(el) ? 'duplicate_element_binding' : 'tag_mismatch' }); continue; }
          const retained = c.reviewBinding?.attributes || c.purposeBinding?.attributes;
          if (retained) { bindingChecks++; if (!sameAttributes(el, retained, false)) { issues.push({ localId: c.localId, reason: 'retained_binding_attribute_mismatch' }); continue; } }
          if (row.detailNode) {
            let byPath = document.documentElement;
            for (const index of row.detailPath || []) byPath = byPath?.children[index];
            if (!row.detailPath || byPath !== el || row.detailNode.tag !== c.tag
              || row.detailNode.gaps?.some(g => g.code === 'FIELD_TRUNCATED')
              || !sameAttributes(el, row.detailNode.attributes || {}, true)) {
              issues.push({ localId: c.localId, reason: 'detail_instance_path_or_attributes_mismatch' }); continue;
            }
            detailPathChecks++;
          } else if (!retained) { issues.push({ localId: c.localId, reason: 'missing_retained_binding_and_detail_instance' }); continue; }
          mapped.set(el, c.instanceId); ids.set(el, c.instanceId); elements.push(el);
        }
        const mapping = { retained: input.binding.length, mapped: elements.length, detailPathChecks, bindingChecks, issues };
        if (issues.length) return { status: 'unverifiable_input_mapping', mapping, collectorCalled: false };
        const used = new Set(input.binding.map(row => row.control.instanceId)); let sequence = 100000;
        // These IDs are fixture labels of the same shape, never identity reuse.
        const instance = el => {
          if (!ids.has(el)) { let id; do { id = input.documentId + ':' + ++sequence; } while (used.has(id)); ids.set(el, id); used.add(id); }
          return ids.get(el);
        };
        const graph = (${collectOwnerDependencies.toString()})(input.binding.map(row => row.control), elements, instance, input.documentId, input.limits);
        const required = new Set([...input.requiredIds, input.targetLocalId]);
        const roots = [...required].map(localId => graph.roots.find(root => root.localId === localId) || { localId, complete: false, reasons: ['root_not_retained'] });
        const nativeRoots = graph.nativeRoots || [];
        const counts = {};
        for (const root of graph.roots) for (const reason of root.reasons) counts[reason] = (counts[reason] || 0) + 1;
        return { status: 'static_collection_executed', collectorCalled: true, mapping,
          graph: { version: graph.version, inventoryComplete: graph.inventoryComplete, complete: graph.complete, limits: graph.limits,
            bytes: new TextEncoder().encode(JSON.stringify(graph)).byteLength, nodes: graph.nodes.length, roots: graph.roots.length,
            closures: graph.closures.length, references: graph.references.length, nativeInputs: graph.nativeInputIds?.length, nativeRoots: nativeRoots.length,
            reasons: graph.reasons, rootReasonCounts: counts },
          required: { controls: roots.length, completeControls: roots.filter(root => root.complete).length, roots,
            nativeRoots, allRetainedAndComplete: roots.every(root => root.complete) && nativeRoots.every(root => root.complete) && graph.inventoryComplete },
          generatedGraphPersisted: false, currentUrl: location.href, baseURI: document.baseURI };
      })()`);
      results.push({ observationId: observation.id, label: target.label, observationCapturedAt: observation.capturedAt, detailsCapturedAt: dom.capturedAt,
        originalManifest: reference.manifest, html: { bytes: Buffer.byteLength(dom.html), sha256: sha(dom.html), truncated: dom.htmlTruncated },
        controlsSha256: sha(JSON.stringify(observation.controls)), detailTreeTruncated: dom.nodesTruncated,
        parsedNativeValues: 'HTML defaults only; retained live values are not reconstructed', fixtureIdentity: 'Original IDs are labels for structural budget measurement only; generated IDs have the original document-prefix shape and a six-digit counter.', requests, ...result });
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
const manifest = [...touched].sort(([a], [b]) => a.localeCompare(b));
const report = { format: 'native-capture-static-budget-checkpoint-v1', at: new Date().toISOString(), commit: git(['rev-parse', 'HEAD']), nativeCommit: argv[2], node: process.version,
  script: hashFile(fileURLToPath(import.meta.url)), collector: hashFile(join(ROOT, COLLECTOR)), diagnosis: { path: DIAGNOSIS, sha256: sha(diagnosisBytes) },
  preparationRetry: { reason: 'The first launch stopped before database/browser access because its initial guard rejected any sidecar. The existing copy has an empty WAL and a retained SHM; the corrected guard verifies an empty WAL and exact settled database content instead. No collector execution was repeated.',
    firstLaunchDatabaseOpened: false, firstLaunchBrowserStarted: false, firstLaunchCollectorCalls: 0 },
  database: { before: beforeCopy, after: afterCopy, beforeSidecars, afterSidecars, readOnly: true, observationsDecoded: 2, originalDatabaseOpened: false, hostConstructed: false },
  originalEvidence: { filesRead: manifest.length, manifestSha256: sha(JSON.stringify(manifest)), unchanged: manifest.every(([path, digest]) => sha(readFileSync(path)) === digest), copied: false },
  results, limitations: ['Static HTML structure input only; no original browser was attached and no service was started.',
    'Controls and details have distinct capture timestamps. A successful mapping is a conservative static-fixture binding, not proof of the original live same-frame identity.',
    'No page interaction, restoration, dispatch witness, coverage proof, or old graph is reconstructed or backfilled.',
    'Live native values, selectedness, React state, network state and event handlers are absent; HTML defaults can change exact byte cost.',
    'This single structural checkpoint is not a performance benchmark and does not establish a real recovery success rate.'] };
if (!report.originalEvidence.unchanged) throw Error('Original source evidence changed');
writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output: OUTPUT, sha256: sha(readFileSync(OUTPUT)), results: results.map(r => ({ observationId: r.observationId, status: r.status, graph: r.graph, requiredComplete: r.required?.allRetainedAndComplete, mappingIssues: r.mapping.issues.length })) }, null, 2));
