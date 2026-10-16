import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { EngineError } from '@interaction/core';
import type { ObservationLayout } from './observation-structure.js';

export interface StoredEntityRow { kind?:string; id?:string; session_id?:string; json:string; compressed_json?:Uint8Array|null }
interface ObservationMetadata {
  id:string;sessionId?:string;capturedAt?:string;url?:string;stateId?:string;documentId?:string;instanceScope?:string;
}
export interface ObservationManifest extends ObservationMetadata {
  $interactionStorage:{format:'observation';version:1;codec:'gzip';bytes:number;sha256:string};
}
export interface SharedObservationManifest extends ObservationMetadata {
  $interactionStorage:{format:'observation';version:2;codec:'structural';bytes:number;sha256:string;sessionId:string;layoutBytes:number;layoutSha256:string};
}
export type ObservationObjectResolver = (ids: readonly number[], sessionId: string) => ReadonlyMap<number, Uint8Array>;
const metadataKeys=['id','sessionId','capturedAt','url','stateId','documentId','instanceScope'] as const;
export const entityDigest=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
export const corruptEntity=()=>new EngineError('CORRUPT_ENTITY','Stored entity content or compression manifest is corrupt');
const marker=(value:unknown)=>!!value&&typeof value==='object'&&(value as Partial<ObservationManifest>).$interactionStorage?.format==='observation';
const validDigest=(value:unknown)=>typeof value==='string'&&(/^[a-f0-9]{64}$/).test(value);
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0;

/** Read a structural envelope without resolving its references (used by GC).
 * The compressed reconstruction program is itself checksummed and bounded.
 */
export function sharedObservationLayout(row:StoredEntityRow):{manifest:SharedObservationManifest;layout:ObservationLayout}|undefined {
  try {
    const manifest=JSON.parse(row.json) as SharedObservationManifest,h=manifest?.$interactionStorage;
    if(h?.format!=='observation'||h.version!==2)return undefined;
    if(h.codec!=='structural'||!positive(h.bytes)||!validDigest(h.sha256)||typeof h.sessionId!=='string'||!positive(h.layoutBytes)||!validDigest(h.layoutSha256)||typeof manifest.id!=='string'||row.compressed_json==null)throw corruptEntity();
    if((row.kind!==undefined&&row.kind!=='observation')||(row.id!==undefined&&row.id!==manifest.id)||(row.session_id!==undefined&&row.session_id!==h.sessionId)||(manifest.sessionId??manifest.id)!==h.sessionId)throw corruptEntity();
    const bytes=gunzipSync(row.compressed_json,{maxOutputLength:h.layoutBytes});
    if(bytes.length!==h.layoutBytes||entityDigest(bytes)!==h.layoutSha256)throw corruptEntity();
    const layout:unknown=JSON.parse(bytes.toString('utf8'));
    if(!Array.isArray(layout)||layout.length===0||!layout.every(part=>typeof part==='string'||positive(part)))throw corruptEntity();
    return {manifest,layout};
  }catch(error){if(error instanceof EngineError&&error.code==='CORRUPT_ENTITY')throw error;throw corruptEntity();}
}

/** Plain JSON and v1 gzip remain self-contained. V2 structural observations
 * require a resolver from the same database snapshot; absence fails explicitly.
 * SqliteStore.decodeStoredEntity supplies that resolver for raw SQL consumers.
 */
export function decodeStoredEntity<T=unknown>(row:StoredEntityRow,resolve?:ObservationObjectResolver):T {
  try {
    const parsed=JSON.parse(row.json);
    if(row.compressed_json==null){if((row.kind===undefined||row.kind==='observation')&&marker(parsed))throw corruptEntity();return parsed as T;}
    const manifest=parsed as ObservationManifest|SharedObservationManifest,h=manifest?.$interactionStorage;
    if(!h||h.format!=='observation'||!positive(h.bytes)||!validDigest(h.sha256)||typeof manifest.id!=='string')throw corruptEntity();
    let bytes:Buffer;
    if(h.version===1&&h.codec==='gzip') bytes=gunzipSync(row.compressed_json,{maxOutputLength:h.bytes});
    else if(h.version===2&&h.codec==='structural') {
      if(!resolve)throw corruptEntity();
      const {layout}=sharedObservationLayout(row)!;
      const ids=[...new Set(layout.filter((part):part is number=>typeof part==='number'))],objects=resolve(ids,h.sessionId);
      const parts=layout.map(part=>{
        if(typeof part==='string')return Buffer.from(part);
        const object=objects.get(part);if(!object)throw corruptEntity();return object;
      });
      if(parts.reduce((sum,part)=>sum+part.length,0)!==h.bytes)throw corruptEntity();
      bytes=Buffer.concat(parts,h.bytes);
    }else throw corruptEntity();
    if(bytes.length!==h.bytes||entityDigest(bytes)!==h.sha256)throw corruptEntity();
    const value=JSON.parse(bytes.toString('utf8'));
    for(const key of metadataKeys)if(Object.hasOwn(manifest,key)&&manifest[key]!==value?.[key])throw corruptEntity();
    if((row.id!==undefined&&row.id!==value?.id)||(row.session_id!==undefined&&row.session_id!==(value?.sessionId??value?.id)))throw corruptEntity();
    return value as T;
  }catch(error){if(error instanceof EngineError&&error.code==='CORRUPT_ENTITY')throw error;throw corruptEntity();}
}

/** Encode one immutable observation. Small/incompressible rows stay plain JSON.
 * Kept as the v1 codec for backwards-compatible explicit gzip migration.
 */
export function encodeObservationJson(json:string):StoredEntityRow {
  const value=JSON.parse(json),bytes=Buffer.from(json);
  if(bytes.length<1024&&!marker(value))return {json,compressed_json:null};
  const compressed=gzipSync(bytes,{level:6});
  const manifest:ObservationManifest={$interactionStorage:{format:'observation',version:1,codec:'gzip',bytes:bytes.length,sha256:entityDigest(bytes)},id:value.id};
  for(const key of metadataKeys)if(typeof value[key]==='string')manifest[key]=value[key];
  const envelope=JSON.stringify(manifest);
  if(Buffer.byteLength(envelope)+compressed.length>=bytes.length&&!marker(value))return {json,compressed_json:null};
  return {json:envelope,compressed_json:compressed};
}

export function encodeSharedObservation(json:string,sessionId:string,layout:ObservationLayout,metadata?:Record<string,unknown>):StoredEntityRow {
  const value=metadata??JSON.parse(json),bytes=Buffer.from(json),program=Buffer.from(JSON.stringify(layout));
  const manifest:SharedObservationManifest={$interactionStorage:{format:'observation',version:2,codec:'structural',bytes:bytes.length,sha256:entityDigest(bytes),sessionId,layoutBytes:program.length,layoutSha256:entityDigest(program)},id:value.id};
  for(const key of metadataKeys)if(typeof value[key]==='string')manifest[key]=value[key];
  return {json:JSON.stringify(manifest),compressed_json:gzipSync(program,{level:6})};
}
