import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
const ROOT='/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine';
const out=join(ROOT,'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-8/collection-diagnosis.json');
if(existsSync(out))throw Error('Refuse overwrite');
const dbPath='/private/var/folders/s9/dy_jbdrs3fn1qzt_gnsy4tgw0000gn/T/bie-run8-receipt-audit-5a3n2u5m/engine/engine.sqlite';
const evidenceDir=join(ROOT,'.data/okx-storage-acceptance-20261017-v1/engine/evidence');
const sha=b=>createHash('sha256').update(b).digest('hex');
const file=path=>({path,bytes:readFileSync(path).length,sha256:sha(readFileSync(path))});
const beforeDb=file(dbPath);
const auditFile=join(ROOT,'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-8/receipt-audit.json');
const audit=JSON.parse(readFileSync(auditFile));
const receipts=audit.receipts.filter(r=>r.originalStatus==='succeeded'&&r.classification.exploration);
const Database=createRequire(join(ROOT,'packages/storage-sqlite/package.json'))('better-sqlite3');
const {ObservationObjectStore}=await import(pathToFileURL(join(ROOT,'packages/storage-sqlite/src/observation-store.ts')));
const {decodeStoredEntity}=await import(pathToFileURL(join(ROOT,'packages/storage-sqlite/src/entity-codec.ts')));
const db=new Database(dbPath,{readonly:true,fileMustExist:true});
const touched=new Map(), sourceFiles=['packages/adapter-playwright/src/owner-dependencies.ts','packages/adapter-playwright/src/browser.ts','packages/browser/src/document-coverage.ts','packages/core/src/engine.ts'];
const readOriginal=path=>{const b=readFileSync(path),old=touched.get(path);if(old&&old!==sha(b))throw Error('Evidence changed');touched.set(path,sha(b));return b;};
const narrowAttrs=attrs=>Object.fromEntries(Object.entries(attrs||{}).filter(([k])=>['id','type','name','form','class','role','aria-label','aria-controls','aria-labelledby'].includes(k)));
const valueSummary=v=>v===undefined?undefined:{characters:String(v).length,sha256:sha(String(v))};
const select=c=>c.checked!=null||c.pressed!=null||c.expanded!=null||c.tag==='select'||['checkbox','radio','switch','tab','option','treeitem'].includes(c.role);
const native=c=>['input','select','textarea'].includes(c.tag)||c.editable;
const record=n=>n&&(['li','tr'].includes(n.tag)||['row','listitem','treeitem','option'].includes(n.attributes?.role)||Object.hasOwn(n.attributes||{},'data-row-key')||Object.hasOwn(n.attributes||{},'data-item-key'));
const htmlParse=`import json,sys
from html.parser import HTMLParser
class Fields(HTMLParser):
 def __init__(self):super().__init__(convert_charrefs=True);self.rows=[]
 def handle_starttag(self,tag,attrs):
  if tag in ['input','select','textarea']:
   attrs=dict(attrs);self.rows.append({'tag':tag,'attributes':{k:v for k,v in attrs.items() if k in ['type','id','name','form','class','aria-label']},'hasValueAttribute':'value' in attrs,'valueAttributeCharacters':len(attrs.get('value') or '')})
p=Fields();p.feed(sys.stdin.read());print(json.dumps(p.rows))`;
const docCache=new Map(), observationCache=new Map();
let report;
try {
 const objects=new ObservationObjectStore(db,()=>{throw Error('Readonly resolver attempted write')});
 const get=(kind,id)=>{const r=db.prepare('SELECT kind,id,session_id,json,compressed_json FROM entities WHERE kind=? AND id=?').get(kind,id);return r?decodeStoredEntity(r,objects.resolve):undefined;};
 const observation=id=>{if(!observationCache.has(id))observationCache.set(id,get('observation',id));return observationCache.get(id);};
 const detail=o=>{
  if(docCache.has(o.id))return docCache.get(o.id);
  const artifact=o.evidence?.artifacts?.details;
  if(!artifact)throw Error('No details for '+o.id);
  const manifestPath=join(evidenceDir,artifact.key+'.meta.json'),manifestBytes=readOriginal(manifestPath),m=JSON.parse(manifestBytes);
  const chunks=m.blocks||[m],data=Buffer.concat(chunks.map(c=>{if(!/^[a-f0-9]{64}\.(gz|bin)$/.test(c.blob))throw Error('Bad blob');const raw=readOriginal(join(evidenceDir,'blobs',c.blob)),b=c.encoding==='gzip'?gunzipSync(raw,{maxOutputLength:c.bytes}):raw;if(b.length!==c.bytes||sha(b)!==c.sha256)throw Error('Bad chunk');return b;}));
  if(data.length!==m.bytes||sha(data)!==m.sha256||sha(data)!==artifact.sha256)throw Error('Bad evidence SHA');
  const parsed=JSON.parse(data);if(parsed.observationId!==o.id||parsed.documentId!==o.documentId)throw Error('Wrong evidence');
  const dom=parsed.dom,nodes=new Map(dom.nodes.map(n=>[n.id,n])),controls=new Set(o.controls.map(c=>c.instanceId));
  const nativeNodes=dom.nodes.filter(n=>['input','select','textarea'].includes(n.tag));
  const omitted=nativeNodes.filter(n=>!controls.has(n.id));
  const htmlNative=JSON.parse(execFileSync('python3',['-c',htmlParse],{input:dom.html,encoding:'utf8',maxBuffer:4*1024*1024}));
  const project=n=>({nodeId:n.id,parentId:n.parentId,tag:n.tag,attributes:narrowAttrs(n.attributes),parent:narrowAttrs(nodes.get(n.parentId)?.attributes),
   liveValue:valueSummary(n.properties?.value),valueAttribute:valueSummary(n.attributes?.value),liveProperties:Object.fromEntries(Object.entries(n.properties||{}).filter(([k])=>['type','checked','indeterminate','disabled','readOnly'].includes(k)))});
  const ownerOf=c=>{const n=nodes.get(c.instanceId);let cur=n;while(cur&&!record(cur))cur=nodes.get(cur.parentId);return cur||nodes.get(n?.parentId)||n;};
  const closure=(cs)=>{
   const owners=new Set(cs.map(ownerOf).filter(Boolean).map(n=>n.id)),union=new Set();
   function add(id,subtree){const n=nodes.get(id);if(!n)return;if(n.nodeType==='element')union.add(id);if(subtree)for(const child of n.children)add(child,true);}
   for(const id of owners){let n=nodes.get(id);add(id,!['html','body'].includes(n.tag));while(n?.parentId){n=nodes.get(n.parentId);if(n){add(n.id,false);if(record(n))add(n.id,true)}}}
   return {owners:owners.size,knownControls:cs.filter(c=>nodes.has(c.instanceId)).length,controls:cs.length,knownElementLowerBound:union.size,ids:union};
  };
  const all=closure(o.controls),required=closure(o.controls.filter(c=>select(c)||native(c)));
  const result={observationId:o.id,observationCapturedAt:o.capturedAt,detailCapturedAt:dom.capturedAt,documentId:o.documentId,
   manifest:{path:manifestPath,sha256:sha(manifestBytes),detailsSha256:m.sha256,bytes:m.bytes,blocks:chunks.length,allBlockHashesVerified:true},
   domEvidence:{nodes:dom.nodes.length,elements:dom.nodes.filter(n=>n.nodeType==='element').length,nodesTruncated:dom.nodesTruncated,htmlTruncated:dom.htmlTruncated},
   nativeInventory:{retainedControls:o.controls.filter(native).length,treeFields:nativeNodes.length,htmlFields:htmlNative.length,
    omittedTreeFields:omitted.map(project),htmlHiddenFields:htmlNative.filter(n=>n.tag==='input'&&n.attributes.type==='hidden'),
    fieldCountCaveat:'DOM nodes are bounded; full HTML is used only to corroborate tag/type presence, not live native values or root completion.'},
   graph:o.ownerDependencies?{inventoryComplete:o.ownerDependencies.inventoryComplete,complete:o.ownerDependencies.complete,reasons:o.ownerDependencies.reasons,limits:o.ownerDependencies.limits,nodes:o.ownerDependencies.nodes.length,roots:o.ownerDependencies.roots.length}:null,
   budgetBounds:{allControlOwners:{...all,ids:undefined},selectorsAndNativeOwners:{...required,ids:undefined},
    caveat:'Lower bounds at the retained detail-capture time, using known owner subtrees and semantic ancestors only; transitive IDREF/form/label expansion can only add nodes. Separate timestamps prevent claiming exact same-instant collector outcome. Required set excludes the receipt target, so its bound can only increase.'},
   nodes,all,required,ownerOf};
  docCache.set(o.id,result);return result;
 };
 const targets=receipts.map(r=>{const o=observation(r.beforeId),a=get('attempt',r.attemptId);return {attemptId:r.attemptId,sessionId:r.sessionId,beforeId:r.beforeId,afterId:r.afterId,label:r.action.label,kind:r.action.kind,value:r.action.value,controlId:a.action.controlId,localId:a.action.localId,
  target:o.controls.filter(c=>c.localId===a.action.localId).map(c=>({localId:c.localId,instanceId:c.instanceId,identityId:c.identityId,hypothesisId:c.hypothesisId,tag:c.tag,role:c.role,selector:c.selector,readiness:c.readiness,selectorDependency:select(c),nativeInput:!!native(c)})),conditionReason:r.receiptCondition.reason,dispatchPresent:!!observation(r.afterId)?.ownerDependencyDispatch};});
 const sessions=[...new Set(receipts.map(r=>r.sessionId))],allHypotheses=sessions.flatMap(sid=>db.prepare("SELECT kind,id,session_id,json,compressed_json FROM entities WHERE kind='hypothesis' AND session_id=?").all(sid).map(r=>decodeStoredEntity(r,objects.resolve)));
 const hypothesisProjection=h=>({id:h.id,sessionId:h.sessionId,observationId:h.observationId,localId:h.localId,provisionalIdentityId:h.provisionalIdentityId,candidateIds:h.candidateIds,status:h.status,revisions:h.revisions.map(r=>({identityId:r.identityId,at:r.at}))});
 const beforeIds=[...new Set(receipts.map(r=>r.beforeId))],observations=beforeIds.map(id=>observation(id));
 const fieldSummaries=observations.map(o=>{const d=detail(o);return {...d,nodes:undefined,all:undefined,required:undefined,ownerOf:undefined}});
 const dynamics=receipts.map(r=>{
  const before=detail(observation(r.beforeId)),after=detail(observation(r.afterId));
  const changed=[];
  for(const id of before.required.ids){const b=before.nodes.get(id),a=after.nodes.get(id);if(!a)continue;
   const beforeTexts=b.children.map(id=>before.nodes.get(id)).filter(n=>n?.nodeType==='text').map(n=>n.text||'').join(''),afterTexts=a.children.map(id=>after.nodes.get(id)).filter(n=>n?.nodeType==='text').map(n=>n.text||'').join('');
   if(beforeTexts!==afterTexts)changed.push({nodeId:id,tag:b.tag,class:b.attributes?.class,beforeText:{length:beforeTexts.length,sha256:sha(beforeTexts)},afterText:{length:afterTexts.length,sha256:sha(afterTexts)},numericBefore:/\d/.test(beforeTexts),numericAfter:/\d/.test(afterTexts)});
  }
  return {attemptId:r.attemptId,kind:r.action.kind,label:r.action.label,sameDocument:before.documentId===after.documentId,requiredClosureTextChanges:changed.length,numericTextChanges:changed.filter(n=>n.numericBefore||n.numericAfter).length,examples:changed.slice(0,8),
   caveat:'Changes across an actual action are not proof that pre-dispatch reads are unstable or that a numeric text is a market price. They identify raw comparison sensitivity only.'};
 });
 const identityViews=observations.map(o=>({observationId:o.id,documentId:o.documentId,capturedAt:o.capturedAt,controls:o.controls.map(c=>({localId:c.localId,instanceId:c.instanceId,identityId:c.identityId,hypothesisId:c.hypothesisId,tag:c.tag,role:c.role,selectorDependency:select(c),nativeInput:!!native(c)}))}));
 const pending=allHypotheses.filter(h=>h.status==='pending'),resolved=allHypotheses.filter(h=>h.status==='resolved');
 report={format:'run8-collection-and-identity-diagnosis-v1',at:new Date().toISOString(),revision:execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),node:process.version,
  scope:'Read-only native SQLite handle on the exclusive temporary copy; no BrowserEngine/SqliteStore construction, browser, service, or original DB handle. Original evidence files read directly without FileEvidenceStore coordination locks.',
  audit:file(auditFile),analysisScript:file(fileURLToPath(import.meta.url)),sourceFiles:sourceFiles.map(p=>file(join(ROOT,p))),databaseBefore:beforeDb,
  targets,identity:{pending:pending.map(hypothesisProjection),resolved:resolved.map(hypothesisProjection),beforeControls:identityViews},observations:fieldSummaries,
  dynamicContentChecks:dynamics,
  summary:{newExplorationReceipts:receipts.length,targetHypothesisIds:targets.flatMap(t=>t.target.map(c=>c.hypothesisId).filter(Boolean)),pendingHypotheses:pending.length,resolvedHypotheses:resolved.length,
   allBeforeGraphsEmpty:fieldSummaries.every(d=>d.graph?.nodes===0),allBeforeReasonsUnretainedNative:fieldSummaries.every(d=>d.graph?.reasons.includes('unretained_native_input')),
   beforeWithOmittedHiddenField:fieldSummaries.filter(d=>d.nativeInventory.omittedTreeFields.some(n=>n.attributes.type==='hidden')).length,
   allOwnerNodeBoundExceedsBudget:fieldSummaries.filter(d=>d.budgetBounds.allControlOwners.knownElementLowerBound>d.graph.limits.nodes).length,
   requiredOwnerNodeBoundExceedsBudget:fieldSummaries.filter(d=>d.budgetBounds.selectorsAndNativeOwners.knownElementLowerBound>d.graph.limits.nodes).length,
   observationsCount:fieldSummaries.length},
  limitations:['Snapshots use individual capture timestamps. No old graph or missing dispatch witness was reconstructed.','This audit does not establish whether the hidden input is business-relevant. Its lack of name/id is not proof of irrelevance.','Full-graph overflow does not imply every local required closure fails. The separate required selector/native lower bound is the narrower diagnostic.','Existing identity_pending is an independent earlier SDK gate; fixing collection alone cannot change these historical query results.']};
} finally {db.close();}
report.databaseAfter=file(dbPath);report.databaseUnchanged=report.databaseBefore.sha256===report.databaseAfter.sha256;
const touchedRows=[...touched].sort(([a],[b])=>a.localeCompare(b));
report.originalEvidenceReads={files:touchedRows.length,fileHashManifestSha256:sha(JSON.stringify(touchedRows)),allFilesUnchanged:touchedRows.every(([p,h])=>sha(readFileSync(p))===h),detailsReferencedOnly:true};
writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({output:out,sha256:sha(readFileSync(out)),bytes:readFileSync(out).length,summary:report.summary,databaseUnchanged:report.databaseUnchanged,originalEvidenceReads:report.originalEvidenceReads},null,2));
