import { ExplorerStore, newTaskOccurrenceId, type TaskItemDelta } from './store.js';
import { ExplorerError, type Task, type PlanItem, type Round } from './types.js';

/** Explicit runtime write set. Object references associate persistence handles;
 * they never establish that nested data is unchanged, or establish UI identity.
 * Membership arrays are frozen so an unregistered append/reorder fails closed.
 * Header and current round remain whole records; this is not a lazy Task model. */
export class TaskWriter {
  readonly task:Task;
  private version:string;
  private planRefs=new Map<PlanItem,string>();
  private roundRefs=new Map<Round,string>();
  private dirtyPlan=new Set<PlanItem>();
  private dirtyRounds=new Set<Round>();
  private addedPlan=new Set<PlanItem>();
  private addedRounds=new Set<Round>();
  private planArray:PlanItem[];
  private roundArray:Round[];
  private rewrite=false;
  conflicted=false;
  constructor(private store:ExplorerStore,state:ReturnType<ExplorerStore['taskState']>) {
    this.task=state.task;this.version=state.version;
    this.planArray=this.task.plan;this.roundArray=this.task.rounds;
    this.bind(state);
  }
  private bind(order:{plan:string[];rounds:string[]}) {
    if(order.plan.length!==this.task.plan.length||order.rounds.length!==this.task.rounds.length)throw new ExplorerError('INVALID_TASK_WRITE_SET');
    this.planRefs=new Map(this.task.plan.map((item,index)=>[item,order.plan[index]]));
    this.roundRefs=new Map(this.task.rounds.map((round,index)=>[round,order.rounds[index]]));
    if(this.planRefs.size!==order.plan.length||this.roundRefs.size!==order.rounds.length)throw new ExplorerError('INVALID_TASK_WRITE_SET');
    this.planArray=this.task.plan;this.roundArray=this.task.rounds;
    Object.freeze(this.planArray);Object.freeze(this.roundArray);
  }
  private assertMembership() {
    if(this.task.plan!==this.planArray||this.task.rounds!==this.roundArray)throw new ExplorerError('INVALID_TASK_WRITE_SET');
  }
  planChanged(item:PlanItem) {if(!this.rewrite&&!this.planRefs.has(item))throw new ExplorerError('INVALID_TASK_WRITE_SET');this.dirtyPlan.add(item);}
  roundChanged(round:Round) {if(!this.rewrite&&!this.roundRefs.has(round))throw new ExplorerError('INVALID_TASK_WRITE_SET');this.dirtyRounds.add(round);}
  appendPlan(item:PlanItem) {
    if(this.rewrite){this.task.plan.push(item);return;}
    this.assertMembership();if(this.planRefs.has(item))throw new ExplorerError('INVALID_TASK_WRITE_SET');
    this.planRefs.set(item,newTaskOccurrenceId());this.addedPlan.add(item);
    this.task.plan=this.planArray=[...this.planArray,item];Object.freeze(this.planArray);
  }
  appendRound(round:Round) {
    if(this.rewrite){this.task.rounds.push(round);return;}
    this.assertMembership();if(this.roundRefs.has(round))throw new ExplorerError('INVALID_TASK_WRITE_SET');
    const previous=this.task.rounds.at(-1);if(previous)this.roundChanged(previous);
    this.roundRefs.set(round,newTaskOccurrenceId());this.addedRounds.add(round);
    this.task.rounds=this.roundArray=[...this.roundArray,round];Object.freeze(this.roundArray);
  }
  /** Explicit, infrequent compatibility boundary for migrations/plan replacement. */
  prepareRewrite() {
    if(this.rewrite)return;this.assertMembership();this.rewrite=true;
    this.task.plan=[...this.task.plan];this.task.rounds=[...this.task.rounds];
  }
  private delta<T>(refs:Map<T,string>,dirty:Set<T>,added:Set<T>):TaskItemDelta<T>|undefined {
    if(!dirty.size&&!added.size)return;
    return {update:[...dirty].filter(item=>!added.has(item)).map(value=>({occurrenceId:refs.get(value)!,value})),
      append:[...added].map(value=>({occurrenceId:refs.get(value)!,value}))};
  }
  flush() {
    if(this.conflicted)throw new ExplorerError('STALE_TASK_VERSION');
    try {
      if(this.rewrite) {
        if(new Set(this.task.plan).size!==this.task.plan.length||new Set(this.task.rounds).size!==this.task.rounds.length)throw new ExplorerError('INVALID_TASK_WRITE_SET');
        this.version=this.store.save(this.task,this.version);
        this.bind(this.store.taskOrder(this.task.id,this.version));this.rewrite=false;
      } else {
        this.assertMembership();const current=this.task.rounds.at(-1);if(current)this.roundChanged(current);
        const {plan,rounds,...header}=this.task;
        const result=this.store.applyTaskDelta(this.task.id,this.version,{header,
          plan:this.delta(this.planRefs,this.dirtyPlan,this.addedPlan),rounds:this.delta(this.roundRefs,this.dirtyRounds,this.addedRounds)});
        this.version=result.version;this.task.updatedAt=result.updatedAt;
      }
      this.dirtyPlan.clear();this.dirtyRounds.clear();this.addedPlan.clear();this.addedRounds.clear();
    } catch(error) {
      // Never turn a stale writer into an unconditional full save. Its unknown
      // outcome and budget snapshot may be older than another committed owner.
      if((error as {code?:string}).code==='STALE_TASK_VERSION')this.conflicted=true;
      throw error;
    }
  }
}
