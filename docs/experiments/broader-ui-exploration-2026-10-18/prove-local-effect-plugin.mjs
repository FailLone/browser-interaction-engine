// Small real-plugin integration proof. Scope and assertions are fixture-only;
// no test selectors/labels are installed in the product or OKX harness.
import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';import {join,resolve} from 'node:path';import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';import {inflateRawSync} from 'node:zlib';
import {BrowserEngine} from '@interaction/browser';import {BrowserAdapter} from '@interaction/adapter-playwright';
import {SqliteStore} from '@interaction/storage-sqlite';import {ExplorerPlugin,ExplorerStore} from '@interaction/explorer-plugin';
import {TaskWriter} from '../../../packages/explorer-plugin/src/task-writer.ts';
const out=resolve(process.argv[2]),varyIds=process.argv.includes('--vary-local-ids');mkdirSync(out,{recursive:false});
const sourceFiles=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard','packages','scripts','tests']).toString().split('\0').filter(Boolean);
const sourceManifest=Object.fromEntries([...new Set(sourceFiles)].sort().map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')]));
const server=createServer((req,res)=>{const page=(req.url||'/A').slice(1),next={A:'B',B:'C',C:'done'}[page];res.setHeader('Content-Type','text/html');
 res.end(`<!doctype html><title>Conditional local results</title>${next?`<aside><select aria-label="External mode">${['A','B','C'].map(v=>`<option value="${v}" ${v===page?'selected':''}>${v}</option>`).join('')}</select></aside><nav aria-label="Shared navigation"><button type="button" ${varyIds?`id="trigger-${page}" aria-controls="detail-${page}"`:''} aria-expanded="false" onclick="this.disabled=true;this.setAttribute('aria-expanded','true');this.nextElementSibling.hidden=false;document.querySelector('#earlier').removeAttribute('open')">Shared menu</button><p id="${varyIds?'detail-'+page:'detail'}" hidden>Shared revealed detail</p></nav><section><details id="earlier" open><summary>Earlier ${page}</summary><a href="/old-${page}">Old ${page} content</a></details></section><main><a href="/${next}">Continue ${page}</a></main>`:'<main>Finished fixture route</main>'}`);
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`,url=origin+'/A';
const began=Date.now();let commands=0;const start=BrowserAdapter.prototype.start,execute=BrowserAdapter.prototype.execute;
const limit=()=>{if(++commands>20||Date.now()-began>60000)throw Error('PLUGIN_PROOF_BUDGET');};
BrowserAdapter.prototype.start=async function(){limit();return start.call(this);};BrowserAdapter.prototype.execute=async function(...args){limit();return execute.apply(this,args);};
const engine=new BrowserEngine({persistence:new SqliteStore(join(out,'engine'))}),store=new ExplorerStore(join(out,'explorer.sqlite')),events=[];
const event=store.event.bind(store);store.event=e=>{events.push(structuredClone(e));return event(e);};
const plugin=new ExplorerPlugin(engine,store);let taskId,pauseJob;const dispatch=engine.execute.bind(engine);
engine.execute=async(...args)=>{const receipt=await dispatch(...args);if(receipt.status==='succeeded'&&receipt.afterId&&engine.observation(receipt.sessionId,receipt.afterId).url===origin+'/done')pauseJob=new Promise((resolve,reject)=>setTimeout(()=>plugin.pause(taskId).then(resolve,reject),0));return receipt;};
try{
 const task=plugin.create({url,goal:'Traverse the fixture public navigation and preserve unresolved duties.',coverageMode:'all',coverageContract:{version:1,mode:'targeted',programNavigation:'public-navigation-v1',roots:[{url}],routes:[{origin,pathnamePattern:'^/(?:A|B|C|done)$',scope:{}}],exclusions:[],allowedOperations:['click','history']},budget:{rounds:1,actions:20,durationMs:60000,modelRequests:1},sessionOptions:{coveragePolicy:'finite-ui-v1',headless:true,settleMs:40,observeTimeoutMs:1000,actionTimeoutMs:3000,maxDepth:20,executionPolicy:'observed-ui'}});
 taskId=task.id;plugin.start(task.id);await plugin.waitForIdle(task.id);await pauseJob;const final=store.task(task.id),attempts=final.rounds.flatMap(r=>engine.list(r.sessionId,'attempt'));
 const menu=attempts.filter(a=>a.action.label==='Shared menu'&&a.status==='succeeded');
 const pruned=events.filter(e=>e.type==='fragment.frontier').flatMap(e=>(e.data.pruned||[]).map(p=>({...p,sessionId:e.sessionId,observationId:e.observationId||e.data.observationId}))).filter(p=>p.sampling?.status==='context-sample');
 const cPruned=pruned.filter(p=>engine.observation(p.sessionId,p.observationId).url===origin+'/C'&&engine.actions(p.sessionId,p.observationId).some(a=>a.id===p.actionId&&a.label==='Shared menu'));
 const unique=attempts.find(a=>a.status==='succeeded'&&a.action.label==='Continue C'&&engine.observation(a.sessionId,a.afterId).url===origin+'/done');
 const ledger=new TaskWriter(store,store.taskState(task.id)).fragments().exportLegacy();
 const unpack=s=>s.startsWith('deflate-raw/base64-v1:')?inflateRawSync(Buffer.from(s.slice('deflate-raw/base64-v1:'.length),'base64')).toString():s;
 const effects=menu.map(a=>JSON.parse(unpack(ledger.events.find(e=>e.id===a.id).effect)));
 const result={baseRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceManifest,varyIds,elapsedMs:Date.now()-began,commands,taskStatus:final.status,taskReason:final.reason,
  targetOpportunities:3,targetActualExecutions:menu.map(a=>({id:a.id,url:engine.observation(a.sessionId,a.beforeId).url})),conditionalPruneAtC:cPruned,uniqueActualReceipt:unique,
  remaining:final.plan.filter(i=>i.required&&!['succeeded','superseded','excluded'].includes(i.status)),coverageGrantedBySampling:false,events,ledger};
 writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));
 assert.equal(menu.length,2);assert.deepEqual(menu.map(a=>engine.observation(a.sessionId,a.beforeId).url),[origin+'/A',origin+'/B']);
 assert(cPruned.length);assert(unique);assert.notDeepEqual(effects[0].global,effects[1].global);assert.deepEqual(effects[0].comparison,effects[1].comparison);
 console.log(JSON.stringify({passed:true,elapsedMs:result.elapsedMs,commands,opportunities:3,targetDispatches:2,uniqueExecuted:unique.id,conditionalPrunedCandidateIds:[...new Set(cPruned.map(p=>p.candidateId))]}));
}finally{await plugin.close();await engine.close();await new Promise(r=>server.close(r));}
