import {readFileSync,writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {zstdCompressSync,zstdDecompressSync,constants} from 'node:zlib';
const dir=readFileSync('/tmp/bie-task-store-next-path','utf8');const db=new DatabaseSync(`${dir}/frozen-copy/plugin/explorer.sqlite`,{readOnly:true});db.exec('PRAGMA query_only=ON');
const rows=db.prepare('SELECT kind,json,content_hash FROM task_items ORDER BY kind,position').all();db.close();
const digest=v=>createHash('sha256').update(v).digest('hex');
const trial=f=>{let s=performance.now();let value=f();return {ms:performance.now()-s,hash:digest(JSON.stringify(value))};};
const records={};
for(let turn=0;turn<3;turn++)for(const [name,parse] of [
 ['each',()=>rows.map(r=>{if(digest(r.json)!==r.content_hash)throw Error('hash');return JSON.parse(r.json)})],
 ['batch',()=>{for(const r of rows)if(digest(r.json)!==r.content_hash)throw Error('hash');return JSON.parse('['+rows.map(r=>r.json).join(',')+']')}]
]){(records[name]??=[]).push(trial(parse))}
const round=rows.find(r=>r.kind==='rounds').json;let s=performance.now();const packed=zstdCompressSync(round,{params:{[constants.ZSTD_c_compressionLevel]:1}});const packMs=performance.now()-s;s=performance.now();const plain=zstdDecompressSync(packed).toString();const unpackMs=performance.now()-s;if(plain!==round)throw Error('round');
const r={scope:'Small feasibility only, not formal performance evidence',records,round:{bytes:Buffer.byteLength(round),packed:packed.length,packMs,unpackMs}};writeFileSync(`${dir}/feasibility.json`,JSON.stringify(r,null,2)+'\n');console.log(JSON.stringify(r,null,2));
