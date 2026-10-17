// One bounded projection diagnosis: two frozen observations, a read-only private
// byte copy, no engine/store construction, no browser. Never upgrades records.
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { decodeStoredEntity } from '../../../../../packages/storage-sqlite/src/entity-codec.js';
import { ObservationObjectStore } from '../../../../../packages/storage-sqlite/src/observation-store.js';
import { observableCanonical } from '../../../../../packages/adapter-playwright/src/model.js';
import { structuralStateKeys } from '../../../../../packages/adapter-playwright/src/structural-state-key.js';
import type { Observation } from '../../../../../packages/adapter-playwright/src/types.js';

const here = fileURLToPath(new URL('.', import.meta.url)), root = resolve(here, '../../../../..');
const require = createRequire(join(root, 'packages/storage-sqlite/package.json')), Database = require('better-sqlite3');
const closure = JSON.parse(readFileSync(join(here, '../real-okx-14/closed-evidence.json'), 'utf8'));
const source = join(closure.source, 'engine/engine.sqlite'), hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const fileHash = (path: string) => hash(readFileSync(path)), original = fileHash(source);
if (original !== closure.sourceDatabase.sha256) throw Error('Frozen source changed');
const directory = mkdtempSync(join(tmpdir(), 'bie-state-projection-')), copy = join(directory, 'engine.sqlite');
copyFileSync(source, copy);
if (statSync(source).ino === statSync(copy).ino || fileHash(copy) !== original) throw Error('Copy is not independent');
let db: any;
const report: any = { source, sourceSha256: original, engineConstructed: false, driverCalls: 0, entityReads: 0,
  note: 'v8 normalization is a diagnostic derived projection only; frozen v7 observations and checkpoints are not migrated.' };
try {
  db = new Database(copy, { readonly: true, fileMustExist: true }); db.pragma('query_only = ON');
  const objects = new ObservationObjectStore(db, () => { throw Error('Unexpected write'); });
  const query = db.prepare('SELECT kind,id,session_id,json,compressed_json FROM entities WHERE kind=? AND id=?');
  db.transaction(() => { objects.begin(false);
    try {
      const frames = ['e852a4c7-8b9e-46a0-b35a-8bc36339e596', '0e6d2291-c714-4add-8aec-04166a887df5'].map(id => {
        if (++report.entityReads > 2) throw Error('Entity budget exceeded');
        const row = query.get('observation', id); if (!row) throw Error('Missing frozen observation');
        return decodeStoredEntity<Observation>(row, objects.resolve);
      });
      report.observations = frames.map(o => {
        const keys = structuralStateKeys(o), structural = o.controls.filter(c => c.stableKey?.startsWith('structural-item:'));
        return { id: o.id, ruleVersion: o.ruleVersion, storedCanonicalUnchanged: observableCanonical(o) === o.canonical,
          structuralControlCount: structural.length, portableControlCount: keys.size,
          v2CandidateCount: (o.regionCandidates || []).filter(c => (c.reuseBinding as any)?.version === 'region-structure-reuse/v2').length,
          tabs: structural.filter(c => c.role === 'tab' && ['1h', '24h'].includes(c.name)).map(c => ({ name: c.name, localId: c.localId,
            normalized: keys.has(c), rawKeySha256: hash(c.stableKey!), projectedKeySha256: keys.has(c) ? hash(keys.get(c)!) : null,
            hypothesis: !!c.hypothesisId, identityScope: c.identityScope,
            containingCandidates: (o.regionCandidates || []).filter(candidate => candidate.controlIds.includes(c.localId)).map(candidate => ({
              id: candidate.id, version: (candidate.reuseBinding as any)?.version || null,
              exactMembers: Array.isArray((candidate.binding as any)?.members) ? (candidate.binding as any).members.length : null,
              portableMembers: Array.isArray((candidate.reuseBinding as any)?.members) ? (candidate.reuseBinding as any).members.length : null,
            })),
          })) };
      });
      report.v8StrictCanonicalEqual = observableCanonical({ ...frames[0], ruleVersion: 'observable-v8' }) === observableCanonical({ ...frames[1], ruleVersion: 'observable-v8' });
      report.sqlChanges = db.prepare('SELECT total_changes() AS n').get().n;
    } finally { objects.end(false); }
  })();
  db.close(); db = undefined;
  report.copyUnchanged = fileHash(copy) === original; report.sourceUnchanged = fileHash(source) === original;
  if (!report.copyUnchanged || !report.sourceUnchanged || report.sqlChanges !== 0) throw Error('Read-only invariant failed');
} finally { db?.close(); rmSync(directory, { recursive: true, force: true }); report.temporaryCopyRemoved = true; }
report.passed = true;
writeFileSync(join(here, 'frozen-state-projection.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report));
