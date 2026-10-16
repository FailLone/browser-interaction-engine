import type { Task, TaskView, ExplorerEvent,Decision } from './types.js';
export interface ExplorerUpdates extends Omit<TaskView,'task'> {task?:Task;taskVersion:string;cursor:number;hasMore:boolean}
export type ExplorerTaskSummary=Pick<Task,'id'|'goal'|'url'|'status'>&{rounds:{sessionId:string}[]};
export interface PluginStatus {enabled:boolean;routingVersion?:string;providers:Record<'jev'|'llm',{configured:boolean;name?:string;model?:string}>;owner?:string;capabilities:{missing:string[];boundaryExit:boolean}}
export class ExplorerClient {
  constructor(readonly baseUrl='',readonly prefix='/plugins/explorer/v1'){}
  async request<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T>{
    const response=await fetch(`${this.baseUrl}${this.prefix}${path}`,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal});
    if(!response.ok){let code='PLUGIN_UNAVAILABLE';try{code=(await response.json()).error?.code||code;}catch{}throw new Error(code);}
    return response.json();
  }
  status(signal?:AbortSignal){return this.request<PluginStatus>('/status',undefined,signal);}
  tasks(signal?:AbortSignal){return this.request<Task[]>('/tasks',undefined,signal);}
  taskSummaries(signal?:AbortSignal){return this.request<ExplorerTaskSummary[]>('/tasks?summary=true',undefined,signal);}
  task(id:string,signal?:AbortSignal){return this.request<TaskView>(`/tasks/${encodeURIComponent(id)}`,undefined,signal);}
  create(input:unknown){return this.request<Task>('/tasks',input);}
  command(id:string,command:string,input:Record<string,unknown>={}){return this.request<Task>(`/tasks/${encodeURIComponent(id)}/commands`,{...input,command});}
  events(id:string,after=0){return this.request<ExplorerEvent[]>(`/tasks/${encodeURIComponent(id)}/events?after=${after}`);}
  updates(id:string,after=0,signal?:AbortSignal,taskVersion?:string){return this.request<ExplorerUpdates>(`/tasks/${encodeURIComponent(id)}/updates?after=${after}${taskVersion?`&taskVersion=${encodeURIComponent(taskVersion)}`:''}`,undefined,signal);}
}

/** One task's immutable UI snapshots. Initial history is retained; subsequent polls
 * fetch only new events and the decisions those events changed, including old rows. */
export class ExplorerTaskFeed {
  private view?:TaskView;
  private cursor=0;
  private taskVersion?:string;
  private pending?:Promise<TaskView>;
  constructor(private client:ExplorerClient,readonly taskId:string){}
  refresh(signal?:AbortSignal):Promise<TaskView> {
    if(this.pending)return this.pending;
    const load=async()=>{
      if(!this.view){this.view=await this.client.task(this.taskId,signal);this.cursor=this.view.events.at(-1)?.sequence??0;}
      for(;;){
        const page=await this.client.updates(this.taskId,this.cursor,signal,this.taskVersion);
        if(page.task&&page.task.id!==this.taskId||page.cursor<this.cursor||(page.hasMore&&page.cursor===this.cursor))throw new Error('INVALID_EXPLORER_CURSOR');
        if(!page.task&&!page.decisions.length&&!page.events.length&&!page.hasMore){this.taskVersion=page.taskVersion;return this.view;}
        const decisions:Map<string,Decision>=new Map(this.view.decisions.map(d=>[d.id,d]));for(const d of page.decisions)decisions.set(d.id,d);
        this.view={task:page.task??this.view.task,decisions:[...decisions.values()],events:[...this.view.events,...page.events.filter(e=>e.sequence>this.cursor)]};
        this.cursor=page.cursor;this.taskVersion=page.taskVersion;
        if(!page.hasMore)return this.view;
      }
    };
    this.pending=load().finally(()=>{this.pending=undefined;});return this.pending;
  }
}
