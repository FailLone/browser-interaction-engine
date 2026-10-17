import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { zstdDecompressSync } from 'node:zlib';
const dir=readFileSync('/tmp/bie-task-store-next-path','utf8');
const db=new DatabaseSync(`${dir}/frozen-copy/plugin/explorer.sqlite`,{readOnly:true});
db.exec('PRAGMA query_only=ON');
const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
const tasks=db.prepare('SELECT * FROM tasks').all().map(row=>{
 const h=JSON.parse(row.header_data?zstdDecompressSync(row.header_data).toString():row.json);
 return {id:row.id,plan:row.plan_count,rounds:row.round_count,headerBytes:Buffer.byteLength(JSON.stringify(h)),compressedHeaderBytes:row.header_data?.length??null,headerFields:Object.entries(h).map(([key,value])=>({key,bytes:Buffer.byteLength(JSON.stringify(value))})).sort((a,b)=>b.bytes-a.bytes)};
});
const result={tasks,rows:db.prepare('SELECT kind,status,COUNT(*) AS n,SUM(length(CAST(json AS BLOB))) AS jsonBytes,SUM(chunk_id IS NOT NULL) AS packed FROM task_items GROUP BY kind,status').all(),tables:tables.map(({name})=>({name,count:db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n})),page:db.prepare('SELECT * FROM pragma_page_count(), pragma_freelist_count(), pragma_page_size()').get(),dbstat:db.prepare('SELECT name,sum(pgsize) AS bytes,sum(payload) AS payload,sum(unused) AS unused FROM dbstat GROUP BY name ORDER BY bytes DESC').all()};
writeFileSync(`${dir}/initial-inspection.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));db.close();
