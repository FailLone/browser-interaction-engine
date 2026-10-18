import {createHash} from 'node:crypto';
import {ExplorerError} from './types.js';

export type FragmentMaterialKind='structure'|'owner'|'operation'|'guard'|'context'|'effect'|'component';
export type FragmentMaterialLayout=([0,string]|[1,string])[];
export interface FragmentAtom {id:string;raw:string;bytes:number}
export interface FragmentMaterial {id:string;kind:FragmentMaterialKind;bytes:number;layout:FragmentMaterialLayout}
export type FragmentDigest=(value:string)=>string;
const sha:FragmentDigest=value=>createHash('sha256').update(value).digest('hex');
const atomId=(raw:string,digest:FragmentDigest)=>digest('fragment-atom/v2\0'+raw);
export const fragmentMaterialId=(kind:FragmentMaterialKind,raw:string,digest:FragmentDigest=sha)=>digest(`fragment-material/v2\0${kind}\0${raw}`);
const corrupt=():never=>{throw new ExplorerError('CORRUPT_FRAGMENT_MATERIAL');};

/** Exact serialized spans, following the host observation-store practice.
 * Guard modes and owner content/context are independently shared values. The
 * layout retains punctuation, whitespace, escaping, ordering and Unicode.
 * Arbitrary non-object legacy material remains one exact literal. */
export function splitFragmentMaterial(kind:FragmentMaterialKind,raw:string,digest:FragmentDigest=sha):{material:FragmentMaterial;atoms:FragmentAtom[]} {
  const atoms=new Map<string,FragmentAtom>(),layout:FragmentMaterialLayout=[];
  const stringEnd=(start:number)=>{
    for(let i=start+1;i<raw.length;i++){if(raw[i]==='\\'){i++;continue;}if(raw[i]==='"')return i+1;}
    return corrupt();
  };
  const valueEnd=(start:number)=>{
    if(raw[start]==='"')return stringEnd(start);
    if(raw[start]!=='{'&&raw[start]!=='['){let i=start;while(i<raw.length&&!['}',']',','].includes(raw[i]))i++;return i;}
    let depth=1;
    for(let i=start+1;i<raw.length;i++){if(raw[i]==='"'){i=stringEnd(i)-1;continue;}if(raw[i]==='{'||raw[i]==='[')depth++;else if((raw[i]==='}'||raw[i]===']')&&--depth===0)return i+1;}
    return corrupt();
  };
  const skip=(offset:number)=>{while(/\s/.test(raw[offset]||'')&&offset<raw.length)offset++;return offset;};
  if(raw.trimStart().startsWith('{')){
    // Validate syntax without reserializing it. This also rejects malformed
    // legacy material instead of treating a parser mismatch as a cache miss.
    try{JSON.parse(raw);}catch{return corrupt();}
    let offset=skip(0)+1,last=0;
    while((offset=skip(offset))<raw.length&&raw[offset]!=='}'){
      if(raw[offset]!=='"')return corrupt();const keyEnd=stringEnd(offset),colon=skip(keyEnd);
      if(raw[colon]!==':')return corrupt();const start=skip(colon+1),end=valueEnd(start);
      if(end-start>=256){
        const value=raw.slice(start,end),id=atomId(value,digest),prior=atoms.get(id);
        if(prior&&prior.raw!==value)throw new ExplorerError('FRAGMENT_MATERIAL_HASH_CONFLICT');
        atoms.set(id,{id,raw:value,bytes:Buffer.byteLength(value)});
        if(start>last)layout.push([0,raw.slice(last,start)]);layout.push([1,id]);last=end;
      }
      offset=skip(end);if(raw[offset]===',')offset++;else if(raw[offset]!=='}')return corrupt();
    }
    if(last<raw.length)layout.push([0,raw.slice(last)]);
  }else layout.push([0,raw]);
  return {material:{id:fragmentMaterialId(kind,raw,digest),kind,bytes:Buffer.byteLength(raw),layout},atoms:[...atoms.values()]};
}

/** Resolve and validate the complete comparison material, never just its key. */
export function readFragmentMaterial(material:FragmentMaterial,resolve:(id:string)=>FragmentAtom,digest:FragmentDigest=sha):string {
  if(!material||!['structure','owner','operation','guard','context','effect','component'].includes(material.kind)||!Number.isSafeInteger(material.bytes)||material.bytes<0||!Array.isArray(material.layout))return corrupt();
  const raw=material.layout.map(piece=>{
    if(!Array.isArray(piece)||piece.length!==2||typeof piece[1]!=='string')return corrupt();
    if(piece[0]===0)return piece[1];if(piece[0]!==1)return corrupt();
    const atom=resolve(piece[1]);
    if(!atom||atom.id!==piece[1]||typeof atom.raw!=='string'||Buffer.byteLength(atom.raw)!==atom.bytes||atomId(atom.raw,digest)!==atom.id)return corrupt();
    return atom.raw;
  }).join('');
  if(Buffer.byteLength(raw)!==material.bytes||fragmentMaterialId(material.kind,raw,digest)!==material.id)return corrupt();
  return raw;
}
