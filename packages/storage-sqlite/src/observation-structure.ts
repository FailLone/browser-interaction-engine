import { createHash } from 'node:crypto';
import { evidenceChunks } from './evidence-chunks.js';

export type ObservationLayout = (string | number)[];
export interface StructuralObject { sha256: Buffer; data: Buffer; key: string }
export interface ObservationStructure { pieces: (string | StructuralObject)[]; objects: StructuralObject[]; metadata:Record<string,unknown> }
export const observationDigest = (data: Uint8Array) => createHash('sha256').update(data).digest();
const metadataKeys=new Set(['id','sessionId','capturedAt','url','stateId','documentId','instanceScope']);

/** An ordered reconstruction program over exact JSON fragments. References are
 * chosen at complete control, region and nested subtree boundaries. Small
 * literals stay inline; only oversized strings use content-defined byte cuts.
 * The input is JSON.stringify output. Scan its structural delimiters, skipping
 * string contents, instead of reparsing/reserializing every nested subtree.
 */
export function observationStructure(json: string, materialize?: (data: string | Buffer) => StructuralObject): ObservationStructure {
  const pieces: ObservationStructure['pieces'] = [], objects = new Map<string, StructuralObject>(),metadata:Record<string,unknown>={};
  const inline = (text: string) => {
    if (typeof pieces.at(-1) === 'string') pieces[pieces.length - 1] += text;
    else pieces.push(text);
  };
  const reference = (value: string | Buffer) => {
    let object:StructuralObject;
    if(materialize)object=materialize(value);
    else {const data=typeof value==='string'?Buffer.from(value):value,sha256=observationDigest(data);object={sha256,data,key:sha256.toString('hex')};}
    const existing=objects.get(object.key);if(existing)object=existing;else objects.set(object.key,object);
    pieces.push(object);
  };
  const stringEnd=(start:number)=>{
    let end=start;
    do {
      end=json.indexOf('"',end+1);if(end<0)throw Error('Invalid serialized JSON');
      let escapes=0;for(let i=end-1;json[i]==='\\';i--)escapes++;
      if(escapes%2===0)return end+1;
    }while(true);
  };
  const valueEnd=(start:number)=>{
    if(json[start]==='"')return stringEnd(start);
    if(json[start]!=='{'&&json[start]!=='['){let end=start;while(end<json.length&&json[end]!==','&&json[end]!==']'&&json[end]!=='}')end++;return end;}
    let depth=1;
    for(let end=start+1;end<json.length;end++) {
      const char=json[end];if(char==='"'){end=stringEnd(end)-1;continue;}
      if(char==='{'||char==='[')depth++;else if((char==='}'||char===']')&&--depth===0)return end+1;
    }
    throw Error('Invalid serialized JSON');
  };
  const visit=(start:number,end:number,field='',member=false,root=false)=>{
    const char=json[start],length=end-start,container=char==='{'||char==='[';
    // UTF-16 lengths are only a cut heuristic; the exact UTF-8 fragment is always
    // hashed/stored. A subtree is at most ~48 KiB even for multibyte characters.
    if(!root&&field!=='controls'&&field!=='regions'&&(member||length>=256)&&length<=16384&&container){reference(json.slice(start,end));return;}
    if(char==='"'&&length>16384){for(const chunk of evidenceChunks(Buffer.from(json.slice(start,end)),true))reference(Buffer.from(chunk));return;}
    if(container&&(root||length>16384||field==='controls'||field==='regions')) {
      inline(char);let offset=start+1;
      while(offset<end-1) {
        if(offset>start+1){inline(',');offset++;}
        let key='';
        if(char==='{'){const keyEnd=stringEnd(offset);key=JSON.parse(json.slice(offset,keyEnd));inline(json.slice(offset,keyEnd+1));offset=keyEnd+1;}
        const next=valueEnd(offset);
        if(root&&metadataKeys.has(key))metadata[key]=JSON.parse(json.slice(offset,next));
        visit(offset,next,key,char==='['&&(field==='controls'||field==='regions'));offset=next;
      }
      inline(char==='{'?'}':']');return;
    }
    inline(json.slice(start,end));
  };
  visit(0,json.length,'',false,true);
  return {pieces,objects:[...objects.values()],metadata};
}
