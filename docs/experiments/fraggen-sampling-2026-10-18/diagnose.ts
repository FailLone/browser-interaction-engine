/** Offline frozen bytes only. No browser, Store constructor or database opens. */
import {readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {browserTraversalFragments as current} from '../../../packages/adapter-playwright/src/fragment-projection.js';
import {browserTraversalFragments as baseline} from './evidence/v2-fragment-projection.js';
import type {Observation,ActionCandidate} from '@interaction/browser';
import {mapFragmentCandidates,emptyFragmentAccess} from '../../../packages/explorer-plugin/src/fragment-traversal-core.js';
const input=resolve(process.argv[2]||'tests/fixtures/fraggen-matching/okx-public-captures.json.gz');
const bytes=gunzipSync(readFileSync(input));
const rows=JSON.parse(bytes.toString()) as {index?:number;observation:Observation;actions:ActionCandidate[]}[];
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const count=(values:string[])=>{const result:Record<string,number>={};for(const v of values)result[v]=(result[v]||0)+1;return result;};
const results:any={input,inputSHA256:sha(bytes),baselineCommit:'366012568c24e8c5e720552eba801a7fc82b166e',sourceHashes:{},runs:{}};
for(const p of ['packages/adapter-playwright/src/fragment-projection.ts','packages/adapter-playwright/src/fragment-conditions.ts','packages/adapter-playwright/src/fragment-outcome.ts','packages/explorer-plugin/src/fragment-sampling.ts','packages/adapter-playwright/src/mode-structure.ts','packages/adapter-playwright/src/branch-conditions.ts','packages/explorer-plugin/src/fragment-traversal.ts','packages/explorer-plugin/src/fragment-traversal-core.ts'])results.sourceHashes[p]=sha(readFileSync(p));
for(const [name,project]of [['v2',baseline],['v3',current]] as const){
 const all:any[]=[],rowResults:any[]=[],reasons:string[]=[];
 for(const [ordinal,r]of rows.entries()){
  const o=r.observation,actions=r.actions,d=new Map<string,string>(),fs=project(o,actions,'authority',d);
  const rs=[...d.values()];reasons.push(...rs);let reused=0,addedMappings=0,crossURLMappings=0;
  for(const f of fs){const id=JSON.stringify([o.url,f.revision]);if(all.some(x=>x.id===id)){reused+=f.candidates.length;continue;}
   const next={...f,id,index:r.index??ordinal,url:o.url,candidates:f.candidates.map(c=>({...c,id:c.actionId,access:emptyFragmentAccess()}))};
   for(const old of all){const ms=mapFragmentCandidates(old,next);addedMappings+=ms.length;if(old.url!==o.url)crossURLMappings+=ms.length;}all.push(next);
  }
  rowResults.push({index:r.index??ordinal,observationId:o.id,url:o.url,actions:actions.length,projectable:fs.reduce((s,f)=>s+f.candidates.length,0),fragments:fs.length,reused,addedMappings,crossURLMappings,rejections:count(rs)});
 }
 const stages:Record<string,number>={},ownerFields:Record<string,number>={},guardFields:Record<string,number>={};const bump=(out:Record<string,number>,k:string)=>out[k]=(out[k]||0)+1;
 for(let i=0;i<all.length;i++)for(let j=0;j<i;j++){
  const a=all[i],b=all[j],prefix=a.url===b.url?'sameURL:':'crossURL:';
  if(a.structure!==b.structure){bump(stages,prefix+'structure');continue;}
  if(a.owner!==b.owner){bump(stages,prefix+'owner');const x=JSON.parse(a.owner),y=JSON.parse(b.owner);for(const k of new Set([...Object.keys(x),...Object.keys(y)]))if(JSON.stringify(x[k])!==JSON.stringify(y[k]))bump(ownerFields,k);continue;}
  bump(stages,prefix+'structure_and_owner_equal');
  for(const c of a.candidates){const rivals=b.candidates.filter((d:any)=>c.path===d.path&&c.operation===d.operation);if(rivals.length!==1){bump(stages,prefix+'path_operation_unavailable');continue;}
   if(c.guard===rivals[0].guard){bump(stages,prefix+'candidate_equal');continue;}
   bump(stages,prefix+'guard');const x=JSON.parse(c.guard),y=JSON.parse(rivals[0].guard);for(const k of new Set([...Object.keys(x),...Object.keys(y)]))if(JSON.stringify(x[k])!==JSON.stringify(y[k]))bump(guardFields,k);
  }
 }
 results.runs[name]={counts:count(reasons),uniqueFragments:all.length,stages,ownerFields,guardFields,rows:rowResults};
}
results.limitations=['Pair counts use unique URL/revision projections without storage bounds; they are not dispatch or coverage counts.','Current replay uses the same historical bytes; no new OKX browser run.','External-context evidence remains distinct; structural mappings alone grant no cross-context pruning.','Historical store registration capacity is separate and is not simulated here.'];
const output=process.argv[3]||'docs/experiments/fraggen-sampling-2026-10-18/evidence/subset-comparison.json';writeFileSync(output,JSON.stringify(results,null,2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(results.runs).map(([k,v]:any)=>[k,{counts:v.counts,uniqueFragments:v.uniqueFragments,stages:v.stages,ownerFields:v.ownerFields,guardFields:v.guardFields}]))));
