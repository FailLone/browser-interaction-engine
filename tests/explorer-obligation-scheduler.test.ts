const localSelectionLimit=4; // Historical metadata used by migration checks.
import { expect, it } from 'vitest';
import type { PlanItem, Task } from '@interaction/explorer-plugin';
import { bindScheduledRoute, initialSchedule, orderedObligations, reserveObligation, routeDebtAllows, selectFragmentWork, unfinishedObligations } from '../packages/explorer-plugin/src/obligation-scheduler.js';

function item(id:string,extra:Partial<PlanItem>={}):PlanItem {
  return {id,title:id,scope:{url:'https://fixture.test/',kind:'click',label:id},prerequisites:[],completion:'Actual execution',status:'pending',required:true,dispatchScope:false,reason:'operation_not_executed',evidence:[],attempts:[],...extra};
}

it('rotates unfinished conditions independently from browser frames and completed cursor rows',()=>{
  const plan=[item('root',{scope:{url:'https://fixture.test/'},dispatchScope:true}),item('A'),item('B'),item('C')],schedule=initialSchedule({});
  expect(orderedObligations(plan,schedule).map(i=>i.id)).toEqual(['A','B','C','root']);
  reserveObligation(schedule,{itemId:'A',kind:'recovery'});
  expect(orderedObligations(plan,schedule).map(i=>i.id)).toEqual(['B','C','A','root']);
  plan[1].status='succeeded';
  expect(orderedObligations(plan,JSON.parse(JSON.stringify(schedule))).map(i=>i.id)).toEqual(['B','C','root']);
});

it('keeps new local work ahead of retained work across serialization, ignoring historical quota metadata',()=>{
  let schedule=initialSchedule({});schedule.localSelections=localSelectionLimit;
  const remote={itemId:'retained',kind:'recovery' as const};
  for(let i=0;i<20;i++){
    const current={itemId:`new-${i}`,kind:'current' as const,actionId:`observed-${i}`};
    expect(selectFragmentWork({boundaryActive:false,current:[{selection:current,untried:true}],remote:[remote]}).selection).toEqual(current);
    reserveObligation(schedule,current);schedule=JSON.parse(JSON.stringify(schedule));
  }
  expect(selectFragmentWork({boundaryActive:false,current:[],remote:[remote]}).selection).toEqual(remote);
  expect(schedule.localSelections).toBe(localSelectionLimit);
});

it('does not stop unmapped fresh work when no admissible remote route exists',()=>{
  expect(selectFragmentWork({boundaryActive:false,current:[{selection:{itemId:'ready',kind:'current'},untried:true}],remote:[]}).selection?.itemId).toBe('ready');
  expect(selectFragmentWork({boundaryActive:false,current:[],remote:[]}).selection).toBeUndefined();
});

it('a failed selected target does not stay at the head after serialization',()=>{
  const plan=[item('failed'),item('reachable'),item('later')],schedule=initialSchedule({});
  reserveObligation(schedule,{itemId:'failed',kind:'recovery',routeKey:'failed-route'});
  plan[0].status='blocked';
  expect(orderedObligations(plan,JSON.parse(JSON.stringify(schedule))).map(i=>i.id)).toEqual(['reachable','later','failed']);
  expect(plan[0].status).toBe('blocked');expect(plan[0].resolvedBy).toBeUndefined();
});

it('treats a succeeded authority as permission history while retained condition children remain work',()=>{
  const root=item('root',{scope:{url:'https://fixture.test/'},dispatchScope:true,status:'succeeded'}),a=item('mode-a',{operationConditionKey:'condition-a'}),b=item('mode-b',{scope:{...aScope()},operationConditionKey:'condition-b'});
  const plan=[root,a,b];
  expect(unfinishedObligations(plan).map(i=>i.id)).toEqual(['mode-a','mode-b']);
  a.status='succeeded';b.status='succeeded';expect(unfinishedObligations(plan)).toEqual([]);
  function aScope(){return {url:'https://fixture.test/',kind:'click',label:'mode-a'};}
});

it('never schedules retired parents, excluded rows or invalidated residuals as executable targets',()=>{
  const source=item('parent',{status:'superseded',conditionMigration:{status:'split',fromKey:'old',reason:'split',sources:[]}}),residual=item('residual',{status:'blocked',conditionMigration:{status:'invalidated',fromKey:'old',reason:'source_missing',sources:[]}}),child=item('child');
  expect(unfinishedObligations([source,residual,item('excluded',{status:'excluded'}),item('optional',{required:false}),child]).map(i=>i.id)).toEqual(['child']);
  expect(residual.required).toBe(true);expect(residual.status).toBe('blocked');
});

it('preserves opaque legacy route debt until its exact key is associated',()=>{
  const schedule=initialSchedule({routeRetries:{version:1,routes:{legacy:{conditions:{known:{attempts:1,outcome:'unreachable',reason:'old failure'}},completedProgressKeys:[]}}}} as Pick<Task,'routeRetries'>);
  expect(routeDebtAllows(schedule,'new-single-target')).toBe(false);
  expect(schedule.legacyUnmappedRouteKeys).toEqual(['legacy']);
  bindScheduledRoute(schedule,'legacy',{sessionId:'s',observationId:'source',checkpointId:'cp',targets:[{label:'A'},{label:'B'}],path:[],itemIds:['old-id']});
  expect(schedule.legacyUnmappedRouteKeys).toEqual([]);
  expect(routeDebtAllows(schedule,'legacy')).toBe(true);
  const restored=JSON.parse(JSON.stringify(schedule));
  expect(restored.routes.legacy.targets).toEqual([{label:'A'},{label:'B'}]);
  expect(restored.routes.legacy).not.toHaveProperty('coverageGranted');
});
