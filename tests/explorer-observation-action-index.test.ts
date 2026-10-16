import {expect,it} from 'vitest';
import type {ActionCandidate,Observation} from '@interaction/browser';
import type {Scope} from '@interaction/explorer-plugin';
import {observationActionIndex} from '../packages/explorer-plugin/src/observation-action-index.js';
import {keyFor,matches,scopeFor} from '../packages/explorer-plugin/src/policy.js';

function fixture(){
 const controls=Array.from({length:8},(_,i)=>({localId:`c${i}`,name:`Control ${i%3}`,label:`Control ${i%3}`,tag:'button',role:'button',region:'r',stableKey:i%2?'shared':undefined,visible:true,enabled:true,actions:['click'],constraints:{},selected:[]}));
 controls.push({...controls[0],localId:'',name:'Empty local id',label:'Empty local id'});
 // The original linear lookup uses the first duplicate local id / region.
 controls.push({...controls[0],name:'Wrong later control',label:'Wrong later control'});
 const observation={id:'o',sessionId:'s',url:'https://fixture.test/',context:{},gaps:[],boundaries:[],controls,regions:[{key:'r',label:'First region'},{key:'r',label:'Wrong later region'}]} as unknown as Observation;
 const actions=controls.slice(0,9).map((c,i)=>({id:`a${i}`,sessionId:'s',observationId:'o',localId:c.localId,kind:i%2?'click':'check',label:c.name,value:[undefined,false,0,'',true,'x'][i%6]} as ActionCandidate));
 actions.push({...actions[0],id:'duplicate-target'});
 return {observation,actions};
}

it('matches literal scope filtering for partial scopes, explicit undefined/null and duplicate targets',()=>{
 const {observation:o,actions}=fixture(),index=observationActionIndex(o,actions),fields=['url','region','label','role','stableKey','targetBinding','kind','value'] as const;
 for(const action of actions){
  const full=scopeFor(action,o);
  // More than 32 query shapes also exercises bounded-index eviction/rebuild.
  for(let mask=0;mask<256;mask++){
   const scope=Object.fromEntries(fields.filter((_,bit)=>mask&(1<<bit)).map(field=>[field,full[field]])) as Scope;
   const expected=actions.filter(candidate=>matches(scope,candidate,o));
   expect(index.matching(scope)).toEqual(expected);
   expect(index.matching(Object.fromEntries(Object.entries(scope).reverse()) as Scope)).toEqual(expected);
  }
 }
 for(const scope of [{value:null},{value:undefined},{value:false},{value:0},{value:''},{label:'missing'},{localId:''}] as unknown as Scope[])
  expect(index.matching(scope)).toEqual(actions.filter(action=>matches(scope,action,o)));
 expect(index.matching(scopeFor(actions[0],o)).map(a=>a.id)).toEqual(['a0','a6','duplicate-target']);
 expect(index.matching(scopeFor(actions[8],o)).map(a=>a.id)).toEqual(['a8']);
});

it('does not reuse conditions or scopes across observations, reused ids or context changes',()=>{
 const {observation:o,actions}=fixture(),first=observationActionIndex(o,actions);
 for(const action of actions)expect(first.condition(action)).toBe(keyFor(action,o));
 const changed=structuredClone(o);changed.id='next';changed.controls[0].name='Rebound';changed.context={tenant:{status:'known',value:'two',source:'fixture'}};
 const next=actions.map(action=>({...action,observationId:changed.id,label:action.localId==='c0'?'Rebound':action.label}));
 const second=observationActionIndex(changed,next);
 expect(second.condition(next[0])).not.toBe(first.condition(actions[0]));
 expect(second.matching(scopeFor(actions[0],o)).map(a=>a.id)).toEqual(['a6']);
 const missing={...changed,context:{tenant:{status:'unknown' as const,value:null,source:'fixture'}}};
 const unverified=observationActionIndex(missing,next);
 expect(unverified.condition(next[0])).toBe(keyFor(next[0],missing));
 // A hint is returned unchanged; this index never supplies an equivalence proof.
 expect(Object.keys(unverified).sort()).toEqual(['condition','matching']);
});
