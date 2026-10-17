// One bounded review-target diagnosis: two frozen observations, a read-only private
// byte copy, no engine/store construction, no browser. Never upgrades records.
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { decodeStoredEntity } from '../../../../../packages/storage-sqlite/src/entity-codec.js';
import { ObservationObjectStore } from '../../../../../packages/storage-sqlite/src/observation-store.js';
import { browserControlReviewTargetCorrespondence } from '../../../../../packages/adapter-playwright/src/review-target.js';
import { controlScopeMatcher } from '../../../../../packages/explorer-plugin/src/policy.js';
import type { Observation } from '../../../../../packages/adapter-playwright/src/types.js';

const here = fileURLToPath(new URL('.', import.meta.url)), root = resolve(here, '../../../../..');
const require = createRequire(join(root, 'packages/storage-sqlite/package.json')), Database = require('better-sqlite3');
const closure = JSON.parse(readFileSync(join(here, '../real-okx-14/closed-evidence.json'), 'utf8'));
const source = join(closure.source, 'engine/engine.sqlite'), hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const fileHash = (path: string) => hash(readFileSync(path)), original = fileHash(source);
if (original !== closure.sourceDatabase.sha256) throw Error('Frozen source changed');
const directory = mkdtempSync(join(tmpdir(), 'bie-review-arrival-')), copy = join(directory, 'engine.sqlite');
copyFileSync(source, copy);
if (statSync(source).ino === statSync(copy).ino || fileHash(copy) !== original) throw Error('Copy is not independent');
let db: any;
const report: any = { source, sourceSha256: original, engineConstructed: false, driverCalls: 0, entityReads: 0,
  note: 'Recorded facts only, not live preflight or real browser arrival. v8 projection is derived; frozen records are not migrated.' };
try {
  db = new Database(copy, { readonly: true, fileMustExist: true }); db.pragma('query_only = ON');
  const objects = new ObservationObjectStore(db, () => { throw Error('Unexpected write'); });
  const query = db.prepare('SELECT kind,id,session_id,json,compressed_json FROM entities WHERE kind=? AND id=?');
  db.transaction(() => { objects.begin(false);
    try {
      const frames = ['b0381d61-11e9-451a-9d0c-7859f4dcc8cc', '491f22b2-c4fe-4e7a-b5ea-bcd300e50044'].map(id => {
        if (++report.entityReads > 2) throw Error('Entity budget exceeded');
        const row = query.get('observation', id); if (!row) throw Error('Missing frozen observation');
        return decodeStoredEntity<Observation>(row, objects.resolve);
      });
      const scope=JSON.parse(readFileSync(join(here,'../review-arrival-diagnosis/frozen-state-differences.json'),'utf8')).targetScope;
      const [before,after]=frames;
      const sources=before.controls.filter(c=>controlScopeMatcher(before,[])(scope,c));
      const targets=after.controls.filter(c=>controlScopeMatcher(after,[])(scope,c));
      if(sources.length!==1||targets.length!==1)throw Error('Expected unique full-scope target');
      const recorded=browserControlReviewTargetCorrespondence(sources[0],before,targets[0],after);
      const projected=browserControlReviewTargetCorrespondence(sources[0],before,targets[0],{...after,ruleVersion:'observable-v8'});
      report.source={id:before.id,localId:sources[0].localId,ruleVersion:before.ruleVersion};
      report.target={id:after.id,localId:targets[0].localId,ruleVersion:after.ruleVersion,boundaries:after.boundaries};
      report.recorded=recorded;report.derivedV8=projected;
      report.sameNameCandidates=after.controls.filter(c=>c.name==='USD').length;
      report.livePreflightPerformed=false;report.browserArrivalProven=false;report.coverageGranted=false;
      if(!recorded.targetMatched||!recorded.reviewable||recorded.sourceEquivalent!=='unknown'
        ||!projected.targetMatched||!projected.reviewable||projected.sourceEquivalent!=='unknown')throw Error('Frozen current material contract did not match');
      report.sqlChanges = db.prepare('SELECT total_changes() AS n').get().n;
    } finally { objects.end(false); }
  })();
  db.close(); db = undefined;
  report.copyUnchanged = fileHash(copy) === original; report.sourceUnchanged = fileHash(source) === original;
  if (!report.copyUnchanged || !report.sourceUnchanged || report.sqlChanges !== 0) throw Error('Read-only invariant failed');
} finally { db?.close(); rmSync(directory, { recursive: true, force: true }); report.temporaryCopyRemoved = true; }
report.passed = true;
writeFileSync(join(here, 'frozen-review-arrival.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report));
