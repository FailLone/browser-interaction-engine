import {deflateRawSync,inflateRawSync} from 'node:zlib';

const prefix='deflate-raw/base64-v1:';
/** Lossless transport for complete canonical comparison material. Repeated
 * observed selector bindings otherwise dominate the bounded durable ledger.
 * This is not a digest, text normalization or omitted semantic evidence. */
export function encodeFragmentMaterial(value:string):string {
  return prefix+deflateRawSync(value,{level:6}).toString('base64');
}
/** Audit readers can recover the exact original material; old plain records
 * remain readable. Runtime equality compares complete encoded bytes. */
export function decodeFragmentMaterial(value:string):string {
  return value.startsWith(prefix)?inflateRawSync(Buffer.from(value.slice(prefix.length),'base64'),{maxOutputLength:16*1024*1024}).toString('utf8'):value;
}
