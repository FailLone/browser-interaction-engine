import { expect,it,vi } from 'vitest';
import type { ExplorerHost,Task,Scope } from '@interaction/explorer-plugin';
import type { Observation } from '@interaction/browser';
import { remapStoredScopes } from '../packages/explorer-plugin/src/scope-migration.js';
const control=(stableKey:string,recordKey:string)=>({stableKey,tag:'button',role:'button',name:'Run',label:'Run',constraints:{},structuralItem:{recordKey,template:'button-row',slot:'0'}});
const observation=(id:string,controls:unknown[])=>({id,sessionId:'s',url:'https://example.test/',regions:[],controls}) as unknown as Observation;
function fixture(){
 const sources=new Map<string,Observation>([['first',observation('first',[control('id:entry','record-one'),control('testid:second','record-second')])]]);
 const read=vi.fn((sid:string,id:string)=>{const o=sources.get(id);if(!o)throw Error('missing');return o;});
 const host={observation:read} as unknown as ExplorerHost;
 const scope:Scope={url:'https://example.test/',label:'Run',role:'button',stableKey:'id:entry',kind:'click'};
 const item=(id:string,s:Scope,oid='first')=>({id,title:id,scope:s,prerequisites:[],completion:'Verify',status:'unresolved' as const,required:true,dispatchScope:false,reason:'operation_not_executed',evidence:[{sessionId:'s',observationId:oid}],attempts:[]});
 const task={id:'task',plan:[item('old',{...scope}),item('native',{url:'https://example.test/',stableKey:'id:plain'})],rounds:[]} as unknown as Task;
 return {sources,read,host,scope,item,task};
}
it('persists successful and negative immutable-source projections across resume without rereading large observations',()=>{
 const f=fixture();expect(remapStoredScopes(f.task,f.host)).toHaveLength(1);expect(f.read).toHaveBeenCalledTimes(1);
 const restored=JSON.parse(JSON.stringify(f.task)) as Task;
 restored.plan.push(f.item('legacy-again',{...f.scope}));
 expect(remapStoredScopes(restored,f.host)).toHaveLength(1);expect(f.read).toHaveBeenCalledTimes(1);
 expect(restored.plan.every(i=>i.status==='unresolved'&&!i.resolvedBy&&i.attempts.length===0&&i.dispatchScope===false)).toBe(true);
 expect(remapStoredScopes(restored,f.host)).toEqual([]);expect(f.read).toHaveBeenCalledTimes(1);
});
it('adds new source evidence without dropping old positive candidates or hiding newly ambiguous correspondence',()=>{
 const f=fixture();remapStoredScopes(f.task,f.host);
 f.sources.set('second',observation('second',[control('id:entry','different-record')]));
 f.task.plan.push(f.item('reintroduced',{...f.scope}),f.item('conflict',{...f.scope},'second'));
 expect(remapStoredScopes(f.task,f.host)).toEqual([]);expect(f.read).toHaveBeenCalledTimes(2);
 expect(f.task.plan.find(i=>i.id==='reintroduced')!.scope).toEqual(f.scope);
 expect(remapStoredScopes(f.task,f.host)).toEqual([]);expect(f.read).toHaveBeenCalledTimes(2);
});
it('rescans existing immutable sources for newly requested keys and invalidates a changed projection version',()=>{
 const f=fixture();remapStoredScopes(f.task,f.host);
 f.task.plan.push(f.item('new-key',{...f.scope,stableKey:'testid:second'}));
 expect(remapStoredScopes(f.task,f.host)).toHaveLength(1);expect(f.read).toHaveBeenCalledTimes(2);
 f.task.scopeMigrationIndex!.version=999 as 1;
 expect(remapStoredScopes(f.task,f.host)).toEqual([]);expect(f.read).toHaveBeenCalledTimes(3);
});
it('does not cache unavailable evidence and never authorizes or completes a row when that evidence later appears',()=>{
 const f=fixture(),source=f.sources.get('first')!;f.sources.clear();
 expect(remapStoredScopes(f.task,f.host)).toEqual([]);expect(f.task.scopeMigrationIndex!.sources).toEqual({});
 f.sources.set('first',source);expect(remapStoredScopes(f.task,f.host)).toHaveLength(1);expect(f.read).toHaveBeenCalledTimes(2);
 expect(f.task.plan.every(i=>i.status==='unresolved'&&!i.resolvedBy&&i.attempts.length===0&&i.dispatchScope===false)).toBe(true);
});
it('bounds persisted projections without losing candidates from the current migration pass',()=>{
 const f=fixture();f.task.scopeMigrationIndex={version:1,keys:['id:entry'],sources:Object.fromEntries(Array.from({length:1100},(_,i)=>[`s:unused-${i}`,{sessionId:'s',observationId:`unused-${i}`,examinedKeys:1,matches:[]}]))};
 expect(remapStoredScopes(f.task,f.host)).toHaveLength(1);expect(Object.keys(f.task.scopeMigrationIndex!.sources)).toHaveLength(1024);
});
