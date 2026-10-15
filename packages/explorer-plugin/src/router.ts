import { randomUUID } from 'node:crypto';
import { ExplorerError, type Decision, type ModelAnswer, type ModelRequest, type Providers, type Task } from './types.js';
import { ExplorerStore } from './store.js';
import { safeError, validAnswer } from './providers.js';

export class DecisionRouter {
  private jevUnavailableUntil = 0;
  constructor(private store: ExplorerStore, public providers: Providers, private reserve: (task:Task)=>void) {}
  async decide(task:Task, request:Omit<ModelRequest,'id'>, signal:AbortSignal, current:()=>boolean, validate?:(value:unknown)=>unknown):Promise<{answer:ModelAnswer;decision:Decision}> {
    const req={...request,id:randomUUID()};
    if(JSON.stringify(req).length>512*1024)throw new ExplorerError('MODEL_INPUT_TOO_LARGE');
    const actors:('jev'|'llm')[]=req.kind==='generate'?['llm']:['jev','llm'];let fallback: string|undefined;
    for(const actor of actors) {
      const provider=this.providers[actor];
      if(!provider) {if(actor==='jev'){fallback='jev_not_configured';continue;}throw new ExplorerError('CONFIGURATION_REQUIRED');}
      if(actor==='jev' && Date.now()<this.jevUnavailableUntil){fallback='jev_circuit_open';continue;}
      if(signal.aborted || !current())throw new ExplorerError('CANCELLED');
      this.reserve(task);
      const round=task.rounds.at(-1); const d:Decision={id:randomUUID(),taskId:task.id,revision:task.revision,roundId:round?.id,sessionId:round?.sessionId,
        observationId:(req.state as {observationId?:string})?.observationId,actor,purpose:req.purpose,provider:provider.name,model:provider.model,request:req,input:provider.requestBody?.(req),status:'requested',startedAt:new Date().toISOString(),fallbackFrom:fallback};
      this.store.decision(d);this.event(d,'decision.requested',{purpose:d.purpose,provider:d.provider,model:d.model,fallbackFrom:fallback});
      const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;let onAbort:()=>void=()=>{};
      try {
        const abort=new Promise<never>((_,reject)=>{onAbort=()=>{controller.abort();reject(new ExplorerError('CANCELLED'));};signal.addEventListener('abort',onAbort,{once:true});timer=setTimeout(()=>{controller.abort();reject(new ExplorerError('PROVIDER_TIMEOUT'));},this.providers.timeoutMs??60000);});
        const answer=await Promise.race([provider.decide(req,controller.signal),abort]);
        d.elapsedMs=Date.now()-Date.parse(d.startedAt);d.answer=answer;d.output=answer.response;d.model=answer.model;
        if(signal.aborted || !current()){d.status='stale';d.reason='decision_context_changed';this.store.decision(d);this.event(d,'decision.stale',{});throw new ExplorerError('STALE_DECISION');}
        validAnswer(req,answer);if(validate)validate(answer.value);
        d.status='returned';this.store.decision(d);this.event(d,'decision.returned',{answer});
        if(actor==='jev') {
          const threshold=req.policy==='grouping'?(this.providers.groupingThreshold??0.65):(this.providers.choiceThreshold??0.8);
          const uncertain=req.kind==='choice' ? typeof answer.confidence!=='number' || answer.confidence<threshold || answer.value==='uncertain'
            : typeof answer.probability!=='number' || (answer.probability>(this.providers.noulLow??0.1) && answer.probability<(this.providers.noulHigh??0.9));
          // Ranking already-admissible candidates is not an authorization decision. A tie
          // need not be resolved by an expensive model; the scheduler can use stable order.
          if(req.kind==='choice'&&req.policy==='ranking') {
            const value=answer.value==='uncertain'?req.fallbackOption:answer.value;
            if(typeof value==='string'&&value!=='uncertain'&&Object.hasOwn(req.options||{},value)){
              d.resolution={source:answer.value==='uncertain'?'program':'jev',value,reason:answer.value==='uncertain'?'stable_candidate_order':'jev_ranking_only'};
              this.store.decision(d);this.resolutionEvent(d);return {answer:{...answer,value},decision:d};
            }
          }
          // Lack of evidence is a valid conservative result, not a request to invent a grant.
          if(req.kind==='choice'&&req.policy==='evidence-gate'&&answer.value==='uncertain'){
            d.resolution={source:'jev',value:answer.value,reason:'evidence_missing'};this.store.decision(d);this.resolutionEvent(d);return {answer,decision:d};
          }
          if(req.kind==='choice'&&req.policy==='planning-gate'&&(uncertain||answer.value==='retain')&&Object.hasOwn(req.options||{},'retain')){
            d.resolution={source:answer.value==='retain'?'jev':'program',value:'retain',reason:'retain_recorded_gaps'};this.store.decision(d);this.resolutionEvent(d);return {answer:{...answer,value:'retain'},decision:d};
          }
          if(uncertain){d.status='rejected';d.reason=answer.value==='uncertain'?'jev_no_choice':'jev_low_confidence';this.store.decision(d);this.event(d,'decision.fallback',{reason:d.reason,confidence:answer.confidence,probability:answer.probability,threshold});fallback=d.id;continue;}
          d.resolution={source:'jev',value:answer.value,reason:req.policy==='grouping'?'jev_grouping':'jev_confident',threshold};this.store.decision(d);
        }
        return {answer,decision:d};
      } catch(error) {
        if(error instanceof ExplorerError&&error.response)d.output=error.response;
        const code=safeError(error);if(d.status!=='stale'){d.status=signal.aborted?'cancelled':'failed';d.reason=code;d.elapsedMs=Date.now()-Date.parse(d.startedAt);this.store.decision(d);this.event(d,`decision.${d.status}`,{reason:code});}
        if(signal.aborted || ['CANCELLED','STALE_DECISION','BUDGET_EXHAUSTED'].includes(code))throw error;
        if(actor==='llm')throw new ExplorerError(code);
        this.jevUnavailableUntil=Date.now()+30000;
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
