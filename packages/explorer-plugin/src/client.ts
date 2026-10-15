import type { Task, TaskView, ExplorerEvent } from './types.js';
export interface PluginStatus {enabled:boolean;routingVersion?:string;providers:Record<'jev'|'llm',{configured:boolean;name?:string;model?:string}>;owner?:string;capabilities:{missing:string[];boundaryExit:boolean}}
export class ExplorerClient {
  constructor(readonly baseUrl='',readonly prefix='/plugins/explorer/v1'){}
  async request<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T>{
    const response=await fetch(`${this.baseUrl}${this.prefix}${path}`,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal});
    if(!response.ok){let code='PLUGIN_UNAVAILABLE';try{code=(await response.json()).error?.code||code;}catch{}throw new Error(code);}
    return response.json();
  }
  status(){return this.request<PluginStatus>('/status');}
  tasks(){return this.request<Task[]>('/tasks');}
  task(id:string){return this.request<TaskView>(`/tasks/${encodeURIComponent(id)}`);}
  create(input:unknown){return this.request<Task>('/tasks',input);}
  command(id:string,command:string,input:Record<string,unknown>={}){return this.request<Task>(`/tasks/${encodeURIComponent(id)}/commands`,{...input,command});}
  events(id:string,after=0){return this.request<ExplorerEvent[]>(`/tasks/${encodeURIComponent(id)}/events?after=${after}`);}
}
