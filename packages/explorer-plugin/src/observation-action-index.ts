import type {ActionCandidate,Observation} from '@interaction/browser';
import type {Scope} from './types.js';
import {actionScopeReader,schedulingKeyFor,scopeFor} from './policy.js';

/** Synchronous, one-observation lookup. These keys only accelerate the existing
 * literal scope filter; they establish no target equivalence or permission.
 * Discard the whole index after the enclosing evidence read returns. */
export function observationActionIndex(observation:Observation,actions:readonly ActionCandidate[]) {
  const readScope=actionScopeReader(observation),scopes=new Map(actions.map(action=>[action,action.localId?readScope(action):scopeFor(action,observation)]));
  const indexes=new Map<string,Map<string,ActionCandidate[]>>(),conditions=new Map<ActionCandidate,string>();
  // Encode each value using exactly the comparison used by matches(). JSON
  // undefined becomes an array null, distinct from the string "null" for null.
  const valueKey=(scope:Scope,fields:(keyof Scope)[])=>JSON.stringify(fields.map(field=>JSON.stringify(scope[field])));
  return {
    matching(scope:Scope):ActionCandidate[] {
      const fields=Object.keys(scope).sort() as (keyof Scope)[],shape=JSON.stringify(fields);
      let index=indexes.get(shape);
      if(!index){
        index=new Map();
        for(const action of actions){const key=valueKey(scopes.get(action)!,fields),entries=index.get(key)||[];entries.push(action);index.set(key,entries);}
        indexes.set(shape,index);if(indexes.size>32)indexes.delete(indexes.keys().next().value!);
      }
      return index.get(valueKey(scope,fields))||[];
    },
    condition(action:ActionCandidate):string {
      if(!conditions.has(action))conditions.set(action,schedulingKeyFor(action,observation));
      return conditions.get(action)!;
    },
  };
}
