import { expect, it, vi } from 'vitest';
import { reusableClassifications } from '../packages/explorer-plugin/src/classification-reuse.js';
import { reviewNext, type ReviewContext } from '../packages/explorer-plugin/src/reviews.js';

function fixture(){
  const control={localId:'new-node',instanceId:'new-node',tag:'div',role:'dialog',name:'Notice',label:'',visible:true,region:'notice',classificationBinding:{nodes:[],text:'Notice',truncated:false},actions:[],actionBasis:{},rect:{x:0,y:0,width:200,height:100}};
  const o={id:'new-observation',sessionId:'new-session',url:'https://fixture.test/',context:{},instanceScope:'new-document',controls:[control],regions:[],boundaries:[]};
  const record={id:'classification',sessionId:'old-session',observationId:'old-observation',classification:'container',status:'invalidated',at:'2026-10-16T00:00:00Z',evidence:['explorer-decision:original-model'],conditions:{target:{url:o.url,target:{tag:control.tag,role:control.role,name:control.name,label:''}}}};
  const task={revision:1,usage:{modelRequests:4,actions:10},rounds:[{sessionId:'old-session'},{sessionId:'new-session',reviewed:[],entryPath:[]}],plan:[{required:true,dispatchScope:true,scope:{url:o.url},prerequisites:[],status:'pending'}]};
  const query=vi.fn((_sid:any,input:any)=>({sessionId:o.sessionId,observationId:o.id,revision:'current',results:input.requests.map((request:any)=>({applicable:true,source:request.source,target:{sessionId:o.sessionId,observationId:o.id,localId:request.localId},classification:request.source.classification,identityAuthorized:false,executionAuthorized:false,currentExecution:false}))}));
  const host={session:()=>({options:{}}),actions:()=>[],regionReviewMaterial:()=>({enabled:false}),explorationReviewMaterial:()=>({groups:[]}),controlClassificationMaterial:()=>({controls:[{control,needsClassification:true,classifications:[],actions:[]}]}),list:vi.fn((sid:string,kind:string)=>kind==='control-classification'&&sid===record.sessionId?[record]:[]),classificationCorrespondences:query};
  const c={host,observation:o,task,choose:vi.fn(),programApply:vi.fn(async()=>{}),hasPendingAction:()=>false} as unknown as ReviewContext;
  return {c,host,o,task,record,query,control};
}

it('reuses SDK-verified classification through a fresh guarded command without spending model or action budget',async()=>{
  const {c,task}=fixture(),before=structuredClone(task.usage);
  expect(await reviewNext(c)).toBe(true);expect(c.choose).not.toHaveBeenCalled();expect(c.programApply).toHaveBeenCalledTimes(1);
  expect(c.programApply).toHaveBeenCalledWith(expect.objectContaining({type:'classifyControls',classification:expect.objectContaining({observationId:'new-observation',classifications:[expect.objectContaining({localId:'new-node',classification:'container',reuseFrom:{sessionId:'old-session',observationId:'old-observation',classificationId:'classification',classification:'container'}})]})}),'classification_reused',expect.objectContaining({sourceDecisionIds:['original-model'],currentExecution:false,executionAuthorized:false}));
  expect(task.usage).toEqual(before);expect(task.plan[0].status).toBe('pending');
});

it.each(['stale','wrong-source','wrong-target','rejected'])('does not reuse an unbound or rejected SDK proof: %s',change=>{
  const {c,o,control,query}=fixture();const original=query.getMockImplementation()!;
  query.mockImplementation((sid,input)=>{const result=original(sid,input);if(change==='stale')result.observationId='old';if(change==='wrong-source')result.results[0].source={...result.results[0].source,classificationId:'other'};if(change==='wrong-target')result.results[0].target.localId='other';if(change==='rejected')result.results[0].applicable=false;return result;});
  expect(reusableClassifications(c.host,c.task,o as any,[control] as any)).toEqual([]);
});

it.each(['revoked','superseded','copied','other-url'])('keeps %s history out of reuse candidates',change=>{
  const {c,o,control,record,query}=fixture();if(change==='revoked'||change==='superseded')record.status=change;if(change==='copied')(record as any).reuseFrom={classificationId:'earlier'};if(change==='other-url')record.conditions.target.url='https://other.test/';
  expect(reusableClassifications(c.host,c.task,o as any,[control] as any)).toEqual([]);expect(query).not.toHaveBeenCalled();
});

it('does not retain positive cache results after a source record changes',()=>{
  const {c,o,control,record,query}=fixture();expect(reusableClassifications(c.host,c.task,o as any,[control] as any)).toHaveLength(1);record.status='revoked';expect(reusableClassifications(c.host,c.task,o as any,[control] as any)).toEqual([]);expect(query).toHaveBeenCalledTimes(1);
});

it('does not convert an SDK application rejection into a model answer or execution',async()=>{
  const {c}=fixture();vi.mocked(c.programApply!).mockRejectedValueOnce(Object.assign(new Error('revoked'),{code:'INVALID_CLASSIFICATION_REUSE'}));
  await expect(reviewNext(c)).rejects.toMatchObject({code:'INVALID_CLASSIFICATION_REUSE'});expect(c.choose).not.toHaveBeenCalled();
});
