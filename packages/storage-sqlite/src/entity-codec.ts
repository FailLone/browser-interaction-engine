import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { EngineError } from '@interaction/core';

export interface StoredEntityRow { kind?:string;json:string; compressed_json?:Uint8Array|null }
export interface ObservationManifest {
  $interactionStorage:{format:'observation';version:1;codec:'gzip';bytes:number;sha256:string};
  id:string;sessionId?:string;capturedAt?:string;url?:string;stateId?:string;documentId?:string;instanceScope?:string;
}
const metadataKeys=['id','sessionId','capturedAt','url','stateId','documentId','instanceScope'] as const;
const digest=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
const corrupt=()=>new EngineError('CORRUPT_ENTITY','Stored entity content or compression manifest is corrupt');
const marker=(value:unknown)=>!!value&&typeof value==='object'&&(value as Partial<ObservationManifest>).$interactionStorage?.format==='observation';

/** Read-only codec for raw SQL consumers. It accepts both v1 plain JSON rows and
 * v2 manifests + BLOBs; an absent or corrupt compressed payload is never ignored.
 * The manifest is a storage envelope, not an observation or execution evidence.
 */
export function decodeStoredEntity<T=unknown>(row:StoredEntityRow):T {
  try {
    const parsed=JSON.parse(row.json);
    if(row.compressed_json==null){if((row.kind===undefined||row.kind==='observation')&&marker(parsed))throw corrupt();return parsed as T;}
    const manifest=parsed as ObservationManifest,h=manifest?.$interactionStorage;
    if(!h||h.format!=='observation'||h.version!==1||h.codec!=='gzip'||!Number.isSafeInteger(h.bytes)||h.bytes<=0||!(/^[a-f0-9]{64}$/).test(h.sha256)||typeof manifest.id!=='string')throw corrupt();
    const bytes=gunzipSync(row.compressed_json,{maxOutputLength:h.bytes});
    if(bytes.length!==h.bytes||digest(bytes)!==h.sha256)throw corrupt();
    const value=JSON.parse(bytes.toString('utf8'));
    for(const key of metadataKeys)if(Object.hasOwn(manifest,key)&&manifest[key]!==value?.[key])throw corrupt();
    return value as T;
  }catch(error){if(error instanceof EngineError&&error.code==='CORRUPT_ENTITY')throw error;throw corrupt();}
}

/** Encode one immutable observation. Small/incompressible rows stay plain JSON. */
export function encodeObservationJson(json:string):StoredEntityRow {
  const value=JSON.parse(json),bytes=Buffer.from(json);
  if(bytes.length<1024&&!marker(value))return {json,compressed_json:null};
  const compressed=gzipSync(bytes,{level:6});
  const manifest:ObservationManifest={$interactionStorage:{format:'observation',version:1,codec:'gzip',bytes:bytes.length,sha256:digest(bytes)},id:value.id};
  for(const key of metadataKeys)if(typeof value[key]==='string')manifest[key]=value[key];
  const envelope=JSON.stringify(manifest);
  if(Buffer.byteLength(envelope)+compressed.length>=bytes.length&&!marker(value))return {json,compressed_json:null};
  return {json:envelope,compressed_json:compressed};
}
