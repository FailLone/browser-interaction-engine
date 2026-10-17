import {writeFileSync} from 'node:fs';
import {ExplorerPlugin,ExplorerStore} from '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/index.ts';
import {explorerFixture,fakeProviders} from '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/tests/explorer-plugin-helpers.ts';
const separateRegions=`${Array.from({length:7},(_,i)=>`<section aria-label="Region ${i}"><h2>Region ${i}</h2><button type="button" onclick="this.disabled=true">Action ${i}</button></section>`).join('')}<script>document.addEventListener('DOMContentLoaded',()=>{document.querySelector('main>h1').remove();const main=document.querySelector('main');main.replaceWith(...main.children)})</script>`;
for(const stripReuse of [false,true]){
 const f=await explorerFixture(separateRegions),commands:any[]=[];
 const host=new Proxy(f.host,{get(target,key){if(key==='command')return async(sid:string,command:any)=>{if(command.type==='reviewRegions'){commands.push({command:structuredClone(command),actions:target.session(sid).actionCount});if(stripReuse)command={...command,review:{...command.review,regions:command.review.regions.map((r:any)=>({...r,reuse:undefined}))}};}return target.command(sid,command);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const plugin=new ExplorerPlugin(host,new ExplorerStore(':memory:'),fakeProviders(f.url));
 try{const t=plugin.create({url:f.url,sessionOptions:{executionPolicy:'interface-only',settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:20}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),sid=v.task.rounds[0].sessionId;
 const result={stripReuse,commands,view:v,records:f.host.list(sid,'region-review'),events:f.host.store.events(sid),observations:f.host.list(sid,'observation'),attempts:f.host.list(sid,'attempt')};
 const file='/tmp/region-semantic-'+(stripReuse?'without-optin':'with-optin')+'.json';writeFileSync(file,JSON.stringify(result));console.log(JSON.stringify({file,stripReuse,status:v.task.status,actions:v.task.usage.actions,regionDecisions:v.decisions.filter(d=>d.purpose==='region-review').length,plan:v.task.plan.map(i=>({title:i.title,status:i.status,reason:i.reason,scope:i.scope,source:i.source,resolvedBy:i.resolvedBy}))}));
 }finally{await plugin.close();await f.close();}
}
