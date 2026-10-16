import {copyFileSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {BrowserAdapter,BrowserEngine,browserTargetConditions} from '@interaction/browser';
import {SqliteStore} from '@interaction/storage-sqlite';
import {scopeFor,keyFor,matches} from '../../../../../packages/explorer-plugin/src/policy.js';
const root=resolve(import.meta.dirname,'../../../../..'),input=join(root,'.data/okx-storage-acceptance-20261017-v1-frozen-4/engine/engine.sqlite');
const tmp=mkdtempSync(join(tmpdir(),'okx-plan-growth-probe-')),digest=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex'),before=digest(input);
copyFileSync(input,join(tmp,'engine.sqlite'));let browserStarts=0;BrowserAdapter.prototype.start=async()=>{browserStarts++;throw Error('FORBIDDEN');};
const store=new SqliteStore(tmp),engine=new BrowserEngine({persistence:store});
try{
 const sid='412937f3-c4f5-4799-b86c-74adf480f329',current=engine.observation(sid,'9ca9a659-c1af-47c6-af1c-40b77b5803a3'),source=engine.observation(sid,'5f80a3df-8355-444a-8499-4a625cb89577');
 // Reader reconstruction only: cursor changes in the disposable copy.
 store.put('session',{...engine.session(sid),currentObservationId:current.id});
 const results=['1W','Trade','1h'].map(label=>{
  const old=engine.actions(sid,source.id).filter(a=>a.label===label&&a.kind==='click'),now=engine.actions(sid,current.id).filter(a=>a.label===label&&a.kind==='click');
  if(old.length!==1||now.length!==1)return {label,old:old.length,now:now.length};
  const a=old[0],b=now[0],requests=[{actionId:b.id,source:{sessionId:sid,observationId:source.id,actionId:a.id}},{actionId:b.id,source:{sessionId:sid,observationId:current.id,actionId:b.id}}];
  return {label,sourceScope:scopeFor(a,source),currentScope:scopeFor(b,current),sourceKey:keyFor(a,source),currentKey:keyFor(b,current),sourceTargetCondition:browserTargetConditions(a,source),currentTargetCondition:browserTargetConditions(b,current),proofs:engine.explorationTargetCorrespondences(sid,{observationId:current.id,requests}).results};
 });
 const report={browserStarts,originalHashUnchanged:before===digest(input),copyCursorOnly:true,results};writeFileSync(join(import.meta.dirname,'plan-growth-probe.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(results.map(r=>({label:r.label,old:'old'in r?r.old:1,now:'now'in r?r.now:1,proofs:r.proofs?.map(p=>({equivalent:p.equivalent,reason:p.reason}))})),null,2));
}finally{await engine.close();rmSync(tmp,{recursive:true,force:true});}
