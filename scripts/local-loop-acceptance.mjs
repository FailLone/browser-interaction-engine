import {createServer} from 'vite';
import {createServer as reservePort} from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,appendFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join,dirname} from 'node:path';
const out=resolve(process.argv[2]||`.data/local-loop-${Date.now()}`);mkdirSync(dirname(out),{recursive:true});mkdirSync(out,{recursive:false});
const protocol={version:2,coveragePolicy:'finite-ui-v1',internalRounds:3,roundPolicy:'At most three existing scheduler rounds within the same wall and dispatch budgets; exhaustion is failure, never a budget reset.',wallMs:240000,actions:80,url:'/?defects=off',inputs:{numeric:['1'],text:['sample']},branches:['pair:BTC/USDT','pair:ETH/USDT','mode:Limit','mode:Market','unit:USDT','unit:Base asset','post-only:true','post-only:false','settings:GTC','settings:IOC','settings:Done','rebuild','duplicate:open','duplicate:close','quick-market','reset','background:true','background:false','price:1','amount:1','reference:0:sample','reference:1:sample','submit'],scope:'Each listed reachable branch must have independent DOM event evidence. Distinct controls and conditional options are separate; recovery actions count against total but grant no new coverage. Quote changes create no obligations. Free inputs have one finite sample, no claim to exhaustive values.',pass:'All branches, original-child autonomous reentry with SDK correspondence and durable successful child receipt, a real process restart at a settled mixed-work boundary, same-task continuation, final independent durable query, no unbounded work or duplicate completed target testing. Missing evidence fails.'};
const sourcePaths=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z','packages','scripts','tests','apps/test-site'],{encoding:'utf8'}).split('\0').filter(p=>p&&/\.(ts|tsx|mjs|json|css)$/.test(p));
writeFileSync(join(out,'source.json'),JSON.stringify({revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),files:Object.fromEntries([...new Set(sourcePaths)].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]))},null,2));
writeFileSync(join(out,'source.diff'),execFileSync('git',['diff','HEAD','--','packages','scripts','tests','apps/test-site']));
writeFileSync(join(out,'protocol.json'),JSON.stringify(protocol,null,2));
const portProbe=reservePort();await new Promise(r=>portProbe.listen(0,'127.0.0.1',r));const port=portProbe.address().port;await new Promise(r=>portProbe.close(r));
const site=await createServer({root:resolve('apps/test-site'),server:{host:'127.0.0.1',port,strictPort:true},logLevel:'silent'});await site.listen();const url=`http://127.0.0.1:${site.httpServer.address().port}/?defects=off`;
const kill=p=>{try{process.kill(-p.pid,'SIGKILL');}catch{}};
let worker;let began;let timer;let timedOut=false;const phases=[];
try{
 began=Date.now();writeFileSync(join(out,'budget.json'),JSON.stringify({began,deadline:began+240000,actions:0}));
 timer=setTimeout(()=>{timedOut=true;if(worker)kill(worker);},240000);
 for(const phase of ['first','restart']){worker=spawn(process.execPath,['--import','tsx','--conditions=development','scripts/local-loop-worker.ts',out,url,phase],{detached:true,env:process.env,stdio:['ignore','pipe','pipe']});worker.stdout.on('data',d=>appendFileSync(join(out,'worker.log'),d));worker.stderr.on('data',d=>appendFileSync(join(out,'worker.log'),d));const exit=await new Promise(r=>worker.on('exit',(code,signal)=>r({code,signal})));phases.push({phase,pid:worker.pid,...exit});kill(worker);if(exit.code!==75||timedOut)break;}
 if(!timedOut){worker=spawn(process.execPath,['--import','tsx','--conditions=development','scripts/local-loop-audit.ts',out],{detached:true,stdio:['ignore','pipe','pipe']});worker.stdout.on('data',d=>appendFileSync(join(out,'audit.log'),d));worker.stderr.on('data',d=>appendFileSync(join(out,'audit.log'),d));await new Promise(r=>worker.on('exit',r));kill(worker);}
 const budget=JSON.parse(readFileSync(join(out,'budget.json'),'utf8'));
 const audit=existsSync(join(out,'audit.json'))?JSON.parse(readFileSync(join(out,'audit.json'),'utf8')):undefined;
 const result={...audit,passed:!timedOut&&audit?.passed===true,elapsedMs:Date.now()-began,realBrowserActions:budget.actions,timedOut,phases,reason:timedOut?'wall_budget_exhausted':audit?.passed?'passed':audit?.reason||'independent_evidence_audit_required'};process.exitCode=result.passed?0:1;
 writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({out,...result}));
}finally{clearTimeout(timer);if(worker)kill(worker);await site.close();}
