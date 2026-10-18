import type Database from 'better-sqlite3';
import {ExplorerError} from './types.js';
import {packTaskRecords,unpackTaskRecords,taskDigest,TASK_BLOCK_BYTES,TASK_BLOCK_ITEMS,type PackedTaskValue} from './task-codec.js';
import {readFragmentMaterial,type FragmentAtom,type FragmentMaterial,type FragmentMaterialKind} from './fragment-codec.js';
import {fragmentRowKinds,type FragmentDelta,type FragmentRoot,type FragmentRows,type FragmentRowKind} from './fragment-records.js';

const corrupt=():never=>{throw new ExplorerError('CORRUPT_FRAGMENT_STORAGE');};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
type ObjectRecord={kind:'atom'|'material';id:string;value:FragmentAtom|FragmentMaterial};
const packedKinds=new Set<FragmentRowKind>(['fragments','candidates']);
const projection=(kind:FragmentRowKind,value:FragmentRows[FragmentRowKind]):Record<string,string|number|null>=>{
  if(kind==='fragments'){const f=value as FragmentRows['fragments'];return {id:f.id,lookup_key:f.lookupKey,structure_id:f.structure,owner_id:f.owner,legacy:Number(!!f.legacy)};}
  const c=value as FragmentRows['candidates'];return {id:c.id,fragment_id:c.fragmentId,class_id:c.classId??null,position:c.position,operation_id:c.operation,guard_id:c.guard};
};
const columns:Record<FragmentRowKind,string>={
  fragments:"lookup_key TEXT NOT NULL,structure_id TEXT NOT NULL,owner_id TEXT NOT NULL,legacy INTEGER NOT NULL CHECK(legacy IN(0,1)),material_kind TEXT NOT NULL DEFAULT 'material' CHECK(material_kind='material'),",
  classes:"class_key TEXT GENERATED ALWAYS AS(json_extract(json,'$.key')) VIRTUAL,",
  candidates:"fragment_id TEXT NOT NULL,class_id TEXT,position INTEGER NOT NULL,operation_id TEXT NOT NULL,guard_id TEXT NOT NULL,material_kind TEXT NOT NULL DEFAULT 'material' CHECK(material_kind='material'),",
  events:"candidate_id TEXT GENERATED ALWAYS AS(json_extract(json,'$.candidateId')) STORED,fragment_id TEXT GENERATED ALWAYS AS(json_extract(json,'$.fragmentId')) STORED,",
  edges:"source_id TEXT GENERATED ALWAYS AS(json_extract(json,'$.sourceCandidateId')) STORED,target_id TEXT GENERATED ALWAYS AS(json_extract(json,'$.targetCandidateId')) STORED,relation TEXT GENERATED ALWAYS AS(json_extract(json,'$.kind')) STORED,revoked INTEGER GENERATED ALWAYS AS(json_type(json,'$.revoked') IS NOT NULL) STORED,",
  revocations:'',states:'',obligations:''
};
const references:Partial<Record<FragmentRowKind,string>>={
  fragments:',FOREIGN KEY(material_kind,structure_id) REFERENCES fg_objects(kind,id),FOREIGN KEY(material_kind,owner_id) REFERENCES fg_objects(kind,id)',
  candidates:',FOREIGN KEY(material_kind,operation_id) REFERENCES fg_objects(kind,id),FOREIGN KEY(material_kind,guard_id) REFERENCES fg_objects(kind,id),FOREIGN KEY(task_id,fragment_id) REFERENCES fg_fragments(task_id,id),FOREIGN KEY(task_id,class_id) REFERENCES fg_classes(task_id,id),UNIQUE(task_id,fragment_id,position),UNIQUE(task_id,class_id,fragment_id),UNIQUE(task_id,id,fragment_id)',
  events:',FOREIGN KEY(task_id,candidate_id,fragment_id) REFERENCES fg_candidates(task_id,id,fragment_id)',
  edges:',FOREIGN KEY(task_id,source_id) REFERENCES fg_candidates(task_id,id),FOREIGN KEY(task_id,target_id) REFERENCES fg_candidates(task_id,id)',
  revocations:',FOREIGN KEY(task_id,id) REFERENCES fg_candidates(task_id,id)'
};

/** Same connection as ExplorerStore. Only apply() writes durable graph data and
 * it requires the caller's task CAS transaction. Caches are disposable bytes,
 * never the authority for membership, provenance or coverage. */
export class FragmentStore {
  private cache=new Map<string,{value:unknown;bytes:number}>();private cacheBytes=0;private stamp='';
  private writing=false;private callback=false;
  constructor(readonly db:Database.Database,readonly cacheLimit=8*1024*1024) {
    db.function('fg_valid',{deterministic:true},(json:unknown,hash:unknown)=>{if(typeof json!=='string'||taskDigest(json)!==hash)corrupt();return 1;});
    db.function('fg_payload_json',(kind:unknown,pack:unknown,slot:unknown,hash:unknown,projected:unknown,data:unknown,packHash:unknown,rawSize:unknown)=>{
      if(typeof kind!=='string'||!packedKinds.has(kind as FragmentRowKind)||typeof pack!=='number'||typeof slot!=='number'||typeof projected!=='string'||!Buffer.isBuffer(data)||typeof packHash!=='string'||typeof rawSize!=='number')return corrupt();
      this.callback=true;try{
        if(taskDigest(data)!==packHash)return corrupt();
        const rows=this.cached(`pack:${pack}:${packHash}:${rawSize}`,()=>unpackTaskRecords<unknown[]>({data,content_hash:packHash,raw_size:rawSize}),false);
        const row=rows[slot] as {kind:FragmentRowKind;id:string;value:FragmentRows[FragmentRowKind]}|undefined;
        if(!row||row.kind!==kind||taskDigest(JSON.stringify(row.value))!==hash||JSON.stringify(projection(kind as FragmentRowKind,row.value))!==projected)return corrupt();
        return JSON.stringify(row.value);
      }finally{this.callback=false;}
    });
    db.exec(`CREATE TABLE IF NOT EXISTS fg_roots(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,json TEXT NOT NULL,hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fg_packs(id INTEGER PRIMARY KEY,content_hash TEXT NOT NULL UNIQUE,raw_size INTEGER NOT NULL,data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS fg_objects(kind TEXT NOT NULL,id TEXT NOT NULL,pack_id INTEGER NOT NULL REFERENCES fg_packs(id),slot INTEGER NOT NULL,PRIMARY KEY(kind,id));`);
    for(const kind of fragmentRowKinds){
      const packed=packedKinds.has(kind);
      db.exec(`CREATE TABLE IF NOT EXISTS fg_${kind}(seq INTEGER PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,id TEXT NOT NULL,${packed?'pack_id INTEGER NOT NULL REFERENCES fg_packs(id),slot INTEGER NOT NULL,':'json TEXT NOT NULL,'}hash TEXT NOT NULL,${columns[kind]}UNIQUE(task_id,id)${packed?'':",CHECK(id=json_extract(json,'$.id'))"}${references[kind]||''});`);
      if(packed){const keys=kind==='fragments'?['id','lookup_key','structure_id','owner_id','legacy']:['id','fragment_id','class_id','position','operation_id','guard_id'];
        db.exec(`CREATE VIEW IF NOT EXISTS fg_${kind}_read AS SELECT r.*,fg_payload_json('${kind}',r.pack_id,r.slot,r.hash,json_object(${keys.map(key=>`'${key}',r.${key}`).join(',')}),p.data,p.content_hash,p.raw_size) AS json FROM fg_${kind} r JOIN fg_packs p ON p.id=r.pack_id;`);}
    }
    db.exec(`CREATE INDEX IF NOT EXISTS fg_fragment_lookup ON fg_fragments(task_id,lookup_key);
      CREATE INDEX IF NOT EXISTS fg_fragment_legacy_match ON fg_fragments(task_id,structure_id,owner_id) WHERE legacy=1;
      CREATE INDEX IF NOT EXISTS fg_event_origin ON fg_events(task_id,candidate_id);
      CREATE INDEX IF NOT EXISTS fg_edge_target ON fg_edges(task_id,target_id);
      CREATE INDEX IF NOT EXISTS fg_edge_source ON fg_edges(task_id,source_id);
      CREATE TABLE IF NOT EXISTS fg_state_candidates(task_id TEXT NOT NULL,state_id TEXT NOT NULL,candidate_id TEXT NOT NULL,position INTEGER NOT NULL,
        PRIMARY KEY(task_id,state_id,position),FOREIGN KEY(task_id,state_id) REFERENCES fg_states(task_id,id),FOREIGN KEY(task_id,candidate_id) REFERENCES fg_candidates(task_id,id));
      CREATE TABLE IF NOT EXISTS fg_obligation_candidates(task_id TEXT NOT NULL,obligation_id TEXT NOT NULL,candidate_id TEXT NOT NULL,position INTEGER NOT NULL,
        PRIMARY KEY(task_id,obligation_id,position),FOREIGN KEY(task_id,obligation_id) REFERENCES fg_obligations(task_id,id),FOREIGN KEY(task_id,candidate_id) REFERENCES fg_candidates(task_id,id));`);
  }
  invalidate(){this.cache.clear();this.cacheBytes=0;this.stamp='';}
  private checkCache(){
    if(this.writing||this.callback)return;
    const row=this.db.prepare('SELECT total_changes() AS changes').get() as {changes:number};
    const stamp=[row.changes,this.db.pragma('data_version',{simple:true}),this.db.pragma('schema_version',{simple:true})].join(':');
    if(stamp!==this.stamp){this.cache.clear();this.cacheBytes=0;this.stamp=stamp;}
  }
  private cached<T>(key:string,read:()=>T,copy=true):T {
    this.checkCache();const old=this.cache.get(key);if(old){this.cache.delete(key);this.cache.set(key,old);return (copy?structuredClone(old.value):old.value) as T;}
    const value=read(),bytes=Buffer.byteLength(JSON.stringify(value));
    if(bytes<=this.cacheLimit){while(this.cache.size>=2048||this.cacheBytes+bytes>this.cacheLimit){const first=this.cache.keys().next().value!;this.cacheBytes-=this.cache.get(first)!.bytes;this.cache.delete(first);}this.cache.set(key,{value:structuredClone(value),bytes});this.cacheBytes+=bytes;}
    return value;
  }
  private pack(id:number):unknown[]{return this.cached(`pack:${id}`,()=>{const row=this.db.prepare('SELECT * FROM fg_packs WHERE id=?').get(id) as PackedTaskValue|undefined;if(!row)return corrupt();return unpackTaskRecords<unknown[]>(row);},false);}
  cacheStats(){return {entries:this.cache.size,bytes:this.cacheBytes,limit:this.cacheLimit};}
  root(taskId:string):FragmentRoot|undefined {
    const row=this.db.prepare('SELECT json,hash FROM fg_roots WHERE task_id=?').get(taskId) as {json:string;hash:string}|undefined;
    if(!row)return;const value=this.decode<FragmentRoot>(row);if(value.storageVersion!==2||value.rootKey!==taskId)corrupt();return value;
  }
  assertRoot(taskId:string,root:FragmentRoot|undefined){const stored=this.root(taskId);if(!same(stored,root))corrupt();}
  private decode<T>(row:{json:string;hash:string}):T {if(taskDigest(row.json)!==row.hash)corrupt();try{return JSON.parse(row.json) as T;}catch{return corrupt();}}
  get<K extends FragmentRowKind>(taskId:string,kind:K,id:string):FragmentRows[K]|undefined {
    this.checkCache();
    const row=this.db.prepare(`SELECT json,hash FROM fg_${kind}${packedKinds.has(kind)?'_read':''} WHERE task_id=? AND id=?`).get(taskId,id) as {json:string;hash:string}|undefined;
    return row?this.decode(row):undefined;
  }
  *rows<K extends FragmentRowKind>(taskId:string,kind:K,where='',params:unknown[]=[]):Generator<FragmentRows[K]> {
    // Each page releases SQLite's cursor before the caller stages or writes.
    let after=0;for(;;){this.checkCache();const rows=this.db.prepare(`SELECT seq,json,hash FROM fg_${kind}${packedKinds.has(kind)?'_read':''} WHERE task_id=? AND seq>? ${where?'AND '+where:''} ORDER BY seq LIMIT 128`).all(taskId,after,...params) as {seq:number;json:string;hash:string}[];
      for(const row of rows){after=row.seq;yield this.decode<FragmentRows[K]>(row);}if(rows.length<128)return;}
  }
  object(kind:'atom',id:string):FragmentAtom;
  object(kind:'material',id:string):FragmentMaterial;
  object(kind:'atom'|'material',id:string):FragmentAtom|FragmentMaterial {
    return this.cached(`${kind}:${id}`,()=>{
      const ref=this.db.prepare('SELECT pack_id,slot FROM fg_objects WHERE kind=? AND id=?').get(kind,id) as {pack_id:number;slot:number}|undefined;if(!ref)return corrupt();
      const row=(this.pack(ref.pack_id) as ObjectRecord[])[ref.slot];
      if(!row||row.id!==id||row.kind!==kind||row.value.id!==id)return corrupt();return row.value;
    });
  }
  material(id:string,kind?:FragmentMaterialKind):string {if(kind&&this.object('material',id).kind!==kind)return corrupt();return this.cached(`raw:${id}`,()=>readFragmentMaterial(this.object('material',id),id=>this.object('atom',id)));}
  changeToken(){this.checkCache();return this.stamp;}
  private recordPacks(taskId:string,delta:FragmentDelta){
    const refs=new Map<string,{pack:number;slot:number}>();let batch:{kind:FragmentRowKind;id:string;value:FragmentRows[FragmentRowKind]}[]=[],bytes=0;
    const flush=()=>{if(!batch.length)return;const packed=packTaskRecords(batch);this.db.prepare('INSERT OR IGNORE INTO fg_packs(content_hash,raw_size,data) VALUES(?,?,?)').run(packed.content_hash,packed.raw_size,packed.data);
      const pack=(this.db.prepare('SELECT id FROM fg_packs WHERE content_hash=?').get(packed.content_hash) as {id:number}).id;
      batch.forEach((row,slot)=>refs.set(`${row.kind}:${row.id}`,{pack,slot}));batch=[];bytes=0;};
    for(const kind of packedKinds)for(const value of delta[kind])if(!this.get(taskId,kind,value.id)){
      const row={kind,id:value.id,value},size=Buffer.byteLength(JSON.stringify(row));if(batch.length&&(batch.length>=TASK_BLOCK_ITEMS||bytes+size>TASK_BLOCK_BYTES))flush();batch.push(row);bytes+=size;
    }
    flush();return refs;
  }
  private objects(delta:FragmentDelta){
    const next:ObjectRecord[]=[];
    for(const [kind,values] of [['atom',delta.atoms],['material',delta.materials]] as const)for(const value of values){
      const old=this.db.prepare('SELECT 1 FROM fg_objects WHERE kind=? AND id=?').get(kind,value.id);
      if(old){const prior=kind==='atom'?this.object('atom',value.id):this.object('material',value.id);if(!same(prior,value))throw new ExplorerError('FRAGMENT_MATERIAL_HASH_CONFLICT');}
      else next.push({kind,id:value.id,value});
    }
    let batch:ObjectRecord[]=[],bytes=0;
    const flush=()=>{if(!batch.length)return;const packed=packTaskRecords(batch);this.db.prepare('INSERT OR IGNORE INTO fg_packs(content_hash,raw_size,data) VALUES(?,?,?)').run(packed.content_hash,packed.raw_size,packed.data);
      const pack=this.db.prepare('SELECT id FROM fg_packs WHERE content_hash=?').get(packed.content_hash) as {id:number};
      batch.forEach((row,slot)=>this.db.prepare('INSERT INTO fg_objects VALUES(?,?,?,?)').run(row.kind,row.id,pack.id,slot));batch=[];bytes=0;};
    for(const row of next){const size=Buffer.byteLength(JSON.stringify(row));if(batch.length&&(batch.length>=TASK_BLOCK_ITEMS||bytes+size>TASK_BLOCK_BYTES))flush();batch.push(row);bytes+=size;}flush();
    // Validate addresses against full bytes before exposing any root. This also
    // catches missing atoms and forged lengths; rollback discards every row.
    for(const value of delta.materials)this.material(value.id);
  }
  apply(taskId:string,delta:FragmentDelta) {
    if(!this.db.inTransaction||delta.root.rootKey!==taskId||delta.root.storageVersion!==2)throw new ExplorerError('INVALID_FRAGMENT_DELTA');
    this.invalidate();this.writing=true;try {
      this.objects(delta);
      const packed=this.recordPacks(taskId,delta);
      for(const kind of fragmentRowKinds)for(const value of delta[kind]){
        const old=this.get(taskId,kind,value.id),json=JSON.stringify(value);
        if(old&&same(old,value))continue;
        if(old&&!['states','obligations','edges','revocations'].includes(kind))throw new ExplorerError('FRAGMENT_RECORD_CONFLICT');
        if(kind==='fragments'){const f=value as FragmentRows['fragments'];this.material(f.structure,'structure');this.material(f.owner,'owner');}
        if(kind==='candidates'){
          const c=value as FragmentRows['candidates'];this.material(c.operation,'operation');this.material(c.guard,'guard');
          if(c.context!==undefined)this.material(c.context,'context');
          if(c.classId){const cls=this.get(taskId,'classes',c.classId),f=this.get(taskId,'fragments',c.fragmentId);
            const key=JSON.stringify([delta.root.policy,f?.structure,f?.owner,c.path,c.operation,c.guard]);
            if(!f||cls?.key!==key||taskDigest('fragment-class/v2\0'+key)!==c.classId)corrupt();}
        }
        if(kind==='events'){const e=value as FragmentRows['events'];if(e.effect!==undefined)this.material(e.effect,'effect');}
        if(kind==='edges'){
          const e=value as FragmentRows['edges'],a=this.get(taskId,'candidates',e.sourceCandidateId),b=this.get(taskId,'candidates',e.targetCandidateId);
          if(!a||!b||a.fragmentId!==e.sourceFragmentId||b.fragmentId!==e.targetFragmentId||!['duplicate','equivalent'].includes(e.kind))corrupt();
          // Revoking an edge may change its reason, never its endpoints/kind.
          if(old){const {revoked:_a,...a}=old as FragmentRows['edges'],{revoked:_b,...b}=e;if(!same(a,b))throw new ExplorerError('FRAGMENT_RECORD_CONFLICT');}
        }
        if(packedKinds.has(kind)){
          const ref=packed.get(`${kind}:${value.id}`);if(!ref)return corrupt();const fields=projection(kind,value),keys=Object.keys(fields);
          this.db.prepare(`INSERT INTO fg_${kind}(task_id,pack_id,slot,hash,${keys.join(',')}) VALUES(?,?,?,?,${keys.map(()=>'?').join(',')})`).run(taskId,ref.pack,ref.slot,taskDigest(json),...Object.values(fields));
        }else this.db.prepare(`INSERT INTO fg_${kind}(task_id,id,json,hash) VALUES(?,?,?,?) ON CONFLICT(task_id,id) DO UPDATE SET json=excluded.json,hash=excluded.hash`).run(taskId,value.id,json,taskDigest(json));
        if(kind==='states'||kind==='obligations'){
          const table=kind==='states'?'fg_state_candidates':'fg_obligation_candidates',key=kind==='states'?'state_id':'obligation_id';
          this.db.prepare(`DELETE FROM ${table} WHERE task_id=? AND ${key}=?`).run(taskId,value.id);
          (value as FragmentRows['states']|FragmentRows['obligations']).candidateIds.forEach((id,position)=>this.db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?)`).run(taskId,value.id,id,position));
        }
      }
      const json=JSON.stringify(delta.root);this.db.prepare('INSERT INTO fg_roots VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET json=excluded.json,hash=excluded.hash').run(taskId,json,taskDigest(json));
    } finally {this.writing=false;this.invalidate();}
  }
  /** Explicit maintenance; ordinary task reads never materialize the graph. */
  verify(taskId:string){
    for(const kind of fragmentRowKinds)for(const row of this.rows(taskId,kind)){
      if(kind==='fragments'){const f=row as FragmentRows['fragments'];this.material(f.structure,'structure');this.material(f.owner,'owner');}
      if(kind==='candidates'){const c=row as FragmentRows['candidates'];this.material(c.operation,'operation');this.material(c.guard,'guard');if(c.context!==undefined)this.material(c.context,'context');}
      if(kind==='events'){const e=row as FragmentRows['events'];if(e.effect!==undefined)this.material(e.effect,'effect');}
    }
    if((this.db.pragma('foreign_key_check') as unknown[]).length)corrupt();return this.stats(taskId);
  }
  stats(taskId:string){return Object.fromEntries(fragmentRowKinds.map(kind=>[kind,(this.db.prepare(`SELECT COUNT(*) AS n FROM fg_${kind} WHERE task_id=?`).get(taskId) as {n:number}).n]));}
  /** Explicit reachability maintenance. It removes only unreferenced material
   * objects/packs; no candidate, state, obligation or origin event is evicted. */
  compact(){
    if(this.db.inTransaction)throw new ExplorerError('STORAGE_BUSY');
    try{return this.db.transaction(()=>{
      const tasks=this.db.prepare('SELECT task_id FROM fg_roots').all() as {task_id:string}[];for(const task of tasks)this.verify(task.task_id);
      const materialIds=new Set((this.db.prepare('SELECT structure_id id FROM fg_fragments UNION SELECT owner_id FROM fg_fragments UNION SELECT operation_id FROM fg_candidates UNION SELECT guard_id FROM fg_candidates').all() as {id:string}[]).map(row=>row.id));
      for(const task of tasks){
        for(const c of this.rows(task.task_id,'candidates'))if(c.context!==undefined)materialIds.add(c.context);
        for(const e of this.rows(task.task_id,'events'))if(e.effect!==undefined)materialIds.add(e.effect);
      }
      const atoms=new Set<string>();for(const id of materialIds)for(const piece of this.object('material',id).layout)if(piece[0]===1)atoms.add(piece[1]);
      const removedObjects:{kind:string;id:string}[]=[];for(const row of this.db.prepare('SELECT kind,id FROM fg_objects').all() as {kind:string;id:string}[])if(!(row.kind==='material'?materialIds:atoms).has(row.id))removedObjects.push(row);
      for(const row of removedObjects)this.db.prepare('DELETE FROM fg_objects WHERE kind=? AND id=?').run(row.kind,row.id);
      const removedPacks=this.db.prepare('SELECT id,content_hash FROM fg_packs WHERE id NOT IN(SELECT pack_id FROM fg_objects UNION SELECT pack_id FROM fg_fragments UNION SELECT pack_id FROM fg_candidates)').all() as {id:number;content_hash:string}[];
      for(const row of removedPacks)this.db.prepare('DELETE FROM fg_packs WHERE id=?').run(row.id);
      if((this.db.pragma('foreign_key_check') as unknown[]).length)corrupt();return {removedObjects,removedPacks,retainedDurableEvidence:true};
    }).immediate();}finally{this.invalidate();}
  }
}
