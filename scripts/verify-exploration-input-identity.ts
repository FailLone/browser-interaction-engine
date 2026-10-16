/** Supplemental shared-identifier input experiment. Frozen product; fresh local browsers only. */
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {BrowserEngine,type ActionAttempt} from '@interaction/browser';
import {MemoryStore} from '@interaction/storage-memory';
import type {Page} from 'playwright';

const {values}=parseArgs({options:{revision:{type:'string'},output:{type:'string'},runs:{type:'string'}}});
if(!values.revision||!values.output)throw new Error('Required --revision SHA --output PATH');
const repeats=Number(values.runs||5),sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const scenarios=['distinct-names','same-name-named-owners'] as const;
const results:unknown[]=[];
for(const scenario of scenarios)for(let run=1;run<=repeats;run++){
 const events:{branch:string;value:string}[]=[],checks:unknown[]=[],attempts:unknown[]=[],errors:string[]=[];
 const html=`<!doctype html><html><body><script>function record(branch,value){const r=new XMLHttpRequest();r.open('POST','/oracle?branch='+branch+'&value='+encodeURIComponent(value),false);r.send()}</script>${['A','B'].map(name=>`<section id="owner-${name}" aria-label="Owner ${name}"><input id="shared" aria-label="${scenario==='distinct-names'?name:'Value'}" oninput="record('${name}',this.value)"></section>`).join('')}</body></html>`;
 const server=createServer((req,res)=>{if(req.url?.startsWith('/oracle?')){const params=new URL(req.url,'http://fixture').searchParams;events.push({branch:params.get('branch')!,value:params.get('value')!});res.writeHead(204);res.end();return;}res.setHeader('content-type','text/html');res.end(html);});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
 const host=new BrowserEngine({persistence:new MemoryStore(),hooks:{samples:()=>['sample']}});
 try{
  const session=await host.createSession({url:`http://127.0.0.1:${(server.address() as {port:number}).port}/`,headless:true,exploration:'controls',contextRules:[],settleMs:0,observeTimeoutMs:1000,actionTimeoutMs:1500});
  const sid=session.id,page=(host as unknown as {driver:{page:Page}}).driver.page;
  const target=(owner:string)=>{
   const o=host.observation(sid),c=o.controls.find(c=>c.identityContext?.scope?.includes(`Owner ${owner}`));
   const a=host.actions(sid).filter(a=>a.kind==='fill'&&a.localId===c?.localId);
   if(a.length!==1)throw new Error(`Expected unique captured field in Owner ${owner}, got ${a.length}`);return a[0];
  };
  const fill=async(owner:string)=>{const a=target(owner);const attempt=await host.execute(sid,a.id,randomUUID(),'sample',{profile:'interface-exploration',observationId:host.observation(sid).id});attempts.push({owner,id:attempt.id,status:attempt.status,reason:attempt.reason});return attempt;};
  const compare=(phase:string,source:ActionAttempt,owner:string,expected:boolean)=>{
   const a=target(owner),proof=host.operationCorrespondences(sid,{observationId:host.observation(sid).id,requests:[{actionId:a.id,source:{sessionId:sid,attemptId:source.id}}]}).results[0];
   checks.push({phase,expected,actual:proof.equivalent,reason:proof.reason,sourceValue:source.action.value,targetValue:a.value,proof,oracle:structuredClone(events)});
  };
  const a=await fill('A');
  await page.evaluate(()=>document.querySelector('#owner-A')!.remove());await host.observe(sid);
  compare('A disappears; B remains',a,'B',false);
  const b=await fill('B');
  // Make the same destination sample available again. The candidate generator
  // deliberately omits fill(sample) when the current value already is sample.
  await page.evaluate(()=>{const b=document.querySelector<HTMLInputElement>('#owner-B input')!;const rebuilt=b.cloneNode(true) as HTMLInputElement;rebuilt.value='';b.replaceWith(rebuilt);});await host.observe(sid);
  compare('B rebuilt, compare with A',a,'B',false);compare('B rebuilt, compare with B',b,'B',true);
  await page.evaluate(()=>{const owner=document.querySelector('#owner-B')!;owner.setAttribute('aria-label','Owner C');owner.querySelector('input')!.setAttribute('oninput',"record('C',this.value)");});await host.observe(sid);
  compare('owner changes, compare with B',b,'C',false);await fill('C');
 }catch(error){errors.push(String(error));}
 finally{await host.close();await new Promise<void>(done=>server.close(()=>done()));}
 const row={scenario,run,fixtureSha256:sha(html),events,checks,attempts,errors};results.push(row);console.log(JSON.stringify(row));
}
mkdirSync(dirname(resolve(values.output)),{recursive:true});
writeFileSync(resolve(values.output),JSON.stringify({revision:values.revision,sourceRoot:process.cwd(),node:process.version,scriptSha256:sha(readFileSync(new URL(import.meta.url),'utf8')),method:'Public SDK guarded fill plus operationCorrespondences, explicit external DOM mutations; independent HTTP input-event oracle; not autonomous scheduler coverage',results},null,2)+'\n');
