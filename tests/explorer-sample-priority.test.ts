import {it,expect} from 'vitest';
import {operationSamplePriority,programOperationSamplePriority} from '../packages/explorer-plugin/src/obligation-scheduler.js';
import type {PlanItem} from '@interaction/explorer-plugin';
const item=(id:string,key:string,value?:string):PlanItem=>({id,title:id,scope:{url:'http://local/',stableKey:key,targetBinding:`browser-target-binding:v1:${'a'.repeat(64)}`,label:'Same',kind:'select',value},status:'pending',required:true,completion:'receipt',reason:'observed_in_scope',prerequisites:[],evidence:[],attempts:[]});
it('prioritizes an unexecuted sample without merging contextual obligations or granting coverage',()=>{
 const done={...item('done','pair','ETH'),status:'succeeded' as const,resolvedBy:{sessionId:'s',observationId:'o',attemptId:'a'},conditionCompletion:{policy:'operation-receipt-completion-v1' as const,status:'verified' as const,reason:'portable',source:{sessionId:'s',observationId:'o',attemptId:'a'},retainedSourcesRequired:true as const}};
 const repeat={...item('repeat','pair','ETH'),operationConditionKey:'different-conditions'};const unseen=item('settings','settings','GTC');const otherValue=item('pair-other','pair','BTC');const plan=[done,repeat,unseen,otherValue];const before=structuredClone(plan);const rank=operationSamplePriority(plan);
 expect(rank(repeat)).toBeGreaterThan(rank(unseen));expect(rank(otherValue)).toBe(0);expect(plan).toEqual(before);
 expect([...plan.slice(1)].sort((a,b)=>rank(a)-rank(b)).map(i=>i.id)).toEqual(['settings','pair-other','repeat']);
});
it('keeps same-name controls and unverified receipts separate in the ordering hint',()=>{
 const source={...item('done','first'),status:'succeeded' as const,resolvedBy:{sessionId:'s',observationId:'o',attemptId:'a'}};
 const pending=item('other','second');expect(operationSamplePriority([source,pending])(pending)).toBe(0);expect(operationSamplePriority([source])(item('same','first'))).toBe(0);
});

it('deprioritizes actual no-effect samples across rebuilt instances without completing or dropping their source duties',()=>{
 const source={...item('original','instance-old'),status:'unresolved' as const,attempts:[{roundId:'r',outcome:'succeeded',evidence:{sessionId:'s',observationId:'o',attemptId:'actual'}}]};
 const same={...source,id:'additional-source'},rebuilt=item('rebuilt','instance-new'),fresh={...item('fresh','other'),scope:{...item('fresh','other').scope,targetBinding:'different-captured-target'}};
 const unknown={...item('unknown','other'),attempts:[{roundId:'r',outcome:'unknown',evidence:{sessionId:'s',observationId:'o',attemptId:'unknown'}}]};
 const plan=[source,same,rebuilt,fresh,unknown],before=structuredClone(plan),rank=programOperationSamplePriority(plan);
 expect(rank(rebuilt)).toBe(1);expect(rank(fresh)).toBe(0);expect(plan).toEqual(before);expect(source.status).toBe('unresolved');
 expect(programOperationSamplePriority([unknown])(rebuilt)).toBe(0);
});
