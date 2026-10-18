import {afterEach,expect,it} from 'vitest';
import {fragmentFixture} from './fragment-storage-helpers.js';
import {TaskWriter} from '../packages/explorer-plugin/src/task-writer.js';
import {decideFragmentSampling,type SamplingOrigin} from '../packages/explorer-plugin/src/fragment-sampling.js';
import {preferFragmentCandidate,type FragmentFrontier} from '../packages/explorer-plugin/src/fragment-traversal.js';
const fixtures:ReturnType<typeof fragmentFixture>[]=[];
afterEach(()=>{for(const f of fixtures.splice(0))f.close();});
const fixture=()=>{const f=fragmentFixture();fixtures.push(f);return f;};
const source={sessionId:'session',observationId:'before',regionId:'menu'};
const projection=(context?:string)=>({structure:'nav/details/summary',owner:'complete local menu',revision:'revision',candidates:[{path:'./summary',operation:'click',guard:'complete local dependencies',...(context===undefined?{}:{context})}]});
const register=(f:ReturnType<typeof fixture>,name:string,context?:string)=>f.session.register('https://example.test/'+name,projection(context),source);
function record(f:ReturnType<typeof fixture>,candidate:ReturnType<typeof register>,id:string,effect?:string){
 const event={id,candidateId:candidate.candidates[0].id,fragmentId:candidate.fragment.id,sessionId:'session',observationId:'before',afterId:'after-'+id,actionId:'action-'+id,
  ...(effect===undefined?{}:{effect:f.session.material('effect',effect)})};
 f.session.put('events',event);return event;
}

it.each([
 {name:'fresh',target:'C',samples:[]},
 {name:'same context',target:'A',samples:[['A',undefined]]},
 {name:'first novel context',target:'C',samples:[['A','same']]},
 {name:'unknown second effect',target:'C',samples:[['A','same'],['B',undefined]]},
 {name:'agreeing witnesses',target:'C',samples:[['A','same'],['B','same']]},
 {name:'conflict before same context',target:'A',samples:[['A','same'],['B','different']]},
 {name:'direct with conflicting peer',target:'C',samples:[['T','same'],['A','different']]},
])('matches the independent pure sampling policy: $name',({target,samples})=>{
 const f=fixture(),records={A:register(f,'A','A'),B:register(f,'B','B'),T:register(f,'T',target)},origins:SamplingOrigin[]=[];
 samples.forEach(([name,effect],i)=>{const candidate=records[name as keyof typeof records],e=record(f,candidate,'receipt-'+i,effect);origins.push({id:e.id,candidateId:e.candidateId,context:name==='T'?target:name!,effect});});
 f.writer.flush();const id=records.T.candidates[0].id,oracle=decideFragmentSampling(id,target,origins),actual=f.session.sampling(id)!;
 expect(actual).toMatchObject({status:oracle.status,sourceCount:oracle.sourceAttemptIds.length,validationCount:oracle.validationAttemptIds.length,coverageGranted:false});
 expect(f.session.origins(id).map(r=>r.event.id)).toEqual([...oracle.sourceAttemptIds].sort());
});

it('uses every direct origin beyond audit page boundaries and invalidates a previously cached sample on conflict',()=>{
 const f=fixture(),a=register(f,'A','context-A'),b=register(f,'B','context-B'),c=register(f,'C','context-C'),id=c.candidates[0].id;
 const origins:SamplingOrigin[]=[];
 for(let i=0;i<130;i++){const event=record(f,a,'a-'+String(i).padStart(3,'0'),'same full effect');origins.push({id:event.id,candidateId:event.candidateId,context:'context-A',effect:'same full effect'});}
 const second=record(f,b,'b-witness','same full effect');origins.push({id:second.id,candidateId:second.candidateId,context:'context-B',effect:'same full effect'});f.writer.flush();
 expect(f.session.sampling(id)).toMatchObject({status:decideFragmentSampling(id,'context-C',origins).status,sourceCount:131,validationCount:131,conflictCount:0});
 expect(f.session.origins(id,'',128)).toHaveLength(128);expect(f.session.origins(id,'a-127',128).map(r=>r.event.id)).toEqual(['a-128','a-129','b-witness']);
 const conflict=record(f,b,'z-conflict','different full effect');origins.push({id:conflict.id,candidateId:conflict.candidateId,context:'context-B',effect:'different full effect'});
 expect(f.session.sampling(id)).toMatchObject({status:decideFragmentSampling(id,'context-C',origins).status,sourceCount:0,conflictCount:132});
 expect(f.session.counts(id)).toEqual({direct:false,duplicate:0,equivalent:0});expect(f.session.origins(id)).toEqual([]);
 expect(f.session.samplingOrigins(id,'a-127',128).map(r=>r.event.id)).toEqual(['a-128','a-129','b-witness','z-conflict']);
 f.writer.flush();const cold=new TaskWriter(f.store,f.store.taskState(f.task.id)).fragments();expect(cold.sampling(id)).toEqual(f.session.sampling(id));
 expect(cold.counts(a.candidates[0].id)).toEqual({direct:true,duplicate:130,equivalent:130});
});

it('lets an explicit one-way revocation override a local class without borrowing an inherited sample through another peer',()=>{
 const f=fixture(),a=register(f,'A','same context'),b=register(f,'B','same context'),c=register(f,'C','same context');record(f,a,'actual-A','observed result');f.writer.flush();
 expect(f.session.counts(b.candidates[0].id).equivalent).toBe(1);expect(f.session.counts(c.candidates[0].id).equivalent).toBe(1);
 f.session.put('edges',{id:'A-to-C',sourceFragmentId:a.fragment.id,sourceCandidateId:a.candidates[0].id,targetFragmentId:c.fragment.id,targetCandidateId:c.candidates[0].id,kind:'equivalent',revoked:{reason:'one-way mismatch'}});
 expect(f.session.sampling(c.candidates[0].id)?.status).toBe('fresh');expect(f.session.sampling(b.candidates[0].id)?.status).toBe('same-context');
 f.writer.flush();const cold=new TaskWriter(f.store,f.store.taskState(f.task.id)).fragments();expect(cold.counts(c.candidates[0].id).equivalent).toBe(0);
 expect(cold.samplingOrigins(c.candidates[0].id)).toEqual([]);expect(cold.get('events','actual-A')).toBeDefined();
 const exported=cold.exportLegacy(),imported=fragmentFixture(':memory:',exported);fixtures.push(imported);
 expect(exported.mappings.filter(e=>e.sourceCandidateId===a.candidates[0].id&&e.targetCandidateId===c.candidates[0].id)).toHaveLength(1);
 expect(imported.session.sampling(c.candidates[0].id)?.status).toBe('fresh');expect(imported.session.sampling(b.candidates[0].id)?.status).toBe('same-context');
});

it('does not manufacture a known context for records where the material is absent',()=>{
 const f=fixture(),a=register(f,'A'),b=register(f,'B'),c=register(f,'C','observed context');record(f,a,'actual-without-context','effect');f.writer.flush();
 expect(f.session.sampling(a.candidates[0].id)?.status).toBe('direct');
 expect(f.session.sampling(b.candidates[0].id)?.status).toBe('fresh');expect(f.session.sampling(c.candidates[0].id)?.status).toBe('fresh');
 expect(f.session.exportLegacy().fragments[0].candidates[0].context).toBeUndefined();
});

it('commits a conflicting result atomically with pending outcome and usage, and keeps a failed delta visible only to its writer',()=>{
 const f=fixture(),a=register(f,'A','A'),b=register(f,'B','B'),c=register(f,'C','C'),id=c.candidates[0].id;
 record(f,a,'actual-A','same');record(f,b,'actual-B','same');f.writer.flush();
 record(f,b,'different-result','different');f.task.pendingDispatch={sessionId:'session',requestId:'pending',actionId:'action',observationId:'before',itemIds:[]};f.task.usage.actions=3;
 f.store.fragmentRecords.db.exec("CREATE TRIGGER reject_context_commit BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'context transaction failure'); END;");
 expect(()=>f.writer.flush()).toThrow('context transaction failure');expect(f.session.sampling(id)?.status).toBe('observed-effect-conflict');
 const cold=new TaskWriter(f.store,f.store.taskState(f.task.id)).fragments();expect(cold.sampling(id)?.status).toBe('context-sample');
 expect(f.store.task(f.task.id).pendingDispatch).toBeUndefined();expect(cold.get('events','different-result')).toBeUndefined();
 f.store.fragmentRecords.db.exec('DROP TRIGGER reject_context_commit');f.writer.flush();
 const committed=new TaskWriter(f.store,f.store.taskState(f.task.id)).fragments();expect(committed.sampling(id)?.status).toBe('observed-effect-conflict');
 expect(f.store.task(f.task.id).pendingDispatch?.requestId).toBe('pending');expect(f.store.task(f.task.id).usage.actions).toBe(3);
});

it('does not let unvalidated context occurrences outbid a fresh revealed child',()=>{
 const f=fixture(),menu=register(f,'current','current-context');
 for(let i=0;i<20;i++)register(f,'old-'+i,'other-context-'+i);
 const child=f.session.register('https://example.test/current',{...projection('current-context'),owner:'different complete child fragment'},source);
 const frontier:FragmentFrontier={observationId:'before',byAction:new Map([
  ['menu',{fragmentId:menu.fragment.id,candidateId:menu.candidates[0].id}],['child',{fragmentId:child.fragment.id,candidateId:child.candidates[0].id}],
 ]),pruned:[],registered:0,mapped:0,unmapped:0,elapsedMs:0};
 const choices=[{actionId:'child'},{actionId:'menu'}];
 expect(f.session.peers(menu.fragment.id)).toBe(20);expect(f.session.reusablePeers(menu.fragment.id)).toBe(0);
 expect(preferFragmentCandidate(f.session,frontier,choices)).toBe(choices[0]);
 register(f,'same-context','current-context');
 expect(f.session.reusablePeers(menu.fragment.id)).toBe(1);
 expect(preferFragmentCandidate(f.session,frontier,choices)).toBe(choices[1]);
 expect(f.session.delta()?.events).toEqual([]);expect(f.task.plan).toEqual([]);
});

it('earns cross-context priority only from consistent actual witnesses and withdraws it on conflict, including after reload',()=>{
 const f=fixture(),a=register(f,'A','A'),b=register(f,'B','B'),c=register(f,'C','C');
 expect(f.session.reusablePeers(a.fragment.id)).toBe(0);
 record(f,a,'actual-A','same');expect(f.session.reusablePeers(a.fragment.id)).toBe(0);
 record(f,b,'actual-B','same');
 for(const item of [a,b,c])expect(f.session.reusablePeers(item.fragment.id)).toBe(2);
 f.writer.flush();const cold=new TaskWriter(f.store,f.store.taskState(f.task.id)).fragments();expect(cold.reusablePeers(c.fragment.id)).toBe(2);
 record(f,c,'actual-C','different');
 for(const item of [a,b,c])expect(f.session.reusablePeers(item.fragment.id)).toBe(0);
 expect(f.session.counts(a.candidates[0].id).direct).toBe(true);f.writer.flush();
 const reloaded=new TaskWriter(f.store,f.store.taskState(f.task.id)).fragments();expect(reloaded.reusablePeers(a.fragment.id)).toBe(0);
 expect(reloaded.get('events','actual-A')).toBeDefined();
});

it('preserves one-way priority revocations and missing contexts through explicit export/import',()=>{
 const f=fixture(),a=register(f,'A','same'),b=register(f,'B','same'),missing=register(f,'missing');
 expect(f.session.reusablePeers(a.fragment.id)).toBe(1);expect(f.session.reusablePeers(missing.fragment.id)).toBe(0);
 f.session.put('edges',{id:'A-to-B',sourceFragmentId:a.fragment.id,sourceCandidateId:a.candidates[0].id,targetFragmentId:b.fragment.id,targetCandidateId:b.candidates[0].id,kind:'equivalent',revoked:{reason:'one-way mismatch'}});
 expect(f.session.reusablePeers(a.fragment.id)).toBe(0);expect(f.session.reusablePeers(b.fragment.id)).toBe(1);
 f.writer.flush();const imported=fragmentFixture(':memory:',f.session.exportLegacy());fixtures.push(imported);
 expect(imported.session.reusablePeers(a.fragment.id)).toBe(0);expect(imported.session.reusablePeers(b.fragment.id)).toBe(1);
 expect(imported.session.reusablePeers(missing.fragment.id)).toBe(0);
});
