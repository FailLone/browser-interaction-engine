// One explicitly selected historical recovery through the real BrowserEngine.
// No plugin/task DB, model, replay policy override, or manual page operations.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { BrowserEngine, type ActionAttempt } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
const root=process.cwd(),out=root+'/docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-16';
const prep=JSON.parse(readFileSync(out+'/preparation.json','utf8'));
assert.equal(process.argv[2],'--run');assert.equal(process.argv[3],prep.destination);
const baseline=JSON.parse(readFileSync(root+'/docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-15/outcome.json','utf8')).behavior.recovery;
const sessionId=baseline.sessionId,input={checkpointId:baseline.checkpointId,observationId:baseline.targetObservationId,localId:baseline.targetLocalId,requireSourceEquivalent:true};
const started=performance.now(),at=()=>performance.now()-started;
const write=(name:string,data:unknown)=>writeFileSync(out+'/'+name,JSON.stringify(data,null,2)+'\n',{flag:'wx'});
const calls:any[]=[],events:any[]=[];let callId=0,deadline=false;
const log=(type:string,data:unknown)=>appendFileSync(out+'/timeline.jsonl',JSON.stringify({at:new Date().toISOString(),elapsedMs:at(),type,data})+'\n');
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
write('request.json',{productCommit:prep.productCommit,limitMs:240000,sourceEvidence:'../real-okx-15/outcome.json',sessionId,input,
  protocol:'One SDK reachControlReviewTarget call with the exact failing historical target, on independent engine/evidence bytes and a newly launched headless browser. No plugin scheduling; no forced strategy. Driver wrappers retain original receiver/results/errors.',
  timing:'API and driver method elapsed times are inclusive and can overlap. Final checks certify SDK arrival; methods not invoked are unexercised, not successful.'});
let engine:MeasuredEngine|undefined,store:SqliteStore|undefined,result:any,fatal:any,callMs:number|undefined,attempts:any[]=[],closure:any,exitTransitions:any[]=[];
const timer=setTimeout(()=>{deadline=true;log('deadline',{limitMs:240000});void engine?.stopOwnedDriver().catch(()=>{});},235000);
try{
  store=new SqliteStore(prep.destination+'/engine');engine=new MeasuredEngine(store);
  engine.events.on('event',event=>{
    const data:any=event.data;
    if(event.type==='observation.created'||event.type==='session.reattached'||event.type.startsWith('checkpoint.')||event.type==='exploration.review_target_result'){
      const row={type:event.type,sequence:event.sequence,sessionId:event.sessionId,data};events.push(row);log('engine.event',row);
    }else if(['action.started','action.completed','action.unknown'].includes(event.type))log('engine.action',{type:event.type,id:data.id,status:data.status,purpose:data.purpose,
      beforeId:data.beforeId,afterId:data.afterId,startedAt:data.startedAt,finishedAt:data.finishedAt,action:{kind:data.action?.kind,label:data.action?.label,source:data.action?.source,boundary:data.action?.boundary}});
  });
  const before=engine.session(sessionId),assessment=engine.recoveryAssessment(sessionId);
  assert.equal(assessment.unknownAttempts.length,0);assert.equal(before.dirty,false);
  log('recovery.started',{sessionId,input,remainingActions:before.options.maxActions-before.actionCount,remainingSessionMs:before.options.maxDurationMs-before.elapsedMs});
  const began=performance.now();result=await engine.reachControlReviewTarget(sessionId,input);callMs=performance.now()-began;
  log('recovery.returned',{elapsedMs:callMs,result});
  attempts=result.attemptIds.map((id:string)=>store!.get<ActionAttempt>('attempt',id));
  assert.ok(attempts.every(Boolean));
  exitTransitions=attempts.filter(a=>a.action.boundary?.intent==='exit'&&a.afterId).map(a=>({attemptId:a.id,transition:engine!.interactionTransition(sessionId,a.beforeId,a.afterId)}));
  write('recovery.json',{elapsedMs:callMs,result,attempts,exitTransitions});
}catch(error:any){fatal={code:error?.code||error?.name,message:error?.message};log('recovery.error',fatal);}
finally{
  clearTimeout(timer);const began=at();
  try{if(engine)await engine.close();else store?.close();closure={status:'closed',elapsedMs:at()-began};}
  catch(error:any){closure={status:'failed',elapsedMs:at()-began,error:error?.code||error?.name};}
  const local=attempts.filter(a=>a.action.boundary?.intent==='exit'),entry=attempts.filter(a=>a.action.source==='recovery-entry'),entryIndex=attempts.findIndex(a=>a.action.source==='recovery-entry');
  const replay=attempts.filter((a,i)=>a.recoverySegment&&entryIndex>=0&&i>entryIndex),localReplay=attempts.filter((a,i)=>a.recoverySegment&&(entryIndex<0||i<entryIndex));
  const duration=(rows:any[])=>rows.reduce((sum,a)=>sum+(a.finishedAt?Date.parse(a.finishedAt)-Date.parse(a.startedAt):0),0);
  const checks=result?.checks||[],preflights=calls.filter(c=>c.method==='preflight'&&c.reviewTargetIds?.length);
  write('outcome.json',{productCommit:prep.productCommit,limitMs:240000,elapsedMs:at(),deadline,fatal,closure,
    verdict:!deadline&&!fatal&&closure.status==='closed'&&result?.status==='CURRENT_REVIEWABLE'&&result.sourceEquivalent==='equivalent'&&checks.some((c:any)=>c.name==='live-review-target-preflight'&&c.result==='pass')?'targeted_recovery_passed':'not_accepted',
    api:{name:'reachControlReviewTarget',calls:1,elapsedMs:callMs,status:result?.status,reason:result?.reason,strategies:result?.diagnostics?.strategies,sourceEquivalent:result?.sourceEquivalent,checks},
    localExit:{attempts:local.length,attemptIds:local.map(a=>a.id),attemptElapsedMs:duration(local),status:local.length?'see_attempt_and_arrival_checks':'not_triggered'},
    localRecordedReplay:{attempts:localReplay.length,elapsedMs:duration(localReplay)},
    wholePageReplay:{entryAttempts:entry.length,replayedAttempts:replay.length,entryElapsedMs:duration(entry),replayElapsedMs:duration(replay),status:entry.length||replay.length?'see_attempt_and_arrival_checks':'not_triggered'},
    initialization:{driverStarts:calls.filter(c=>c.method==='start').length,elapsedMs:calls.filter(c=>c.method==='start').reduce((sum,c)=>sum+(c.elapsedMs||0),0),note:'Initial fresh browser attachment is not an entry replay attempt.'},
    arrivalPreflight:{calls:preflights.length,elapsedMs:preflights.reduce((sum,c)=>sum+(c.elapsedMs||0),0),results:preflights.map(c=>c.result||c.outcome)},
    newCoverageGranted:false,modelCalls:0,pluginTaskDatabaseOpened:false,calls,
    limitations:['One fixed SDK recovery, not an autonomous plugin continuation or exhaustion test.','Untriggered local/whole-page paths remain unvalidated.','Driver timings overlap API/attempt timings; do not sum them.','Successful arrival grants neither operation execution nor historical coverage.']});
  console.log(JSON.stringify({status:result?.status,sourceEquivalent:result?.sourceEquivalent,elapsedMs:at(),deadline,fatal,closure}));
}
