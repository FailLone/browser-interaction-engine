import { createHash } from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib';
import { ExplorerError } from './types.js';

export const taskDigest = (value:string|Buffer) => createHash('sha256').update(value).digest('hex');
export type PackedTaskValue = { data:Buffer; content_hash:string; raw_size:number };
// A block is bounded by record count and (except for a single oversized record)
// raw bytes. Its digest covers the ordered values AND their per-record hashes.
export const TASK_BLOCK_ITEMS = 256;
export const TASK_BLOCK_BYTES = 256 * 1024;
export function packTaskValue(json:string):PackedTaskValue {
  const data=zstdCompressSync(json,{params:{[constants.ZSTD_c_compressionLevel]:1}});return {data,content_hash:taskDigest(data),raw_size:Buffer.byteLength(json)};
}
export function unpackTaskValue(value:PackedTaskValue):string {
  try {
    if(!Number.isSafeInteger(value.raw_size)||value.raw_size<0)throw Error('size');
    if(taskDigest(value.data)!==value.content_hash)throw Error('digest');
    const bytes=zstdDecompressSync(value.data,{maxOutputLength:Math.max(1,value.raw_size)});
    if(bytes.length!==value.raw_size)throw Error('size');
    return bytes.toString('utf8');
  } catch { throw new ExplorerError('CORRUPT_TASK'); }
}
export function parseTaskValue<T>(json:string):T {
  try{return JSON.parse(json) as T;}catch{throw new ExplorerError('CORRUPT_TASK');}
}

/** JSON-compatible dictionary format. Object key lists and repeated string
 * values are stored once; decoding always constructs independent objects.
 * Numbers are [-2,n], arrays [-1,...], objects [schema,...], scalar numbers
 * reference the string dictionary. The outer version is checked independently
 * of the SQLite schema so future codecs cannot be accidentally misinterpreted. */
export function packTaskRecords(value:unknown):PackedTaskValue {
  const normalized=JSON.parse(JSON.stringify(value)) as unknown;
  const counts=new Map<string,number>(),strings:string[]=[],stringIds=new Map<string,number>();
  const count=(v:unknown):void=>{if(typeof v==='string')counts.set(v,(counts.get(v)??0)+1);else if(v&&typeof v==='object')for(const child of Object.values(v))count(child);};
  count(normalized);for(const [text,n] of counts)if(n>1){stringIds.set(text,strings.length);strings.push(text);}
  const schemas:string[][]=[],schemaIds=new Map<string,number>();
  const encode=(v:unknown):unknown=>{
    if(typeof v==='string')return stringIds.get(v)??v;
    if(typeof v==='number')return [-2,v];
    if(v===null||typeof v!=='object')return v;
    if(Array.isArray(v))return [-1,...v.map(encode)];
    const keys=Object.keys(v),key=JSON.stringify(keys);let id=schemaIds.get(key);
    if(id===undefined){id=schemas.length;schemas.push(keys);schemaIds.set(key,id);}
    return [id,...keys.map(k=>encode((v as Record<string,unknown>)[k]))];
  };
  const encoded=encode(normalized);
  return packTaskValue(JSON.stringify([1,schemas,strings,encoded]));
}
export function unpackTaskRecords<T>(packed:PackedTaskValue):T {
  try {
    const value=parseTaskValue<unknown[]>(unpackTaskValue(packed));
    if(!Array.isArray(value)||value.length!==4||value[0]!==1||!Array.isArray(value[1])||!Array.isArray(value[2]))throw Error('format');
    const schemas=value[1] as string[][],strings=value[2] as string[];
    if(strings.some(text=>typeof text!=='string')||schemas.some(keys=>!Array.isArray(keys)||keys.some(key=>typeof key!=='string')||new Set(keys).size!==keys.length))throw Error('dictionary');
    const decode=(v:unknown):unknown=>{
      if(typeof v==='number'){if(!Number.isSafeInteger(v)||v<0||v>=strings.length)throw Error('string');return strings[v];}
      if(!Array.isArray(v)){if(v!==null&&typeof v!=='boolean'&&typeof v!=='string')throw Error('scalar');return v;}
      const id=v[0];
      if(id===-2){if(v.length!==2||typeof v[1]!=='number'||!Number.isFinite(v[1]))throw Error('number');return v[1];}
      if(id===-1){const out=new Array(v.length-1);for(let i=1;i<v.length;i++)out[i-1]=decode(v[i]);return out;}
      if(!Number.isSafeInteger(id)||id<0||id>=schemas.length)throw Error('schema');
      const keys=schemas[id];if(v.length!==keys.length+1)throw Error('arity');
      const out:Record<string,unknown>={};
      for(let i=0;i<keys.length;i++){
        const decoded=decode(v[i+1]);
        if(keys[i]==='__proto__')Object.defineProperty(out,keys[i],{value:decoded,enumerable:true,writable:true,configurable:true});else out[keys[i]]=decoded;
      }
      return out;
    };
    return decode(value[3]) as T;
  } catch {throw new ExplorerError('CORRUPT_TASK');}
}
