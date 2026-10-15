import { createServer as httpServer } from 'node:http';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractionEngine } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
import type { Provider, ModelRequest } from '@interaction/explorer-plugin';
export async function explorerFixture(html:string|(()=>string)='<button id="alpha" type="button" onclick="this.disabled=true">Alpha</button><button id="beta" type="button" onclick="this.disabled=true">Beta</button>') {
 const server=httpServer((_req,res)=>{if(_req.url==='/favicon.ico'){res.end();return;}res.setHeader('Content-Type','text/html');res.end(`<!doctype html><html><head><title>Explorer fixture</title></head><body><main><h1>Controls</h1>${typeof html==='function'?html():html}</main></body></html>`);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/`;const dir=mkdtempSync(join(tmpdir(),'explorer-test-'));const host=new InteractionEngine({persistence:new SqliteStore(join(dir,'engine'))});
 return {url,dir,host,close:async()=>{await host.close();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));rmSync(dir,{recursive:true,force:true});}};
}
export function fakeProviders(url:string,scope:Record<string,unknown>={url}) {
 const calls:ModelRequest[]=[];
 const decide=async(r:ModelRequest)=>{calls.push(r);const state=(r.state as any).material;let value:unknown;
 if(r.kind==='generate') {
   if(r.purpose==='initial-plan')value={items:[{title:'Controls',scope,prerequisites:[],completion:'Verify observed interface actions',required:true,reason:'user goal'}]};
   else if(r.purpose==='followup-plan')value={items:state.unfinished.map((i:any)=>({title:i.title,scope:i.scope,prerequisites:i.prerequisites,completion:i.completion,required:i.required,reason:i.reason}))};
   else if(r.purpose==='input-samples')value={samples:['sample']};else value={purpose:'Choose an option',businessScope:'Fixture'};
 } else if(r.kind==='checklist')value=Object.fromEntries(Object.keys(r.checks!).map(k=>[k,k.startsWith('interface_')?.99:.01]));
 else if(r.kind==='noul')value=true;
 else {const options=r.options!;value=Object.keys(options).find(k=>k!=='uncertain')!;if(r.purpose==='control-classification')value='display';if(r.purpose==='scope-review')value='all';if(r.purpose==='list-purpose')value='uncertain';}
 return {value,model:'mock-explicit',confidence:1};};
 return {calls,jev:{name:'mock-jev',model:'mock',decide} as Provider,llm:{name:'mock-llm',model:'mock',decide} as Provider};
}
