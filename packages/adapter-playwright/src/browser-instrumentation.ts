import {randomUUID} from 'node:crypto';
import {EngineError} from '@interaction/core';

export type BrowserCommandName='start'|'execute'|'capture'|'readDOM'|'readHistory'|'waitForCaptureSample'|'waitForHistory'|'screenshot'|'verify-document'|'inventory'|'accessibility'|'context-read'|'input-validation'|'target-validation'|'scroll-traversal'|'scroll-probe'|'reopen'|'close'|'navigation-wait'|'scroll-wait';
export interface BrowserCommandEvent {
 driverId:string;id:number;command:BrowserCommandName;phase:'before'|'after';at:number;startedAt:number;input:Record<string,unknown>;
 elapsedMs?:number;status?:'returned'|'failed';operationStarted?:boolean;result?:unknown;error?:string;
}
export interface BrowserInstrumentationOptions {
 /** Synchronous accounting/rejection only. Receives detached data, never the
  * driver, Page, DOM result, witness slot or an implementation to replace. */
 observe(event:Readonly<BrowserCommandEvent>):void;
 /** Fixed, independent DOM inventory for external acceptance auditors. */
 publicInventory?:boolean;
}

/** Observation cannot replace execution. In particular, completion callbacks
 * from the final witness DOM read are deferred until native execution ends:
 * instrumentation never runs between that sample and the native input. */
export class BrowserCommandInstrumentation {
 readonly #driverId=randomUUID();#next=0;#executing=0;#pending:BrowserCommandEvent[]=[];
 constructor(private readonly options?:BrowserInstrumentationOptions){}
 get inventory(){return this.options?.publicInventory===true;}
 #emit(event:BrowserCommandEvent){
  const result:unknown=this.options?.observe(structuredClone(event));
  if(result&&typeof (result as any).then==='function'){
   void Promise.resolve(result).catch(()=>{});
   throw new EngineError('INVALID_INSTRUMENTATION','Browser command accounting must be synchronous');
  }
 }
 async run<T>(command:BrowserCommandName,input:Record<string,unknown>,perform:()=>Promise<T>,summarize?:(result:T)=>unknown):Promise<T>{
  if(!this.options)return perform();
  const startedAt=Date.now(),base={driverId:this.#driverId,id:++this.#next,command,startedAt,input:structuredClone(input)};
  try{this.#emit({...base,phase:'before',at:startedAt});}
  catch(error){try{this.#emit({...base,phase:'after',at:Date.now(),elapsedMs:Date.now()-startedAt,status:'failed',operationStarted:false,error:String(error)});}catch{}throw error;}
  if(command==='execute')this.#executing++;
  let value:T;let failure:unknown;let failed=false;let summary:unknown;
  try{value=await perform();if(summarize)summary=summarize(value);}catch(error){failed=true;failure=error;}
  const end:BrowserCommandEvent={...base,phase:'after',at:Date.now(),elapsedMs:Date.now()-startedAt,operationStarted:true,
   ...(failed?{status:'failed',error:String(failure)}:{status:'returned',...(summarize?{result:summary}:{})})};
  const emit=(event:BrowserCommandEvent)=>{try{this.#emit(event);}catch(error){if(!failed){failed=true;failure=error;}}};
  if(command==='execute'){this.#executing--;if(!this.#executing){const pending=this.#pending;this.#pending=[];for(const event of pending)emit(event);}}
  if(command==='readDOM'&&this.#executing)this.#pending.push(end);else emit(end);
  if(failed)throw failure;
  return value!;
 }
}

// Exactly the public inventory used by the original OKX independent auditor.
// It is a fixed browser read, not a user-supplied evaluator or readiness proof.
export function publicBrowserInventory(){return {url:location.href,title:document.title,headings:[...document.querySelectorAll('h1')].map(e=>e.textContent),
 controls:[...document.querySelectorAll('a,button,input,select,summary,[role="menuitem"],[role="tab"],[role="dialog"],[role="option"]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';})
 .map(e=>({tag:e.tagName,role:e.getAttribute('role'),text:(e.textContent||'').trim().slice(0,250),href:e.getAttribute('href'),disabled:e.hasAttribute('disabled'),id:e.id,expanded:e.getAttribute('aria-expanded'),selected:e.getAttribute('aria-selected'),checked:(e as HTMLInputElement).checked,roleOwner:e.closest('header,nav,main,footer,[role="dialog"],[role="navigation"]')?.tagName,ownerLabel:e.closest('[role="dialog"],[role="region"],nav')?.getAttribute('aria-label')}))};}
