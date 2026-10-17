// One 240 s window, local restoration first; stop on first failed acceptance.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { BrowserEngine, type ActionAttempt } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
const root=process.cwd(),out=root+'/docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-17';
const prep=JSON.parse(readFileSync(out+'/preparation.json','utf8')),plan=JSON.parse(readFileSync(out+'/source-plan.json','utf8'));
assert.equal(process.argv[2],'--run');assert.equal(process.argv[3],prep.destination);
const targets=plan.targetMatches.filter((c:any)=>c.role==='generic'&&c.name==='USD');assert.equal(targets.length,1);
const sessionId=plan.checkpoint.sessionId,input={checkpointId:plan.checkpoint.id,observationId:plan.checkpoint.observationId,localId:targets[0].localId,requireSourceEquivalent:true};
const started=performance.now(),at=()=>performance.now()-started;
const write=(name:string,data:unknown)=>writeFileSync(out+'/'+name,JSON.stringify(data,null,2)+'\n',{flag:'wx'});
const calls:any[]=[],events:any[]=[],cases:any[]=[];let callId=0,deadline=false,phase='initialization';
const log=(type:string,data:unknown)=>appendFileSync(out+'/timeline.jsonl',JSON.stringify({at:new Date().toISOString(),elapsedMs:at(),phase,type,data})+'\n');
class MeasuredEngine extends BrowserEngine {
  ownDriver:any;
  constructor(store:SqliteStore){
    super({persistence:store});const create=this.adapter.createDriver.bind(this.adapter);
    this.adapter.createDriver=(options,evidence)=>{
      assert.equal(options.headless,true);assert.equal(new URL(options.url).hostname,'www.okx.com');
      const driver=create(options,evidence);this.ownDriver=driver;const cache=new Map<PropertyKey,Function>();
      return new Proxy(driver,{get(target,key){
        const member=Reflect.get(target,key,target);if(typeof member!=='function')return member;
        if(cache.has(key))return cache.get(key);
        const measured=['start','capture','preflight','execute','reopen','close'].includes(String(key));
        const wrapper=(...args:any[])=>{
          if(!measured)return Reflect.apply(member,target,args);
          const action=(key==='execute'?args[0]:key==='preflight'?args[1]:undefined);
          const row:any={id:++callId,method:String(key),startedMs:at(),...(action?{action:{id:action.id,kind:action.kind,label:action.label,source:action.source,boundary:action.boundary}}:{}),
            ...(key==='preflight'?{reviewTargetIds:args[2]}:{})};calls.push(row);log('driver.started',row);
          const finish=(failed:boolean,value:any)=>{row.elapsedMs=at()-row.startedMs;row.outcome=failed?'threw':'returned';
            if(failed)row.error=value?.code||value?.name||'Error';else if(key==='preflight')row.result=value;
            log('driver.finished',row);};
          try{const result=Reflect.apply(member,target,args);if(result instanceof Promise)return result.then(value=>{finish(false,value);return value;},error=>{finish(true,error);throw error;});finish(false,result);return result;}
          catch(error){finish(true,error);throw error;}
        };cache.set(key,wrapper);return wrapper;
      }});
    };
  }
  async stopOwnedDriver(){if(this.ownDriver)await this.ownDriver.close();}
}

write('request.json',{productCommit:prep.productCommit,limitMs:240000,sourceEvidence:'../real-okx-14/outcome.json',sessionId,input,
 protocol:'Same historical generic USD target for both cases. All setup and recovery share one clock. Local requires an initially obstructing boundary, a verified same-document exit, live equivalent target, and zero entry replay. Only then navigate the owned real browser to the OKX homepage, observe actual facts, and recover the unchanged historical source. No graph or permission changes; first failure stops.',
 timing:'Driver/API/attempt measurements overlap. Initial attachment and explicit scenario navigation are separate from recovery entry replay. Untriggered strategies are not accepted as exercised.',
 deadline:'At 235 s close only this owned driver; at 240 s supervisor stops only this runner. Unsettled results are never accepted.'});
let engine:MeasuredEngine|undefined,store:SqliteStore|undefined,fatal:any,closure:any,stopReason:string|undefined;
const timer=setTimeout(()=>{deadline=true;log('deadline',{limitMs:240000});void engine?.stopOwnedDriver().catch(()=>{});},235000);
function summaryObservation(o:any){return {id:o.id,url:o.url,instanceScope:o.instanceScope,browserSessionId:o.navigation?.browserSessionId,boundaries:o.boundaries,criticalGaps:o.gaps.filter((g:any)=>g.critical)};}
async function recover(name:string,current:any){
 phase=name;const began=at(),firstCall=calls.length;log('recovery.started',{input:{...input,currentObservationId:current.id}});
 const result=await engine!.reachControlReviewTarget(sessionId,{...input,currentObservationId:current.id});const elapsedMs=at()-began;
 const attempts=result.attemptIds.map(id=>store!.get<ActionAttempt>('attempt',id)!);assert.ok(attempts.every(Boolean));
 const exits=attempts.filter(a=>a.action.boundary?.intent==='exit'),entries=attempts.filter(a=>a.action.source==='recovery-entry');
 const exitTransitions=exits.filter(a=>a.afterId).map(a=>({attemptId:a.id,boundaryKey:a.action.boundary!.key,status:a.status,transition:engine!.interactionTransition(sessionId,a.beforeId,a.afterId!)}));
 const entryIndex=attempts.findIndex(a=>a.action.source==='recovery-entry');
 const localReplay=attempts.filter((a,i)=>a.recoverySegment&&(entryIndex<0||i<entryIndex)),globalReplay=attempts.filter((a,i)=>a.recoverySegment&&entryIndex>=0&&i>entryIndex);
 const final=engine!.observation(sessionId),currentProof=result.status==='CURRENT_REVIEWABLE'&&result.sourceEquivalent==='equivalent'&&result.checks.some(c=>c.name==='live-review-target-preflight'&&c.result==='pass');
 const exitVerified=exitTransitions.some(t=>t.status==='succeeded'&&t.transition.verified&&!t.transition.documentChanged&&t.transition.exited.includes(t.boundaryKey));
 const accepted=!deadline&&currentProof&&(name==='local'?exits.length>0&&exitVerified&&entries.length===0:entries.length>0);
 const duration=(a:any[])=>a.reduce((sum,a)=>sum+(a.finishedAt?Date.parse(a.finishedAt)-Date.parse(a.startedAt):0),0);
 const record={name,accepted,elapsedMs,result,attempts,exitTransitions,finalObservation:summaryObservation(final),
   localExit:{attempts:exits.length,verified:exitVerified,elapsedMs:duration(exits)},localRecordedReplay:{attempts:localReplay.length,elapsedMs:duration(localReplay)},
   wholePageReplay:{entryAttempts:entries.length,entryElapsedMs:duration(entries),replayedAttempts:globalReplay.length,replayElapsedMs:duration(globalReplay)},
   arrivalPreflight:calls.slice(firstCall).filter(c=>c.method==='preflight'&&c.reviewTargetIds?.length),
   classification:accepted?'passed':currentProof?'required_strategy_not_exercised':'recovery_not_verified'};
 cases.push(record);write(name+'-recovery.json',record);log('recovery.finished',{name,accepted,elapsedMs,status:result.status,reason:result.reason,strategies:result.diagnostics.strategies,attempts:attempts.length});
 return record;
}
try{
 store=new SqliteStore(prep.destination+'/engine');engine=new MeasuredEngine(store);
 engine.events.on('event',event=>{
  const data:any=event.data;
  if(event.type==='observation.created'||event.type==='session.reattached'||event.type.startsWith('checkpoint.')){const row={type:event.type,sequence:event.sequence,data};events.push(row);log('engine.event',row);}
  else if(['action.started','action.completed','action.unknown'].includes(event.type))log('engine.action',{type:event.type,id:data.id,status:data.status,purpose:data.purpose,beforeId:data.beforeId,afterId:data.afterId,startedAt:data.startedAt,finishedAt:data.finishedAt,action:{kind:data.action?.kind,label:data.action?.label,source:data.action?.source,boundary:data.action?.boundary}});
 });
 const assessment=engine.recoveryAssessment(sessionId);assert.equal(assessment.unknownAttempts.length,0);assert.equal(assessment.dirty,false);
 const source=engine.observation(sessionId,input.observationId);
 const observeStart=at();await engine.observe(sessionId);let current=engine.observation(sessionId);
 const candidates=current.controls.filter(c=>c.role==='generic'&&(c.name==='USD'||c.label==='USD'));
 const proofs=engine.controlReviewTargetCorrespondences(sessionId,{observationId:current.id,requests:candidates.map(c=>({localId:c.localId,source:{sessionId,observationId:input.observationId,localId:input.localId}}))}).results;
 const setup={elapsedMs:at()-observeStart,source:summaryObservation(source),current:summaryObservation(current),proofs};write('local-setup.json',setup);
 assert.ok(current.boundaries?.length,'Local setup has no active boundary');
 assert.ok(proofs.some(p=>p.targetMatched&&!p.reviewable&&p.reason==='outside_active_boundary'),'USD target is not demonstrably blocked by the active boundary');
 const local=await recover('local',current);
 if(!local.accepted)stopReason='local_'+local.classification;
 else if(deadline||at()>=235000)stopReason='window_exhausted_before_global';
 else{
  phase='global-setup';const began=at(),page=engine.ownDriver.page;
  assert.ok(page&&!page.isClosed());const destination=new URL('/',source.url).href;log('setup.navigation.started',{destination});
  await page.goto(destination,{waitUntil:'domcontentloaded',timeout:20000});const actualUrl=page.url();
  assert.equal(new URL(actualUrl).hostname,'www.okx.com');assert.notEqual(new URL(actualUrl).pathname,new URL(source.url).pathname);
  await engine.observe(sessionId);current=engine.observation(sessionId);
  const globalSetup={elapsedMs:at()-began,destination,actualUrl,source:summaryObservation(source),current:summaryObservation(current),nativeHistorySessionDiffers:source.navigation?.browserSessionId!==current.navigation?.browserSessionId};
  write('global-setup.json',globalSetup);assert.ok(globalSetup.nativeHistorySessionDiffers,'Old native history must not be available');assert.equal(current.url,actualUrl);
  assert.equal(current.gaps.filter(g=>g.critical).length,0,'Global setup has critical gaps');
  const global=await recover('global',current);if(!global.accepted)stopReason='global_'+global.classification;
 }
}catch(error:any){fatal={phase,code:error?.code||error?.name,message:error?.message};stopReason??='setup_or_execution_error';log('error',fatal);}
finally{
 clearTimeout(timer);phase='closure';const began=at();try{if(engine)await engine.close();else store?.close();closure={status:'closed',elapsedMs:at()-began};}catch(error:any){closure={status:'failed',elapsedMs:at()-began,error:error?.code||error?.name};}
 write('outcome.json',{productCommit:prep.productCommit,limitMs:240000,elapsedMs:at(),deadline,fatal,closure,stopReason,
  verdict:cases.length===2&&cases.every(c=>c.accepted)&&!deadline&&!fatal&&closure.status==='closed'?'local_and_global_recovery_passed':'not_accepted',
  cases:cases.map(({attempts,exitTransitions,result,...c})=>({...c,status:result.status,reason:result.reason,strategies:result.diagnostics.strategies,sourceEquivalent:result.sourceEquivalent,checks:result.checks,attemptIds:result.attemptIds})),
  globalNotRun:cases.every(c=>c.name!=='global'),modelCalls:0,pluginTaskDatabaseOpened:false,newCoverageGranted:false,calls,
  limitations:['This is target-directed SDK recovery, not strict checkpoint equality or a plugin continuation.','Two cases share the clock and browser; global setup is a real external navigation recorded separately, not a recovery success.','Missing required strategy is unexercised, never counted as success.','Driver/API/attempt timings overlap.','Historical source, unknown outcomes, replay permissions and graph edges remain unchanged.']});
 console.log(JSON.stringify({cases:cases.map(c=>({name:c.name,accepted:c.accepted,status:c.result.status,elapsedMs:c.elapsedMs})),stopReason,elapsedMs:at(),deadline,fatal,closure}));
}
