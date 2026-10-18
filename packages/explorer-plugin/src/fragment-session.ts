import {fragmentProjectionPolicy} from '@interaction/browser';
import {ExplorerError} from './types.js';
import {taskDigest} from './task-codec.js';
import {splitFragmentMaterial,readFragmentMaterial,fragmentMaterialId,type FragmentMaterialKind} from './fragment-codec.js';
import {decodeFragmentMaterial,encodeFragmentMaterial} from './fragment-material.js';
import {FragmentStore} from './fragment-store.js';
import {emptyFragmentDelta,fragmentRoot,fragmentRowKinds,type FragmentDelta,type FragmentRoot,type FragmentRows,type FragmentRowKind,type FragmentTraversalLedger,type FragmentRecord,type CandidateRecord} from './fragment-records.js';

const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export type FragmentCounters={direct:boolean;duplicate:number;equivalent:number};
export type FragmentProjectionInput={structure:string;owner:string;revision:string;candidates:{path:string;operation:string;guard:string}[]};
/** A small explicit write set over indexed durable records. Closing/reloading
 * a session does not generate events. Failed flushes retain this write set. */
export class FragmentSession {
  root:FragmentRoot;private pending:FragmentDelta;private dirty=false;
  private maps:Partial<{[K in FragmentRowKind]:Map<string,FragmentRows[K]>}>={};
  private atoms=new Map<string,FragmentDelta['atoms'][number]>();private materials=new Map<string,FragmentDelta['materials'][number]>();
  private countCache=new Map<string,FragmentCounters>();private cacheStamp='';
  private peerCache=new Map<string,number>();private checkedClasses=new Set<string>();
  private baseRoot?:FragmentRoot;
  private snapshot<T>(read:()=>T):T{return this.store.db.inTransaction?read():this.store.db.transaction(read)();}
  private checkSnapshot(){
    if(!equal(this.store.root(this.taskId),this.baseRoot))throw new ExplorerError('STALE_TASK_VERSION');
    const stamp=this.root.epoch+':'+this.store.changeToken();if(stamp!==this.cacheStamp){this.countCache.clear();this.peerCache.clear();this.checkedClasses.clear();this.cacheStamp=stamp;}
  }
  constructor(readonly store:FragmentStore,readonly taskId:string,root?:FragmentRoot){
    this.root=structuredClone(root??fragmentRoot(taskId,fragmentProjectionPolicy));this.pending=emptyFragmentDelta(this.root);
    if(root){store.assertRoot(taskId,root);this.baseRoot=structuredClone(root);}else this.dirty=true;
  }
  private map<K extends FragmentRowKind>(kind:K):Map<string,FragmentRows[K]>{return (this.maps[kind]??=new Map() as never) as Map<string,FragmentRows[K]>;}
  get<K extends FragmentRowKind>(kind:K,id:string):FragmentRows[K]|undefined {const value=this.map(kind).get(id)??this.store.get(this.taskId,kind,id);return value?structuredClone(value):undefined;}
  *rows<K extends FragmentRowKind>(kind:K,where='',params:unknown[]=[],filter:(row:FragmentRows[K])=>boolean=()=>true):Generator<FragmentRows[K]> {
    const changes=this.map(kind),seen=new Set<string>();
    for(const row of this.store.rows(this.taskId,kind,where,params)){
      const updated=changes.get(row.id);if(updated){seen.add(row.id);if(filter(updated))yield structuredClone(updated);}else yield row;
    }
    // Replacing a persisted state must retain its insertion/tie order before
    // flush as well as after flush. Only newly appended records go at the end.
    for(const row of changes.values())if(!seen.has(row.id)&&filter(row))yield structuredClone(row);
  }
  put<K extends FragmentRowKind>(kind:K,value:FragmentRows[K]){
    const old=this.get(kind,value.id);if(equal(old,value))return false;
    if(old&&!['states','obligations','edges','revocations'].includes(kind))throw new ExplorerError('FRAGMENT_RECORD_CONFLICT');
    this.map(kind).set(value.id,structuredClone(value));this.root.epoch++;this.dirty=true;return true;
  }
  authority(authority:string){if(this.root.authority!==authority){this.root.authority=authority;this.root.epoch++;this.dirty=true;}}
  material(kind:FragmentMaterialKind,raw:string):string {
    const {material,atoms}=splitFragmentMaterial(kind,raw),old=this.materials.get(material.id);
    if(old&&!equal(old,material))throw new ExplorerError('FRAGMENT_MATERIAL_HASH_CONFLICT');
    // Existing objects are checked against full bytes, including on hash hits.
    if(this.store.db.prepare("SELECT 1 FROM fg_objects WHERE kind='material' AND id=?").get(material.id)){
      if(this.store.object('material',material.id).kind!==kind||this.store.material(material.id)!==raw)throw new ExplorerError('FRAGMENT_MATERIAL_HASH_CONFLICT');return material.id;
    }
    this.materials.set(material.id,material);
    for(const atom of atoms){const old=this.atoms.get(atom.id);if(old&&old.raw!==atom.raw)throw new ExplorerError('FRAGMENT_MATERIAL_HASH_CONFLICT');this.atoms.set(atom.id,atom);}
    this.dirty=true;return material.id;
  }
  raw(id:string,kind?:FragmentMaterialKind):string {const value=this.materials.get(id);if(value&&kind&&value.kind!==kind)throw new ExplorerError('CORRUPT_FRAGMENT_STORAGE');return value?readFragmentMaterial(value,id=>this.atoms.get(id)??this.store.object('atom',id)):this.store.material(id,kind);}
  candidates(fragmentId:string){return [...this.rows('candidates','fragment_id=?',[fragmentId],c=>c.fragmentId===fragmentId)].sort((a,b)=>a.position-b.position);}
  private projection(url:string,input:FragmentProjectionInput,stage=true){
    const material=(kind:FragmentMaterialKind,raw:string)=>stage?this.material(kind,raw):fragmentMaterialId(kind,raw);
    const structure=material('structure',input.structure),owner=material('owner',input.owner),candidates=input.candidates.map(c=>({path:c.path,operation:material('operation',c.operation),guard:material('guard',c.guard)}));
    const shape={url,structure,owner,revision:input.revision,candidates},lookupKey=taskDigest(JSON.stringify(shape));return {...shape,lookupKey};
  }
  find(url:string,input:FragmentProjectionInput){
    const shape=this.projection(url,input,false),matches:FragmentRecord[]=[];
    for(const f of this.rows('fragments','lookup_key=?',[shape.lookupKey],f=>f.lookupKey===shape.lookupKey)){
      const candidates=this.candidates(f.id).map(({path,operation,guard})=>({path,operation,guard}));
      if(!equal({url:f.url,structure:f.structure,owner:f.owner,revision:f.revision,candidates},{url:shape.url,structure:shape.structure,owner:shape.owner,revision:shape.revision,candidates:shape.candidates}))throw new ExplorerError('FRAGMENT_RECORD_CONFLICT');
      if(this.raw(f.structure)!==input.structure||this.raw(f.owner)!==input.owner||candidates.some((c,i)=>this.raw(c.guard)!==input.candidates[i].guard||this.raw(c.operation)!==input.candidates[i].operation))throw new ExplorerError('FRAGMENT_MATERIAL_HASH_CONFLICT');
      matches.push(f);
    }
    // An encoded/plain legacy collision must not collapse independent records.
    const f=matches.find(f=>f.id===taskDigest('fragment/v2\0'+shape.lookupKey))??(matches.length===1?matches[0]:undefined);
    if(f)return {fragment:f,candidates:this.candidates(f.id),created:false,mapped:0};
  }
  register(url:string,input:FragmentProjectionInput,source:FragmentRecord['source'],parentRegionId?:string){
    const prior=this.find(url,input);if(prior)return prior;
    const shape=this.projection(url,input),id=taskDigest('fragment/v2\0'+shape.lookupKey),fragment:FragmentRecord={id,lookupKey:shape.lookupKey,structure:shape.structure,owner:shape.owner,revision:shape.revision,url,source,...(parentRegionId?{parentRegionId}:{})};
    this.put('fragments',fragment);let mapped=0;
    const keys=shape.candidates.map(c=>JSON.stringify([this.root.policy,shape.structure,shape.owner,c.path,c.operation,c.guard]));
    const candidates=shape.candidates.map((c,position):CandidateRecord=>{
      const key=keys[position],unique=keys.filter(k=>k===key).length===1,classId=unique?taskDigest('fragment-class/v2\0'+key):undefined;
      if(classId){this.put('classes',{id:classId,key});mapped+=2*[...this.rows('candidates','class_id=?',[classId],c=>c.classId===classId)].filter(c=>!this.get('revocations',c.id)).length;}
      const value={...c,id:taskDigest(JSON.stringify([id,position,c])),fragmentId:id,position,...(classId?{classId}:{})};this.put('candidates',value);return value;
    });
    // Legacy graphs retain their exact directed topology. Only this newly
    // observed fragment gets new independently checked links to legacy members.
    for(const old of this.rows('fragments','legacy=1 AND structure_id=? AND owner_id=?',[shape.structure,shape.owner],f=>!!f.legacy&&f.structure===shape.structure&&f.owner===shape.owner)){
      if(!old.legacy)continue;const oldCandidates=this.candidates(old.id);
      for(const c of candidates){if(!c.classId||this.get('revocations',c.id))continue;
        const matches=oldCandidates.filter(a=>a.path===c.path&&a.operation===c.operation&&a.guard===c.guard);if(matches.length!==1||this.get('revocations',matches[0].id))continue;
        for(const [a,b] of [[matches[0],c],[c,matches[0]]]){this.put('edges',{id:taskDigest(JSON.stringify([a.id,b.id,'equivalent'])),sourceCandidateId:a.id,targetCandidateId:b.id,sourceFragmentId:a.fragmentId,targetFragmentId:b.fragmentId,kind:'equivalent'});mapped++;}
      }
    }
    return {fragment,candidates,created:true,mapped};
  }
  delta():FragmentDelta|undefined {
    if(!this.dirty)return;
    return {...this.pending,root:structuredClone(this.root),atoms:[...this.atoms.values()],materials:[...this.materials.values()],...Object.fromEntries(fragmentRowKinds.map(kind=>[kind,[...this.map(kind).values()]]))} as FragmentDelta;
  }
  committed(){this.maps={};this.atoms.clear();this.materials.clear();this.pending=emptyFragmentDelta(this.root);this.baseRoot=structuredClone(this.root);this.dirty=false;this.store.invalidate();}
  /** SQL walks candidate/class nodes, not an expanded pairwise clique. Events
   * are unique origins. Duplicate-only reachability is counted independently. */
  private graph(){
    if(!equal(this.store.root(this.taskId),this.baseRoot))throw new ExplorerError('STALE_TASK_VERSION');
    const params:unknown[]=[];
    const table=(kind:'candidates'|'edges'|'events'|'revocations')=>{const rows=[...this.map(kind).values()];params.push(this.taskId,JSON.stringify(rows));return `${kind}_all AS (SELECT json FROM fg_${kind}${kind==='candidates'?'_read':''} WHERE task_id=? AND fg_valid(json,hash) AND id NOT IN(SELECT json_extract(value,'$.id') FROM json_each(?)) UNION ALL SELECT value FROM json_each(?))`;};
    // The same JSON is bound twice so mutable revocations/edges shadow their
    // committed rows without copying any untouched history into JavaScript.
    const ctes=(['candidates','edges','events','revocations'] as const).map(kind=>{const cte=table(kind);params.push(params.at(-1));return cte;});
    return {params,sql:`WITH RECURSIVE ${ctes.join(',')},
      c AS (SELECT json_extract(json,'$.id') id,json_extract(json,'$.fragmentId') fragment,json_extract(json,'$.classId') class FROM candidates_all),
      r AS (SELECT json_extract(json,'$.id') id FROM revocations_all),
      links(source,target,dup) AS (
        SELECT 'c:'||id,'g:'||class,0 FROM c WHERE class IS NOT NULL AND id NOT IN(SELECT id FROM r)
        UNION ALL SELECT 'g:'||class,'c:'||id,0 FROM c WHERE class IS NOT NULL AND id NOT IN(SELECT id FROM r)
        UNION ALL SELECT 'c:'||json_extract(json,'$.sourceCandidateId'),'c:'||json_extract(json,'$.targetCandidateId'),json_extract(json,'$.kind')='duplicate' FROM edges_all
          WHERE json_type(json,'$.revoked') IS NULL AND json_extract(json,'$.sourceCandidateId') NOT IN(SELECT id FROM r) AND json_extract(json,'$.targetCandidateId') NOT IN(SELECT id FROM r)
      )`};
  }
  private legacyEdges(){return this.map('edges').size>0||!!this.store.db.prepare('SELECT 1 FROM fg_edges WHERE task_id=? LIMIT 1').get(this.taskId);}
  private directClassQuery(candidateId:string){
    if(!equal(this.store.root(this.taskId),this.baseRoot))throw new ExplorerError('STALE_TASK_VERSION');
    const candidate=this.get('candidates',candidateId),classId=candidate?.classId??null;
    const candidates=JSON.stringify([...this.map('candidates').values()]),revocations=JSON.stringify([...this.map('revocations').values()]),events=JSON.stringify([...this.map('events').values()]);
    return {params:[this.taskId,revocations,candidateId,this.taskId,classId,candidates,candidateId,candidates,classId,candidateId,this.taskId,events,candidateId,candidateId],sql:`WITH
      r(id) AS (SELECT id FROM fg_revocations WHERE task_id=? AND fg_valid(json,hash) UNION SELECT json_extract(value,'$.id') FROM json_each(?)),
      members(id) AS (SELECT ? UNION SELECT id FROM fg_candidates_read WHERE task_id=? AND class_id=? AND fg_valid(json,hash)
        AND id NOT IN(SELECT json_extract(value,'$.id') FROM json_each(?)) AND id NOT IN(SELECT id FROM r) AND ? NOT IN(SELECT id FROM r)
        UNION SELECT json_extract(value,'$.id') FROM json_each(?) WHERE json_extract(value,'$.classId')=? AND json_extract(value,'$.id') NOT IN(SELECT id FROM r) AND ? NOT IN(SELECT id FROM r)),
      event_rows(json) AS (SELECT json FROM fg_events WHERE task_id=? AND candidate_id IN(SELECT id FROM members) AND fg_valid(json,hash)
        UNION ALL SELECT value FROM json_each(?) WHERE json_extract(value,'$.candidateId') IN(SELECT id FROM members)),
      origins AS (SELECT json,json_extract(json,'$.id') id,json_extract(json,'$.candidateId')=? direct,json_extract(json,'$.candidateId')=? duplicate FROM event_rows)`};
  }
  private accessQuery(candidateId:string){if(!this.legacyEdges())return this.directClassQuery(candidateId);const graph=this.graph();return {params:[...graph.params,candidateId,candidateId,candidateId],sql:`${graph.sql},
    walk(node,dup) AS (SELECT 'c:'||?,0 UNION SELECT 'c:'||?,1 UNION SELECT links.source,walk.dup FROM walk JOIN links ON links.target=walk.node WHERE walk.dup=0 OR links.dup=1),
    origins AS (SELECT json,json_extract(json,'$.id') id,json_extract(json,'$.candidateId')=? direct,
      EXISTS(SELECT 1 FROM walk WHERE node='c:'||json_extract(json,'$.candidateId') AND dup=1) duplicate FROM events_all
      WHERE EXISTS(SELECT 1 FROM walk WHERE node='c:'||json_extract(json,'$.candidateId') AND dup=0))`};}
  private validateCandidate(c:CandidateRecord){
    const f=this.get('fragments',c.fragmentId);if(!f)throw new ExplorerError('CORRUPT_FRAGMENT_STORAGE');
    this.raw(f.structure,'structure');this.raw(f.owner,'owner');this.raw(c.operation,'operation');this.raw(c.guard,'guard');
    if(c.classId){const key=JSON.stringify([this.root.policy,f.structure,f.owner,c.path,c.operation,c.guard]);if(this.get('classes',c.classId)?.key!==key||taskDigest('fragment-class/v2\0'+key)!==c.classId)throw new ExplorerError('CORRUPT_FRAGMENT_STORAGE');}
  }
  counts(candidateId:string):FragmentCounters {return this.snapshot(()=>this.countsSnapshot(candidateId));}
  private countsSnapshot(candidateId:string):FragmentCounters {
    this.checkSnapshot();const cached=this.countCache.get(candidateId);if(cached)return {...cached};
    const c=this.get('candidates',candidateId);if(!c)throw new ExplorerError('FRAGMENT_CANDIDATE_NOT_FOUND');this.validateCandidate(c);
    if(c.classId&&!this.checkedClasses.has(c.classId)){
      for(const member of this.rows('candidates','class_id=?',[c.classId],row=>row.classId===c.classId))this.validateCandidate(member);
      if(this.checkedClasses.size>=2048)this.checkedClasses.clear();this.checkedClasses.add(c.classId);
    }
    const q=this.accessQuery(candidateId),row=this.store.db.prepare(`${q.sql} SELECT COALESCE(MAX(direct),0) direct,COALESCE(SUM(duplicate),0) duplicate,COUNT(*) equivalent FROM origins`).get(...q.params) as {direct:number;duplicate:number;equivalent:number};
    if(this.legacyEdges())for(const row of this.store.db.prepare(`${q.sql} SELECT DISTINCT substr(node,3) id FROM walk WHERE node LIKE 'c:%'`).all(...q.params) as {id:string}[]){const source=this.get('candidates',row.id);if(!source)throw new ExplorerError('CORRUPT_FRAGMENT_STORAGE');this.validateCandidate(source);}
    const result={...row,direct:!!row.direct};if(this.countCache.size>=2048)this.countCache.delete(this.countCache.keys().next().value!);this.countCache.set(candidateId,result);return {...result};
  }
  origins(candidateId:string,after='',limit=128){
    if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new ExplorerError('INVALID_FRAGMENT_PAGE');
    return this.snapshot(()=>{this.countsSnapshot(candidateId);const q=this.accessQuery(candidateId);return (this.store.db.prepare(`${q.sql} SELECT json,direct,duplicate FROM origins WHERE id>? ORDER BY id LIMIT ?`).all(...q.params,after,limit) as {json:string;direct:number;duplicate:number}[]).map(row=>({event:JSON.parse(row.json) as FragmentRows['events'],direct:!!row.direct,duplicate:!!row.duplicate}));});
  }
  peers(fragmentId:string):number {return this.snapshot(()=>{this.checkSnapshot();const old=this.peerCache.get(fragmentId);if(old!==undefined)return old;const value=this.peersSnapshot(fragmentId);if(this.peerCache.size>=2048)this.peerCache.delete(this.peerCache.keys().next().value!);this.peerCache.set(fragmentId,value);return value;});}
  private peersSnapshot(fragmentId:string):number {
    if(!this.legacyEdges()){
      const revoked=(id:string)=>!!this.get('revocations',id),classes=new Set(this.candidates(fragmentId).filter(c=>c.classId&&!revoked(c.id)).map(c=>c.classId!)),peers=new Set<string>();
      // Indexed lookup visits members of this fragment's classes only.
      for(const cls of classes)for(const c of this.rows('candidates','class_id=?',[cls],c=>c.classId===cls))if(c.fragmentId!==fragmentId&&!revoked(c.id))peers.add(c.fragmentId);
      return peers.size;
    }
    const graph=this.graph();const row=this.store.db.prepare(`${graph.sql},peers(id) AS (
      SELECT b.fragment FROM c a JOIN c b ON a.class=b.class WHERE a.fragment=? AND b.fragment<>a.fragment AND a.id NOT IN(SELECT id FROM r) AND b.id NOT IN(SELECT id FROM r)
      UNION SELECT json_extract(json,'$.targetFragmentId') FROM edges_all WHERE json_extract(json,'$.sourceFragmentId')=? AND json_type(json,'$.revoked') IS NULL AND json_extract(json,'$.sourceCandidateId') NOT IN(SELECT id FROM r) AND json_extract(json,'$.targetCandidateId') NOT IN(SELECT id FROM r)) SELECT COUNT(*) n FROM peers`).get(...graph.params,fragmentId,fragmentId) as {n:number};return row.n;
  }
  importLegacy(ledger:FragmentTraversalLedger){
    if(this.store.root(this.taskId)||this.materials.size||this.map('fragments').size)throw new ExplorerError('INVALID_FRAGMENT_MIGRATION');
    if(!['guarded-host-fragments/v1',fragmentProjectionPolicy].includes(ledger.policy))throw new ExplorerError('FRAGMENT_POLICY_MISMATCH');
    for(const old of ledger.fragments){
      const shape=this.projection(old.url,{...old,owner:decodeFragmentMaterial(old.owner),candidates:old.candidates.map(c=>({...c,guard:decodeFragmentMaterial(c.guard)}))});
      this.put('fragments',{id:old.id,lookupKey:shape.lookupKey,structure:shape.structure,owner:shape.owner,revision:old.revision,url:old.url,source:old.source,...(old.parentRegionId?{parentRegionId:old.parentRegionId}:{}),legacy:{ownerEncoded:old.owner.startsWith('deflate-raw/base64-v1:')}});
      old.candidates.forEach((c,position)=>this.put('candidates',{id:c.id,fragmentId:old.id,position,...shape.candidates[position],legacy:{guardEncoded:c.guard.startsWith('deflate-raw/base64-v1:')}}));
    }
    ledger.mappings.forEach((edge,index)=>this.put('edges',{...edge,id:`legacy:${index}`}));
    for(const event of ledger.events){if(this.get('events',event.id))throw new ExplorerError('DUPLICATE_FRAGMENT_ORIGIN');this.put('events',event);}
    for(const [id,reason] of Object.entries(ledger.revokedCandidates))this.put('revocations',{id,reason});
    for(const state of ledger.states)this.put('states',state);
    for(const [id,ref] of Object.entries(ledger.obligations))this.put('obligations',{id,...ref});
    this.root={storageVersion:2,rootKey:this.taskId,policy:ledger.policy,epoch:ledger.epoch,...(ledger.authority?{authority:ledger.authority}:{}),...(ledger.bounded?{legacyBounded:true as const}:{})};this.dirty=true;
  }
  /** Explicit full audit export. Normal task/state reads use only FragmentRoot. */
  exportLegacy():FragmentTraversalLedger {
    const fragments=[...this.rows('fragments')].map(f=>({...f,structure:this.raw(f.structure),owner:f.legacy?.ownerEncoded?encodeFragmentMaterial(this.raw(f.owner)):this.raw(f.owner),candidates:this.candidates(f.id).map(c=>{
      const direct:string[]=[],duplicate:string[]=[],equivalent:string[]=[];let after='';for(;;){const page=this.origins(c.id,after);for(const row of page){(row.direct?direct:row.duplicate?duplicate:equivalent).push(row.event.id);after=row.event.id;}if(page.length<128)break;}
      return {id:c.id,path:c.path,operation:this.raw(c.operation),guard:c.legacy?.guardEncoded?encodeFragmentMaterial(this.raw(c.guard)):this.raw(c.guard),access:{direct,duplicate,equivalent}};
    })}));
    const mappings=[...this.rows('edges')].map(({id,...edge})=>edge);
    for(const cls of this.rows('classes')){const members=[...this.rows('candidates','class_id=?',[cls.id],c=>c.classId===cls.id)];for(const a of members)for(const b of members)if(a.id!==b.id)mappings.push({sourceFragmentId:a.fragmentId,targetFragmentId:b.fragmentId,sourceCandidateId:a.id,targetCandidateId:b.id,kind:'equivalent'});}
    return {policy:this.root.policy,epoch:this.root.epoch,authority:this.root.authority,...(this.root.legacyBounded?{bounded:true as const}:{}),fragments:fragments.map(({lookupKey,legacy,...f})=>f),mappings,events:[...this.rows('events')],states:[...this.rows('states')],obligations:Object.fromEntries([...this.rows('obligations')].map(({id,...o})=>[id,o])),revokedCandidates:Object.fromEntries([...this.rows('revocations')].map(r=>[r.id,r.reason]))};
  }
}
