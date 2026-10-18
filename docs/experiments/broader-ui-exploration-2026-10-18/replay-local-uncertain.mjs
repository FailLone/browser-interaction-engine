// Deterministic model-answer replay of retained local2. Actual plugin/browser,
// no replacement classifier, auditor, scheduler or condition correspondence.
import {createServer} from 'vite';import {resolve,join} from 'node:path';
import {mkdirSync,readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {BrowserEngine} from '@interaction/browser';import {BrowserAdapter} from '@interaction/adapter-playwright';
import {SqliteStore} from '@interaction/storage-sqlite';import {ExplorerPlugin,ExplorerStore,coverageLedger} from '@interaction/explorer-plugin';
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:false});
const site=await createServer({root:resolve('apps/test-site'),server:{host:'127.0.0.1',port:0},logLevel:'silent'});await site.listen();
const url=`http://127.0.0.1:${site.httpServer.address().port}/?defects=off`;
const tape=JSON.parse(readFileSync(new URL('./evidence/uncertain-replay-answers.json',import.meta.url),'utf8').replaceAll('{{LOCAL_URL}}',url)).answers;
const cursors=new Map(),calls=[],provider=actor=>({name:'retained-answer-replay',model:'retained-local2',async decide(request){
 const key=actor+':'+request.purpose,choices=tape.filter(r=>r.actor===actor&&r.purpose===request.purpose),index=cursors.get(key)||0;cursors.set(key,index+1);
 const choice=choices[index];if(!choice)throw Error('REPLAY_ANSWER_EXHAUSTED:'+key+':'+index);
 calls.push({purpose:request.purpose,actor,index,sourceDecisionId:choice.sourceDecisionId,answer:choice.answer});return structuredClone(choice.answer);
}});
let commands=0;const began=Date.now(),start=BrowserAdapter.prototype.start,execute=BrowserAdapter.prototype.execute;
const limit=()=>{if(++commands>80||Date.now()-began>120000)throw Error('REPLAY_BUDGET');};
BrowserAdapter.prototype.start=async function(){limit();await start.call(this);};
BrowserAdapter.prototype.execute=async function(...args){limit();return execute.apply(this,args);};
const engine=new BrowserEngine({persistence:new SqliteStore(join(out,'engine')),hooks:{samples:c=>c.readOnly?undefined:[c.constraints.type==='number'?'1':'sample']}}),store=new ExplorerStore(join(out,'explorer.sqlite'));
const event=store.event.bind(store);store.event=e=>{appendFileSync(join(out,'events.jsonl'),JSON.stringify(e)+'\n');return event(e);};
const plugin=new ExplorerPlugin(engine,store,{jev:provider('jev'),llm:provider('llm')});
try{
 const t=plugin.create({url,goal:'Explore all reachable interface controls and conditional branches on this local test page, including local simulated submissions. Use only one finite sample per free input: 1 for numeric inputs, sample for text inputs. Do not treat changing read-only content as new work.',coverageMode:'all',budget:{rounds:3,actions:80,durationMs:120000,modelRequests:100},sessionOptions:{coveragePolicy:'finite-ui-v1',localSimulation:{url},headless:true,settleMs:50,observeTimeoutMs:3000,actionTimeoutMs:5000,maxDepth:30,maxActions:80,executionPolicy:'observed-ui'}});
 plugin.start(t.id);await plugin.waitForIdle(t.id);const task=store.task(t.id),attempts=task.rounds.flatMap(r=>engine.list(r.sessionId,'attempt'));
 const conditions=new Map(),duplicates=[];
 for(const a of attempts){if(a.status!=='succeeded'||a.purpose==='recovery'||a.repetitionSource)continue;const c=engine.operationReceiptCondition(a.sessionId,{attemptId:a.id});if(c.conditionVerified&&c.conditionKey){if(conditions.has(c.conditionKey))duplicates.push(a.id);else conditions.set(c.conditionKey,a.id);}}
 const ledger=coverageLedger(engine,task);
 const result={duplicateCompletedConditionAttempts:duplicates,finite:ledger.finite,taskId:t.id,elapsedMs:Date.now()-began,commands,status:task.status,reason:task.reason,calls,
  attempts:attempts.map(a=>({id:a.id,label:a.action.label,kind:a.action.kind,purpose:a.purpose,status:a.status,repetitionSource:a.repetitionSource,beforeId:a.beforeId,afterId:a.afterId})),
  remaining:task.plan.filter(i=>i.required&&!['succeeded','superseded','excluded'].includes(i.status)).map(i=>({id:i.id,scope:i.scope,reason:i.reason,status:i.status}))};
 writeFileSync(join(out,'task.json'),JSON.stringify(task,null,2));writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,finite:{total:ledger.finite.total,verified:ledger.finite.verified,remaining:ledger.finite.remaining.length}}));
 if(process.argv.includes('--assert-fixed')&&(duplicates.length||ledger.finite.remaining.length||!calls.some(c=>c.purpose==='classification-clarification'&&c.answer.value.choice==='uncertain')||!result.remaining.some(i=>i.reason==='classification_unresolved')||!attempts.some(a=>a.action.label==='Done'&&a.repetitionSource)))throw Error('UNCERTAIN_REPLAY_REGRESSION');
}finally{await plugin.close();await engine.close();await site.close();}
