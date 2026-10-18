import {Session as Profiler} from 'node:inspector/promises';
import {costSampler,measuredConsumer} from './broad-okx-costs.js';
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
import {BrowserEngine,programNavigationAllowed} from '@interaction/browser';import {BrowserAdapter} from '@interaction/adapter-playwright';import {SqliteStore} from '@interaction/storage-sqlite';import {ExplorerPlugin,ExplorerStore,providersFromEnv} from '@interaction/explorer-plugin';
const dir=process.argv[2],protocol=JSON.parse(readFileSync(join(dir,'protocol.json'),'utf8')),budgetPath=join(dir,'budget.json');
const log=(type:string,data:unknown)=>appendFileSync(join(dir,'timeline.jsonl'),JSON.stringify({at:Date.now(),type,data})+'\n');
const count=()=>{const b=JSON.parse(readFileSync(budgetPath,'utf8'));if(Date.now()>=b.deadline||b.actions>=80)throw Error('ACCEPTANCE_BUDGET');b.actions++;writeFileSync(budgetPath,JSON.stringify(b));return b.actions;};
const allowed=(url:string)=>{try{const u=new URL(url);return u.protocol==='https:'&&protocol.coverageContract.routes.some((r:any)=>u.origin===r.origin&&new RegExp(r.pathnamePattern).test(u.pathname));}catch{return false;}};
// Preserve the original additional top-level route guard. Only start is wrapped;
// execute/readDOM retain the exact native implementations required by witnesses.
const start=BrowserAdapter.prototype.start;
BrowserAdapter.prototype.start=async function(){await start.call(this);await this.page!.route('**/*',async route=>{const request=route.request();if(request.isNavigationRequest()&&request.frame()===this.page!.mainFrame()&&!allowed(request.url())){log('scope.navigation_refused',{url:request.url()});await route.abort('blockedbyclient');}else await route.continue();});};
let captures=0;
const dispatchNumbers=new Map<string,number>(),afterInventories=new Map<string,unknown>();
const instrumentation:NonNullable<import('@interaction/adapter-playwright').EngineHooks['browserInstrumentation']>={publicInventory:true,observe(event){
 // All auxiliary commands, failures and bounded waits have paired records, but
 // only startup and native dispatch consume the original 80-command budget.
 log('browser.command',event);
 const input=event.input as any;
 if(event.phase==='before'){
  if(event.command==='start')log('browser.navigation',{number:count()});
  if(event.command==='capture')log('capture.start',{observationId:input.observationId});
  if(event.command==='execute'){
   const {action,control,url}=input,number=count(),href=control?.reviewBinding?.attributes?.href;
   dispatchNumbers.set(action.id,number);
 const forbidden=/登录|注册|登陆|购买|卖出|买入|下单|确认交易|身份认证|居住|地区|国家|log\s*in|sign\s*(in|up)|place order|buy now|sell now|verify identity|country|residen/i.test(action.label||'');
 const safeKind=['check','click','hover','focus','scroll','history','press','dismiss'].includes(action.kind);
 const bounded=action.risk==='unknown'&&programNavigationAllowed(engine.session(action.sessionId).options.executionBoundary,action,engine.observation(action.sessionId,action.observationId));
 const noticeCheck=action.kind==='check'&&action.value===true&&control?.checked===false&&control?.tag==='input'&&control.role==='checkbox'&&protocol.coverageContract.noticePreferences?.includes(control.name)===true&&!control.formOwner&&engine.observation(action.sessionId,action.observationId).overlays?.some(overlay=>(['modal','dialog'].includes(overlay.kind))&&overlay.controlIds.includes(control.localId));
 const denied=action.kind==='check'&&!noticeCheck||!allowed(url)||!safeKind||(action.risk!=='interface'&&!bounded)||forbidden||!!href&&!allowed(new URL(href,url).href)||action.kind==='press'&&!['Escape','Tab'].includes(String(action.value));
 log('browser.dispatch',{number,action,control,guardAllowed:!denied,...(bounded?{programAuthority:'public-navigation-v1',effects:'unknown'}:{})});if(denied){log('scope.dispatch_refused',{number,actionId:action.id,reason:'outside_public_navigation_authorization'});throw Error('OUTSIDE_PUBLIC_NAVIGATION_SCOPE');}

  }
 }else{
  if(event.command==='readDOM')log('readDOM.span',{at:event.startedAt,elapsedMs:event.elapsedMs,...input});
  if(event.command==='capture'){
   if(event.status==='returned'){captures++;const result=event.result as any;log('capture.end',{observationId:input.observationId,elapsedMs:event.elapsedMs,controls:result.controlCount,visible:result.visibleCount});}
   else log('capture.error',{observationId:input.observationId,elapsedMs:event.elapsedMs,error:event.error});
  }
  if(event.command==='inventory'&&event.status==='returned'){
   if(input.stage==='initial')log('dom.initial',event.result);
   if(input.stage==='before')log('dom.before',{number:dispatchNumbers.get(input.actionId),actionId:input.actionId,inventory:event.result});
   if(input.stage==='after')afterInventories.set(input.actionId,event.result);
  }
  if(event.command==='execute'){
   const actionId=input.action.id,number=dispatchNumbers.get(actionId);
   if(event.status==='returned')log('browser.executed',{number,actionId,inventory:afterInventories.get(actionId)});
   else log('browser.error',{number,actionId,error:event.error,operationStarted:event.operationStarted});
   dispatchNumbers.delete(actionId);afterInventories.delete(actionId);
  }
 }
}};
const configured=protocol.strategy==='program-only'?{}:providersFromEnv();if(protocol.strategy!=='program-only'&&(!configured.jev||!configured.llm))throw Error('PROVIDERS_REQUIRED');
const engine=new BrowserEngine({persistence:new SqliteStore(join(dir,'engine')),hooks:{browserInstrumentation:instrumentation}}),store=new ExplorerStore(join(dir,'explorer.sqlite'));

const save=store.event.bind(store);store.event=e=>{const result=save(e);log('plugin.event',result);if(e.type==='branch.reentry_planned'){const item=store.task(e.taskId).plan.find(i=>i.id===(e.data as any).itemId);log('reentry.pending',{sequence:result.sequence,item});}return result;};
const host=measuredConsumer(engine,(data:any)=>{log('sdk.call',data);if(data.method==='explorationTargetCorrespondences'&&data.result)log('sdk.targetCorrespondences',{...data.result,elapsedMs:data.elapsedMs});});
const profile=new Profiler();profile.connect();await profile.post('Profiler.enable');await profile.post('Profiler.setSamplingInterval',{interval:1000});await profile.post('Profiler.start');
const plugin=new ExplorerPlugin(host,store,configured),task=plugin.create({url:protocol.entry,goal:protocol.goal,coverageMode:'all',coverageContract:protocol.coverageContract,budget:{rounds:3,actions:80,durationMs:210000,modelRequests:200},sessionOptions:{coveragePolicy:'finite-ui-v1',executionPolicy:protocol.executionPolicy,headless:true,settleMs:200,observeTimeoutMs:protocol.observeTimeoutMs,actionTimeoutMs:8000,maxActions:80,maxDepth:30}});writeFileSync(join(dir,'task-id'),task.id);log('worker.start',{taskId:task.id,pid:process.pid});
const sample=costSampler(dir,()=>({captures,planCount:store.taskHeader(task.id).planCount,commands:JSON.parse(readFileSync(budgetPath,'utf8')).actions}));sample('started');const sampling=setInterval(()=>sample('running'),10000);
const timer=setTimeout(()=>{log('window.cooperative_stop',{reason:'reserve_final_durable_audit'});void plugin.pause(task.id).catch(e=>log('pause.error',{error:String(e)}));},Math.max(0,JSON.parse(readFileSync(budgetPath,'utf8')).began+210000-Date.now()));
try{plugin.start(task.id);await plugin.waitForIdle(task.id);}catch(e){log('worker.error',{error:String(e)});}finally{clearTimeout(timer);clearInterval(sampling);sample('worker-settled');writeFileSync(join(dir,'task-final.json'),JSON.stringify(store.task(task.id),null,2));writeFileSync(join(dir,'fragment-audit.json'),JSON.stringify(store.exportFragments(task.id)));writeFileSync(join(dir,'fragment-storage.json'),JSON.stringify({root:store.taskHeader(task.id).header.fragmentTraversal,records:store.fragmentRecords.stats(task.id),cache:store.fragmentRecords.cacheStats()}));log('worker.settled',{status:store.task(task.id).status,reason:store.task(task.id).reason});await plugin.close();await engine.close();const cpu=await profile.post('Profiler.stop');writeFileSync(join(dir,'worker.cpuprofile'),JSON.stringify(cpu.profile));profile.disconnect();const closed=costSampler(dir,()=>({captures,commands:JSON.parse(readFileSync(budgetPath,'utf8')).actions}));closed('closed');}
