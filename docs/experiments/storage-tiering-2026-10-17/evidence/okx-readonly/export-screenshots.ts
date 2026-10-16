/** Original DB opened read-only; SQLite backup and copied evidence are decoded
 * only in an owned temporary directory. No browser/provider/production writes. */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { SqliteStore } from '@interaction/storage-sqlite';
import type { Observation } from '@interaction/browser';
const root=resolve(import.meta.dirname,'../../../../..'),source=join(root,'.data/okx-storage-acceptance-20261017-v1/engine'),output=join(root,'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-1');
const Database=createRequire(join(root,'packages/storage-sqlite/package.json'))('better-sqlite3') as typeof import('better-sqlite3');
const temporary=mkdtempSync(join(tmpdir(),'okx-readonly-screenshot-copy-')),db=new Database(join(source,'engine.sqlite'),{readonly:true,fileMustExist:true});
let store:SqliteStore|undefined;
try {
  if(!db.readonly)throw Error('Read-only source required');
  await db.backup(join(temporary,'engine.sqlite'));db.close();
  store=new SqliteStore(temporary);
  const restored=store.require<Observation>('observation','cfc205c1-bab5-4b44-8bc7-9d2b4c498948'),initial=store.list<Observation>('observation',restored.sessionId)[0];
  mkdirSync(join(temporary,'evidence','blobs'),{recursive:true});mkdirSync(output,{recursive:true});
  const results=[];
  for(const [label,observation] of [['initial',initial],['recovered',restored]] as const){
    const key=observation.screenshot;if(!key||basename(key)!==key)throw Error(`Missing or non-flat screenshot key: ${label}`);
    const metadata=JSON.parse(readFileSync(join(source,'evidence',`${key}.meta.json`),'utf8'));
    copyFileSync(join(source,'evidence',`${key}.meta.json`),join(temporary,'evidence',`${key}.meta.json`));
    const blocks=metadata.version===3?metadata.blocks:metadata.version===2?[metadata]:[];
    for(const block of blocks){if(!/^[a-f0-9]{64}\.(gz|bin)$/.test(block.blob))throw Error('Invalid copied blob reference');copyFileSync(join(source,'evidence','blobs',block.blob),join(temporary,'evidence','blobs',block.blob));}
    if(metadata.version===undefined)copyFileSync(join(source,'evidence',key),join(temporary,'evidence',key));
    const evidence=await store.evidence.get(key);if(!evidence||evidence.mediaType!=='image/png'||Buffer.from(evidence.data).subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error(`Invalid PNG screenshot: ${label}`);
    const path=join(output,`${label}-${observation.id}.png`);writeFileSync(path,evidence.data);
    results.push({label,observationId:observation.id,capturedAt:observation.capturedAt,screenshotAt:observation.screenshotAt,key,mediaType:evidence.mediaType,bytes:evidence.data.length,sha256:createHash('sha256').update(evidence.data).digest('hex'),output:path,integrity:'Copied evidence reconstructed with FileEvidenceStore manifest/block/whole SHA checks'});
  }
  const result={protocol:'readonly-snapshot-screenshot-export-v1',sourceDatabase:join(source,'engine.sqlite'),sourceConnection:{readonly:true,fileMustExist:true},backup:'SQLite online backup to owned temporary directory; SqliteStore instantiated only against copy',screenshots:results,cleanup:'Temporary copied database and evidence removed after export'};
  writeFileSync(join(output,'screenshot-export.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{if(db.open)db.close();if(store?.db.open)store.close();rmSync(temporary,{recursive:true,force:true});}
