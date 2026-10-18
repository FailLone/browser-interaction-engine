/** Controlled process-restart test driver; not an external website harness. */
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {BrowserEngine} from '@interaction/browser';
import {SqliteStore} from '@interaction/storage-sqlite';
import {ExplorerPlugin,ExplorerStore} from '@interaction/explorer-plugin';
const [dir,url,phase]=process.argv.slice(2),engine=new BrowserEngine({persistence:new SqliteStore(join(dir,'engine'))}),store=new ExplorerStore(join(dir,'explorer.sqlite'));
const plugin=new ExplorerPlugin(engine,store,{});
const id=existsSync(join(dir,'task-id'))?readFileSync(join(dir,'task-id'),'utf8'):plugin.create({url,coverageContract:{version:1,mode:'exhaustive',programNavigation:'public-navigation-v1',roots:[{url}],routes:[{origin:new URL(url).origin,pathnamePattern:'^/.*$',scope:{}}],allowedOperations:['click','hover','focus','history'],exclusions:[]},sessionOptions:{coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',headless:true,settleMs:50,observeTimeoutMs:1200},budget:{rounds:3,actions:20,durationMs:45000}}).id;
writeFileSync(join(dir,'task-id'),id);
let stopping=false,pause:Promise<unknown>|undefined;
const execute=engine.execute.bind(engine);
engine.execute=async(...args)=>{
 const action=engine.actions(args[0]).find(a=>a.id===args[1]);
 if(phase==='crash'&&action?.label==='Unique destination'){
   // The plugin has durably stored dispatch intent; kill before any SDK receipt.
   writeFileSync(join(dir,'crash-intent.json'),JSON.stringify(store.task(id)));process.exit(76);
 }
 return execute(...args);
};
const timer=setInterval(()=>{
 if(phase!=='first'||stopping)return;
 const task=store.task(id);
 if((task.fragmentTraversal?.events.length||0)>=2&&!task.pendingDispatch){stopping=true;pause=plugin.pause(id);}
},10);
try{
 plugin.start(id);await plugin.waitForIdle(id);await pause;
 writeFileSync(join(dir,`task-${phase}.json`),JSON.stringify({pid:process.pid,task:store.task(id),events:store.events(id),attempts:store.task(id).rounds.flatMap(r=>engine.list(r.sessionId,'attempt'))}));
}finally{clearInterval(timer);await plugin.close();await engine.close();}
