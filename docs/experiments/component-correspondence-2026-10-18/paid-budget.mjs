// Validation-only preload: every attempted provider HTTP request is durably
// reserved before network I/O. All workers share one non-resetting ledger.
import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {dirname} from 'node:path';
const path=process.env.COMPONENT_PAID_LEDGER;
if(!path)throw Error('COMPONENT_PAID_LEDGER_REQUIRED');
const endpoints=new Map(['JEV','LLM'].map(actor=>[process.env[`EXPLORER_${actor}_ENDPOINT`]||(actor==='JEV'?'https://api.typesafe.ai/v1/systemone':'https://api.openai.com/v1/chat/completions'),actor.toLowerCase()]));
const original=globalThis.fetch;
const read=()=>{try{return JSON.parse(readFileSync(path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;return {limits:{jev:8,llm:2},calls:[]};}};
const save=data=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path+'.tmp',JSON.stringify(data,null,2));renameSync(path+'.tmp',path);};
globalThis.fetch=async(input,init)=>{
 const url=typeof input==='string'?input:input instanceof URL?input.href:input.url,actor=endpoints.get(url);
 if(!actor)return original(input,init);
 const ledger=read(),body=JSON.parse(init?.body||'{}'),questions=body.questions?Object.keys(body.questions).length:1;
 if(ledger.calls.filter(x=>x.actor===actor).reduce((n,x)=>n+x.questions,0)+questions>ledger.limits[actor])throw Error('VALIDATION_PAID_BUDGET_EXHAUSTED');
 const entry={id:ledger.calls.length+1,actor,startedAt:Date.now(),pid:process.pid,model:body.model,questions:body.questions?Object.keys(body.questions).length:1,requestBytes:Buffer.byteLength(init?.body||''),images:0,retries:0,status:'reserved'};
 ledger.calls.push(entry);save(ledger);
 const finish=patch=>{const current=read(),row=current.calls.find(x=>x.id===entry.id);Object.assign(row,patch,{elapsedMs:Date.now()-entry.startedAt});save(current);};
 try{const response=await original(input,init);finish({status:'returned',httpStatus:response.status});
  const copy=await response.clone().text();try{const data=JSON.parse(copy);finish({responseBytes:Buffer.byteLength(copy),actualModel:data.model,usage:data.usage});}catch{finish({responseBytes:Buffer.byteLength(copy)});}return response;
 }catch(error){finish({status:'failed',errorName:error?.name||'Error'});throw error;}
};
