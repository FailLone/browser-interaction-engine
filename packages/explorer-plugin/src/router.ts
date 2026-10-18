import { randomUUID } from 'node:crypto';
import { ExplorerError, type Decision, type ModelAnswer, type ModelRequest, type Providers, type Task } from './types.js';
import { ExplorerStore } from './store.js';
import { safeError, validAnswer } from './providers.js';
import { resolveJudgment } from './decision-policy.js';

export class DecisionRouter {
  private jevUnavailableUntil = 0;
  constructor(private store: ExplorerStore, public providers: Providers, private reserve: (task:Task)=>void) {}
  async decide(task:Task, request:Omit<ModelRequest,'id'>, signal:AbortSignal, current:()=>boolean, validate?:(value:unknown)=>unknown):Promise<{answer:ModelAnswer;decision:Decision}> {
    const remainingDuration=()=>{
      const limit=task.budget?.durationMs;
      // Standalone router clients may omit the task clock. Runtime tasks always
      // supply it; persisted elapsed time is never reset at a model boundary.
      if(typeof limit!=='number'||!Number.isFinite(limit))return Infinity;
      return limit-(task.usage.durationMs||0)-(typeof task.activeSince==='number'?Math.max(0,Date.now()-task.activeSince):0);
    };
    const callDeadline=Date.now()+remainingDuration();
    const remainingTime=()=>Math.min(remainingDuration(),callDeadline-Date.now());
    const requireTime=()=>{if(remainingTime()<=0)throw new ExplorerError('BUDGET_EXHAUSTED');};
    requireTime();
    const req={...request,policy:request.policy??(request.kind==='checklist'?'evidence-gate':undefined),id:randomUUID()};
    if(JSON.stringify(req).length>512*1024)throw new ExplorerError('MODEL_INPUT_TOO_LARGE');
    // Built-in judgments have explicit conservative outcomes. Only unclassified custom
    // requests retain the legacy LLM fallback; generation is a separate, explicit request.
    const actors:('jev'|'llm')[]=req.kind==='generate'?['llm']:req.policy?['jev']:['jev','llm'];let fallback: string|undefined;
    for(const actor of actors) {
      requireTime();
      const provider=this.providers[actor];
      if(!provider) {if(actor==='jev'&&!req.policy){fallback='jev_not_configured';continue;}throw new ExplorerError('CONFIGURATION_REQUIRED');}
      if(actor==='jev' && Date.now()<this.jevUnavailableUntil){if(req.policy)throw new ExplorerError('JEV_TEMPORARILY_UNAVAILABLE');fallback='jev_circuit_open';continue;}
      if(signal.aborted || !current())throw new ExplorerError('CANCELLED');
      this.reserve(task);
      const round=task.rounds.at(-1); const d:Decision={id:randomUUID(),taskId:task.id,revision:task.revision,roundId:round?.id,sessionId:round?.sessionId,
        observationId:(req.state as {observationId?:string})?.observationId,actor,purpose:req.purpose,provider:provider.name,model:provider.model,request:req,input:provider.requestBody?.(req),triggeredBy:req.triggeredBy,status:'requested',startedAt:new Date().toISOString(),fallbackFrom:fallback};
      this.store.decision(d);this.event(d,'decision.requested',{purpose:d.purpose,provider:d.provider,model:d.model,fallbackFrom:fallback,triggeredBy:req.triggeredBy});
      const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;let onAbort:()=>void=()=>{};let budgetDeadline=Infinity,budgetExpired=false;
      const requireDeadline=()=>{if(remainingTime()<=0||Date.now()>=budgetDeadline)throw new ExplorerError('BUDGET_EXHAUSTED');};
      try {
        const remaining=remainingTime();if(remaining<=0)throw new ExplorerError('BUDGET_EXHAUSTED');
        budgetDeadline=Date.now()+remaining;
        const providerTimeout=Math.min(this.providers.timeoutMs??60000,req.timeoutMs??Infinity),budgetFirst=remaining<=providerTimeout;
        const abort=new Promise<never>((_,reject)=>{onAbort=()=>{reject(new ExplorerError('CANCELLED'));controller.abort();};signal.addEventListener('abort',onAbort,{once:true});timer=setTimeout(()=>{
          budgetExpired=budgetFirst||remainingTime()<=0||Date.now()>=budgetDeadline;
          // Settle our deadline before aborting: an AbortError from the provider
          // must not mask task exhaustion or trigger fallback to another model.
          reject(new ExplorerError(budgetExpired?'BUDGET_EXHAUSTED':'PROVIDER_TIMEOUT'));controller.abort();
        },Math.min(providerTimeout,remaining));});
        const answer=await Promise.race([provider.decide(req,controller.signal),abort]);
        requireDeadline();
        d.elapsedMs=Date.now()-Date.parse(d.startedAt);d.answer=answer;d.output=answer.response;d.model=answer.model;
        if(signal.aborted || !current()){d.status='stale';d.reason='decision_context_changed';this.store.decision(d);this.event(d,'decision.stale',{});throw new ExplorerError('STALE_DECISION');}
        validAnswer(req,answer);if(validate)validate(answer.value);requireDeadline();
        d.status='returned';this.store.decision(d);this.event(d,'decision.returned',{answer});
        if(actor==='jev') {
          const resolution=resolveJudgment(req,answer,this.providers);
          if(resolution){
            if(req.kind==='choice'&&(typeof resolution.value!=='string'||!Object.hasOwn(req.options||{},resolution.value)))throw new ExplorerError('INVALID_ROUTING_POLICY');
            d.resolution=resolution;this.store.decision(d);this.resolutionEvent(d);requireDeadline();return {answer:{...answer,value:resolution.value},decision:d};
          }
          const threshold=this.providers.choiceThreshold??0.8;
          const uncertain=req.kind==='choice' ? typeof answer.confidence!=='number' || answer.confidence<threshold || answer.value==='uncertain'
            : typeof answer.probability!=='number' || (answer.probability>(this.providers.noulLow??0.1) && answer.probability<(this.providers.noulHigh??0.9));
          if(uncertain){d.status='rejected';d.reason=answer.value==='uncertain'?'jev_no_choice':'jev_low_confidence';this.store.decision(d);this.event(d,'decision.fallback',{reason:d.reason,confidence:answer.confidence,probability:answer.probability,threshold});fallback=d.id;continue;}
          d.resolution={source:'jev',value:answer.value,reason:'jev_confident',threshold};this.store.decision(d);
        }
        requireDeadline();return {answer,decision:d};
      } catch(error) {
        if(error instanceof ExplorerError){if(error.response)d.output=error.response;if(error.transport)d.transport=error.transport;}
        // A provider may synchronously overrun the deadline, or finish with a
        // service error before the timer gets an event-loop turn. Budget wins.
        if(!signal.aborted&&(budgetExpired||remainingTime()<=0||Date.now()>=budgetDeadline))error=new ExplorerError('BUDGET_EXHAUSTED');
        const code=safeError(error);if(code==='BUDGET_EXHAUSTED')controller.abort();if(d.status!=='stale'){d.status=signal.aborted||code==='BUDGET_EXHAUSTED'?'cancelled':'failed';d.reason=code;d.elapsedMs=Date.now()-Date.parse(d.startedAt);this.store.decision(d);this.event(d,`decision.${d.status}`,{reason:code});}
        if(signal.aborted || ['CANCELLED','STALE_DECISION','BUDGET_EXHAUSTED'].includes(code))throw error;
        if(actor==='llm')throw new ExplorerError(code);
        this.jevUnavailableUntil=Date.now()+30000;
        if(req.policy){this.event(d,'decision.deferred',{reason:code,next:'pause_for_provider'});throw new ExplorerError(code);}
        fallback=d.id;this.event(d,'decision.fallback',{reason:code});
      } finally {clearTimeout(timer);signal.removeEventListener('abort',onAbort);}
    }
    throw new ExplorerError('CONFIGURATION_REQUIRED');
  }
  mark(d:Decision,status:Decision['status'],reason?:string){d.status=status;d.reason=reason;this.store.decision(d);this.event(d,`decision.${status}`,{reason});}
  effect(d:Decision,kind:string,data:unknown){this.event(d,'decision.effect',{kind,details:data});}
  private resolutionEvent(d:Decision){this.store.event({taskId:d.taskId,actor:'program',type:'decision.resolved',sessionId:d.sessionId,observationId:d.observationId,decisionId:d.id,data:d.resolution});}
  private event(d:Decision,type:string,data:unknown){this.store.event({taskId:d.taskId,actor:d.actor,type,sessionId:d.sessionId,observationId:d.observationId,decisionId:d.id,data});}
}
