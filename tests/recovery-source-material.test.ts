import {afterEach,expect,it,vi} from 'vitest';
import {BrowserEngine,type ActionCandidate,type Observation} from '@interaction/browser';
import {EngineError,type Persistence} from '@interaction/core';
import {MemoryStore} from '@interaction/storage-memory';
import {SqliteStore} from '@interaction/storage-sqlite';
import {RetainedPersistence} from '@interaction/storage-retained';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const engines:BrowserEngine[]=[];
const directories:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const engine of engines.splice(0))await engine.close();for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true});});
function withdrawIsolation(store:Persistence) {Object.defineProperty(store,'recordReadIsolation',{get:()=>undefined,configurable:true});}

function observation(id:string,patch:Partial<Observation>={}):Observation {
  return {id,sessionId:'session',capturedAt:'2026-10-17T00:00:00.000Z',instanceScope:'document',documentId:'document',
    url:'https://material.fixture.invalid/',stateId:`state-${id}`,visitId:`visit-${id}`,fingerprint:id,canonical:id,ruleVersion:'test-v1',cause:'inspection',
    stable:true,gaps:[],context:{account:{status:'known',value:'A',source:'fixture'}},regions:[{key:'region',label:'Page',role:'main'}],
    boundaries:[],overlays:[],components:[],controls:[{localId:`control-${id}`,instanceId:'same-node',role:'checkbox',name:'Mode',label:'Mode',
      region:'region',visible:true,enabled:true,tag:'input',actions:['check'],readOnly:false,checked:false}],...patch} as unknown as Observation;
}
function action(o:Observation,id='action',patch:Partial<ActionCandidate>={}):ActionCandidate {
  return {id,sessionId:o.sessionId,observationId:o.id,stateId:o.stateId,localId:o.controls[0].localId,kind:'check',value:false,label:'Mode',
    preconditions:{visible:true,enabled:true,identityResolved:false,context:o.context},risk:'unknown',replayable:false,source:'control',
    sampleValidity:'unknown',basis:{status:'tentative',evidence:[]},excluded:false,...patch} as ActionCandidate;
}
function fixture(store:Persistence=new MemoryStore(),Engine:typeof BrowserEngine=BrowserEngine) {
  const engine=new Engine({persistence:store});engines.push(engine);
  const source=observation('source'),current=observation('current'),sourceAction=action(source);
  store.put('session',{id:'session',status:'paused',currentObservationId:current.id,options:{},dirty:false});
  store.put('observation',source);store.put('observation',current);store.put('action',sourceAction);
  const read=(sourceObservationId=source.id,currentObservationId=current.id)=>engine.recoverySourceMaterial('session',{sourceObservationId,currentObservationId});
  return {engine,store,source,current,sourceAction,read};
}

it('matches separate public reads with one source read, one comparison read and one action query',()=>{
  const f=fixture(),expected={source:f.engine.observation('session','source'),actions:f.engine.actions('session','source'),transition:f.engine.interactionTransition('session','source','current')};
  const require=vi.spyOn(f.engine.store,'require'),scoped=f.engine.store.listByObservation!,transactions=vi.spyOn(f.engine.store,'transaction');
  const actions=vi.fn((kind:string,sid:string,oid:string)=>scoped(kind,sid,oid));f.engine.store.listByObservation=actions as Persistence['listByObservation'];
  expect(f.read()).toEqual(expected);
  expect(require.mock.calls).toEqual([['observation','source'],['observation','current']]);
  expect(actions.mock.calls).toEqual([['action','session','source']]);
  // MemoryStore transactions snapshot the whole store. This fact query must not
  // introduce that work or an implicit mutation/rollback boundary.
  expect(transactions).not.toHaveBeenCalled();
});

it('reads identical IDs once and permits an explicit historical comparison without asserting the live cursor',()=>{
  const f=fixture(),expected=f.engine.interactionTransition('session','source','source'),require=vi.spyOn(f.engine.store,'require');
  expect(f.read('source','source').transition).toEqual(expected);
  expect(require.mock.calls).toEqual([['observation','source']]);
  expect(f.engine.session('session').currentObservationId).toBe('current');
});

it.each([
  ['source','missing','current','not found'],
  ['comparison','source','missing','not found'],
  ['foreign source','foreign','current','does not belong to session'],
  ['foreign comparison','source','foreign','does not belong to session'],
] as const)('retains %s ownership and missing-record failures',(_label,source,current,message)=>{
  const f=fixture();f.store.put('observation',observation('foreign',{sessionId:'other'}));
  expect(()=>f.read(source,current)).toThrow(message);
  expect(f.store.events('session')).toEqual([]);
});

it.each([['','current'],['source','']] as const)('requires explicit nonempty IDs: %s / %s',(source,current)=>{
  const f=fixture();expect(()=>f.read(source,current)).toThrow('requires two explicit observation IDs');
});

it('preserves action occurrence order, falsy inputs, unsupported candidates and indexed/fallback equality',()=>{
  const f=fixture();withdrawIsolation(f.engine.store);
  const rows=[f.sourceAction,{...f.sourceAction},action(f.source,'same-id',{value:true}),action(f.source,'same-id',{kind:'fill',value:0}),
    action(f.source,'same-id',{kind:'fill',value:''}),action(f.current,'unrelated')];
  const expected=rows.filter(row=>row.observationId==='source');
  f.engine.store.listByObservation=()=>expected as never;
  expect(f.read().actions).toEqual(expected);expect(f.read().actions).toHaveLength(5);
  f.engine.store.listByObservation=undefined;
  vi.spyOn(f.engine.store,'list').mockImplementation((kind,sid)=>kind==='action'&&sid==='session'?rows as never:[]);
  expect(f.read().actions).toEqual(expected);
  expect(f.read().actions[0].basis?.status).toBe('tentative');
});

it('isolates mutable returned nested facts and arrays without freezing store-owned values',()=>{
  const f=fixture(),source=f.source,rows=[f.sourceAction];withdrawIsolation(f.engine.store);
  // A legacy third-party store may return borrowed values rather than clones.
  f.engine.store.require=<T>(kind:string,id:string):T=>{
    if(kind==='observation'&&id==='source')return source as T;
    if(kind==='observation'&&id==='current')return f.current as T;
    throw new EngineError('NOT_FOUND','Missing fixture record');
  };
  f.engine.store.listByObservation=undefined;f.engine.store.entityChanges=undefined;
  f.engine.store.list=()=>rows as never;
  const expected=f.read(),result=f.read();
  result.source.controls[0].name='caller mutation';result.source.context.account.value='caller account';
  result.actions[0].preconditions.context.account.value='caller context';result.actions.push({...result.actions[0],id:'injected'});
  result.transition.retainedControls[0].afterLocalId='caller target';
  expect(source.controls[0].name).toBe('Mode');expect(source.context.account.value).toBe('A');expect(rows).toHaveLength(1);
  expect(Object.isFrozen(source)).toBe(false);expect(Object.isFrozen(rows)).toBe(false);
  expect(f.read()).toEqual(expected);
});

it('reloads same-ID source facts and mutable action reviews on the next call without change-feed support',()=>{
  const f=fixture(),source=f.source,rows=[f.sourceAction];withdrawIsolation(f.engine.store);
  f.engine.store.require=<T>(_kind:string,id:string):T=>(id==='source'?source:f.current) as T;
  f.engine.store.listByObservation=undefined;f.engine.store.entityChanges=undefined;f.engine.store.list=()=>rows as never;
  const first=f.read();
  source.context.account.value='B';source.instanceScope='replaced-document';source.gaps.push({code:'incomplete',message:'New critical gap',critical:true});
  rows[0].excluded=true;rows[0].exclusionReason='review revoked';rows[0].value=true;
  const second=f.read();
  expect(first.source.context.account.value).toBe('A');expect(first.actions[0].value).toBe(false);
  expect(second.source.context.account.value).toBe('B');expect(second.source.gaps[0].critical).toBe(true);
  expect(second.actions[0]).toMatchObject({excluded:true,exclusionReason:'review revoked',value:true});
  expect(second.transition).toMatchObject({documentChanged:true,retainedControls:[]});
});

it.each(['duplicate source instance','duplicate comparison instance','new document','critical source','critical comparison'] as const)('keeps conservative occurrence projection for %s',variant=>{
  const f=fixture(),before=structuredClone(f.source),after=structuredClone(f.current);withdrawIsolation(f.engine.store);
  if(variant==='duplicate source instance')before.controls.push({...before.controls[0],localId:'duplicate'});
  if(variant==='duplicate comparison instance')after.controls.push({...after.controls[0],localId:'duplicate'});
  if(variant==='new document')after.instanceScope='new-document';
  if(variant==='critical source')before.gaps.push({code:'missing',message:'Missing source',critical:true});
  if(variant==='critical comparison')after.gaps.push({code:'missing',message:'Missing comparison',critical:true});
  f.engine.store.require=<T>(_kind:string,id:string):T=>(id==='source'?before:after) as T;
  expect(f.read().transition).toEqual(f.engine.interactionTransition('session','source','current'));
  expect(f.read().transition.retainedControls).toEqual([]);
});

it('propagates storage failures without returning partial material or retaining a failed lookup',()=>{
  const f=fixture(),original=f.engine.store.listByObservation!;
  f.engine.store.listByObservation=()=>{throw new Error('corrupt stored action');};
  expect(()=>f.read()).toThrow('corrupt stored action');
  f.engine.store.listByObservation=original;
  expect(f.read().actions).toEqual([f.sourceAction]);
});

it('only returns facts and leaves unknown attempts, route events and dispatch unchanged',()=>{
  const f=fixture(),attempt={id:'unknown-attempt',sessionId:'session',action:f.sourceAction,status:'unknown',beforeId:'source',purpose:'recovery'};
  f.store.put('attempt',attempt);
  const before={attempts:f.store.list('attempt','session'),events:f.store.events('session')},execute=vi.spyOn(f.engine,'execute'),reach=vi.spyOn(f.engine,'reachCheckpoint');
  const result=f.read();
  expect(result.actions[0]).toMatchObject({risk:'unknown',preconditions:{identityResolved:false},basis:{status:'tentative'}});
  expect(Object.keys(result).sort()).toEqual(['actions','source','transition']);
  expect({attempts:f.store.list('attempt','session'),events:f.store.events('session')}).toEqual(before);
  expect(execute).not.toHaveBeenCalled();expect(reach).not.toHaveBeenCalled();
});

it('preserves subclass action and transition projections instead of bypassing their public methods',()=>{
  class ProjectedEngine extends BrowserEngine {
    override actions(sid:string,oid?:string) {return super.actions(sid,oid).map(a=>({...a,label:'Subclass projection',excluded:true}));}
    override interactionTransition(sid:string,before:string,after:string) {
      return {...super.interactionTransition(sid,before,after),verified:false,retainedControls:[],custom:{reason:'Subclass transition'}};
    }
  }
  const f=fixture(new MemoryStore(),ProjectedEngine),expected={source:f.engine.observation('session','source'),actions:f.engine.actions('session','source'),transition:f.engine.interactionTransition('session','source','current')};
  const actions=vi.spyOn(f.engine,'actions'),transition=vi.spyOn(f.engine,'interactionTransition');
  expect(f.read()).toEqual(expected);
  expect(actions).toHaveBeenCalledExactlyOnceWith('session','source');
  expect(transition).toHaveBeenCalledExactlyOnceWith('session','source','current');
});

it('keeps instance-decorated results isolated, including an override that does not read the comparison frame',()=>{
  const f=fixture(),rows=[{...f.sourceAction,label:'Decorated action'}];
  const transition={beforeId:'decorated-before',afterId:'decorated-after',verified:false,documentChanged:false,navigated:false,
    retainedControls:[{beforeLocalId:'custom-before',afterLocalId:'custom-after'}],entered:[],exited:[],revealedControlIds:[]};
  f.engine.actions=()=>rows;f.engine.interactionTransition=()=>transition;
  const expected={source:f.engine.observation('session','source'),actions:structuredClone(rows),transition:structuredClone(transition)};
  // The old public override does not demand this frame, so the combination must
  // not introduce an eager hidden base implementation's ownership/read failure.
  const result=f.read('source','missing-but-not-read-by-override');expect(result).toEqual(expected);
  result.actions[0].label='caller action';result.transition.retainedControls[0].afterLocalId='caller target';
  expect(rows[0].label).toBe('Decorated action');expect(transition.retainedControls[0].afterLocalId).toBe('custom-after');
  expect(f.read('source','missing-but-not-read-by-override')).toEqual(expected);
});

it.each(['current','source'])('preserves a decorated observation method and its separate-read sequence for comparison %s',comparison=>{
  const f=fixture(),read=f.engine.observation.bind(f.engine);let sequence:string[]=[];
  f.engine.observation=(sid,oid)=>{sequence.push(oid||'');return {...read(sid,oid),instanceScope:`projection-${sequence.length}`};};
  const expected={source:f.engine.observation('session','source'),actions:f.engine.actions('session','source'),transition:f.engine.interactionTransition('session','source',comparison)};
  const expectedSequence=[...sequence];sequence=[];
  expect(f.read('source',comparison)).toEqual(expected);expect(sequence).toEqual(expectedSequence);
  expect(sequence).toEqual(['source','source','source',comparison]);
});

it.each(['memory','sqlite'] as const)('%s declares detached entity reads and avoids copying isolated source material again',kind=>{
  let store:Persistence;
  if(kind==='memory')store=new MemoryStore();else{const path=mkdtempSync(join(tmpdir(),'source-material-isolation-'));directories.push(path);store=new SqliteStore(path);}
  const f=fixture(store);expect(store.recordReadIsolation).toBe('detached');expect(f.engine.store.recordReadIsolation).toBe('detached');
  const read=f.engine.store.require,readActions=f.engine.store.listByObservation!;let source:Observation|undefined,actions:ActionCandidate[]|undefined;
  f.engine.store.require=<T>(kind:string,id:string):T=>{const value=read<T>(kind,id);if(kind==='observation'&&id==='source')source=value as Observation;return value;};
  f.engine.store.listByObservation=<T>(kind:string,sid:string,oid:string):T[]=>{const value=readActions<T>(kind,sid,oid);if(kind==='action')actions=value as ActionCandidate[];return value;};
  const first=f.read();expect(first.source).toBe(source);expect(first.actions).toBe(actions);
  const next=f.read();expect(next.source).not.toBe(first.source);expect(next.actions).not.toBe(first.actions);
  first.source.controls[0].name='caller changed';first.source.context.account.value='caller context';
  first.actions[0].preconditions.context.account.value='caller action context';first.actions.push({...first.actions[0],id:'caller extra'});
  first.transition.retainedControls[0].afterLocalId='caller target';
  expect(f.read()).toEqual(next);expect(store.require<Observation>('observation','source').controls[0].name).toBe('Mode');
  const records=[store.get<ActionCandidate>('action','action')!,store.require<ActionCandidate>('action','action'),store.list<ActionCandidate>('action','session')[0],store.listByObservation!<ActionCandidate>('action','session','source')[0]];
  for(let i=0;i<records.length;i++){
    records[i].preconditions.context.account.value=`mutation-${i}`;
    expect(store.require<ActionCandidate>('action','action').preconditions.context.account.value).toBe('A');
    expect(records.slice(i+1).every(record=>record.preconditions.context.account.value==='A')).toBe(true);
  }
});

it('retention forwards the current backing declaration, including its withdrawal',()=>{
  const backing=new MemoryStore();let isolation:Persistence['recordReadIsolation']='detached';
  Object.defineProperty(backing,'recordReadIsolation',{get:()=>isolation});
  const retained=new RetainedPersistence(backing);
  try{expect(retained.recordReadIsolation).toBe('detached');isolation=undefined;expect(retained.recordReadIsolation).toBeUndefined();}
  finally{retained.close();}
});

it.each(['get','require','list','listByObservation'] as const)('retention does not transfer a replacement %s declaration to its older bound reader',method=>{
  const backing=new MemoryStore();let isolation:Persistence['recordReadIsolation'];
  Object.defineProperty(backing,'recordReadIsolation',{get:()=>isolation});
  const retained=new RetainedPersistence(backing),original=backing[method];
  try{
    expect(retained.recordReadIsolation).toBeUndefined();
    Object.defineProperty(backing,method,{value:original.bind(backing),writable:true,configurable:true});
    isolation='detached';expect(retained.recordReadIsolation).toBeUndefined();
    Object.defineProperty(backing,method,{value:original});expect(retained.recordReadIsolation).toBe('detached');
    isolation=undefined;expect(retained.recordReadIsolation).toBeUndefined();
  }finally{retained.close();}
});

it('copies the old borrowed retention reader after its backing replaces that reader and grants isolation',()=>{
  const backing=new MemoryStore(),read=backing.require.bind(backing),source=observation('source');
  let isolation:Persistence['recordReadIsolation'];
  Object.defineProperty(backing,'recordReadIsolation',{get:()=>isolation});
  backing.require=<T>(kind:string,id:string):T=>kind==='observation'&&id==='source'?source as T:read<T>(kind,id);
  const f=fixture(backing);backing.require=read;isolation='detached';
  expect(backing.recordReadIsolation).toBe('detached');expect(f.engine.store.recordReadIsolation).toBeUndefined();
  const result=f.read();expect(result.source).not.toBe(source);
  result.source.controls[0].name='caller mutation';expect(source.controls[0].name).toBe('Mode');
});

it('copies defensively if a read withdraws its isolation declaration',()=>{
  const f=fixture();let isolation:Persistence['recordReadIsolation']='detached';
  Object.defineProperty(f.engine.store,'recordReadIsolation',{get:()=>isolation});
  const source=f.source,actions=[f.sourceAction];
  f.engine.store.require=<T>(_kind:string,id:string):T=>{isolation=undefined;return (id==='source'?source:f.current) as T;};
  f.engine.store.listByObservation=()=>actions as never;
  const result=f.read();expect(result.source).not.toBe(source);expect(result.actions).not.toBe(actions);
  result.source.controls[0].name='caller mutation';expect(source.controls[0].name).toBe('Mode');
});
