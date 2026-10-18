import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {BrowserAdapter} from '@interaction/adapter-playwright';
import {BrowserEngine} from '@interaction/browser';
import {SqliteStore} from '@interaction/storage-sqlite';
const out='.data/stage2-handler-observation';mkdirSync(out,{recursive:false});
const protocol=JSON.parse(readFileSync('.data/stage2-okx-3/protocol.json','utf8'));
let adapter:BrowserAdapter|undefined;const start=BrowserAdapter.prototype.start,execute=BrowserAdapter.prototype.execute;
BrowserAdapter.prototype.start=async function(){adapter=this;await start.call(this);};
BrowserAdapter.prototype.execute=async function(){throw new Error('READ_ONLY_DIAGNOSTIC_NO_DISPATCH');};
const engine=new BrowserEngine({persistence:new SqliteStore(out+'/engine')});
try{
 const session=await engine.createSession({url:protocol.entry,coveragePolicy:'finite-ui-v1',executionPolicy:'interface-only',headless:true,settleMs:200,observeTimeoutMs:5000,maxActions:1});
 const o=engine.observation(session.id),targets=o.controls.filter(c=>c.landmark).map(c=>({localId:c.localId,selector:c.selector,name:c.name,tag:c.tag}));
 const facts=await adapter!.page!.evaluate(targets=>targets.map(t=>{
  let nodes:Element[]=[];try{nodes=[...document.querySelectorAll(t.selector)];}catch{}
  if(nodes.length!==1)return {...t,matches:nodes.length};
  const element=nodes[0];const descriptors=Object.getOwnPropertyDescriptors(element),frameworkEvents:unknown[]=[];
  for(const [key,descriptor] of Object.entries(descriptors))if(key.startsWith('__reactProps$')&&descriptor.value&&typeof descriptor.value==='object'){
   for(const [name,property] of Object.entries(Object.getOwnPropertyDescriptors(descriptor.value)))if(/^on[A-Z]/.test(name)&&typeof property.value==='function')frameworkEvents.push({source:'react-current-props',eventProperty:name,ownDataProperty:true});
  }
  return {...t,matches:1,frameworkEvents};
 }),targets);
 writeFileSync(out+'/result.json',JSON.stringify({diagnosticOnly:true,executionAuthorized:false,actions:1,description:'One initial navigation; only read own data property names and function presence on current captured landmark elements. No handlers invoked, no browser interaction dispatched.',sessionId:session.id,observationId:o.id,facts},null,2));
 console.log(JSON.stringify({targets:facts.length,withHandlers:facts.filter((f:any)=>f.frameworkEvents?.length).map((f:any)=>({name:f.name,events:f.frameworkEvents}))}));
}finally{await engine.close();BrowserAdapter.prototype.start=start;BrowserAdapter.prototype.execute=execute;}
