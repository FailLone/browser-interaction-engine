import {expect,it} from 'vitest';
import {selectFragmentWork,type ObligationSelection} from '../packages/explorer-plugin/src/obligation-scheduler.js';
const selection=(itemId:string,kind:ObligationSelection['kind']='current'):ObligationSelection=>({itemId,kind});
const prior=selection('original-child','recovery');
it('keeps arbitrarily many new current candidates ahead of retained work without a page counter',()=>{
 for(let i=0;i<100;i++){
  const next=selection(`fresh-${i}`);
  expect(selectFragmentWork({boundaryActive:false,current:[{selection:next,untried:true}],remote:[prior]})).toMatchObject({selection:next,reason:'untried_current_candidate',needsRecovery:false});
 }
});
it('requests route assessment after finite current exhaustion or sampled-only choices and keeps the old item',()=>{
 const sampled=selection('sampled-control');
 for(const current of [[],[{selection:sampled,untried:false}]]){
  expect(selectFragmentWork({boundaryActive:false,current,remote:[]}).needsRecovery).toBe(true);
  expect(selectFragmentWork({boundaryActive:false,current,remote:[prior]})).toMatchObject({selection:prior,reason:'retained_work_after_current_samples'});
 }
});
it('finishes an explicitly selected original route before unrelated fresh work, but cannot escape an active boundary',()=>{
 const fresh=selection('fresh'),continuation=selection('original-child','reentry');
 expect(selectFragmentWork({boundaryActive:false,continuation,current:[{selection:fresh,untried:true}],remote:[]})).toMatchObject({selection:continuation,reason:'selected_route_continuation'});
 expect(selectFragmentWork({boundaryActive:true,continuation,current:[],remote:[prior]})).toEqual({selection:undefined,reason:'active_boundary',needsRecovery:false});
});
it('retains a sampled fallback when no route is available without granting coverage or deleting candidates',()=>{
 const input={boundaryActive:false,current:[{selection:selection('sampled'),untried:false}],remote:[]},copy=structuredClone(input);
 expect(selectFragmentWork(input)).toMatchObject({selection:input.current[0].selection,reason:'sampled_current_fallback',needsRecovery:true});expect(input).toEqual(copy);
});
