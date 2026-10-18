import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,appendFileSync,existsSync,copyFileSync} from 'node:fs';
import {createHash} from 'node:crypto';import {resolve,join} from 'node:path';
const strategy=process.argv[3]||'program-only';if(!['program-model','program-only'].includes(strategy))throw Error('INVALID_STRATEGY');
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:false});
const protocol=JSON.parse(readFileSync('docs/experiments/broader-ui-exploration-2026-10-18/protocol.json','utf8'));protocol.strategy=strategy;
writeFileSync(join(out,'protocol.json'),JSON.stringify(protocol,null,2));
const paths=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z','packages','scripts','tests'],{encoding:'utf8'}).split('\0').filter(p=>p&&/\.(ts|mjs|json)$/.test(p));
writeFileSync(join(out,'source.json'),JSON.stringify({revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),files:Object.fromEntries([...new Set(paths)].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]))},null,2));
writeFileSync(join(out,'source.diff'),execFileSync('git',['diff','HEAD','--','packages','scripts','tests']));
let worker,timedOut=false;const kill=p=>{try{process.kill(-p.pid,'SIGKILL');}catch{}};
const began=Date.now();writeFileSync(join(out,'budget.json'),JSON.stringify({began,deadline:began+protocol.wallMs,actions:0}));const timer=setTimeout(()=>{timedOut=true;if(worker)kill(worker);},protocol.wallMs);
const run=async(script,dir,log)=>{worker=spawn(process.execPath,['--import','tsx','--conditions=development',script,dir],{detached:true,env:process.env,stdio:['ignore','pipe','pipe']});const child=worker;for(const stream of [child.stdout,child.stderr])stream.on('data',d=>appendFileSync(join(out,log),d));const result=await new Promise(r=>child.on('exit',(code,signal)=>r({code,signal,pid:child.pid})));kill(child);return result;};
try{
 const execution=await run('scripts/broad-okx-worker.ts',out,'worker.log');
 if(!timedOut&&existsSync(join(out,'task-final.json'))){
  const audit=join(out,'audit-copy');mkdirSync(join(audit,'engine'),{recursive:true});
  for(const file of ['engine/engine.sqlite','explorer.sqlite','timeline.jsonl','budget.json','protocol.json','task-id','task-final.json'])copyFileSync(join(out,file),join(audit,file));
  await run('scripts/finite-okx-audit.ts',audit,'audit.log');
  if(!timedOut&&existsSync(join(audit,'audit.json')))await run('scripts/broad-okx-audit.ts',audit,'audit.log');
  for(const file of ['audit.json','broad-audit.json','coverage-ledger.json'])if(existsSync(join(audit,file)))copyFileSync(join(audit,file),join(out,file));
 }
 const audit=existsSync(join(out,'broad-audit.json'))?JSON.parse(readFileSync(join(out,'broad-audit.json'),'utf8')):undefined,budget=JSON.parse(readFileSync(join(out,'budget.json'),'utf8'));
 const result={...audit,accepted:!timedOut&&audit?.accepted===true,elapsedMs:Date.now()-began,timedOut,actions:budget.actions,execution,reason:timedOut?'wall_budget_exhausted':audit?.reason||'audit_unavailable'};
 writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));process.exitCode=result.accepted?0:2;
}finally{clearTimeout(timer);if(worker)kill(worker);}
