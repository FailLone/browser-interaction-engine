// Direct parameterized reuse of the fixed acceptance runner. No generated code.
import {readFileSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseEnv} from 'node:util';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,resolve,join} from 'node:path';

const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../../../../..');
if(process.argv.length!==4||process.argv[2]!=='--run')throw Error('Explicit --run <verified-main-revision> required');
const config=JSON.parse(readFileSync(join(here,'window.json'),'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const revision=git('rev-parse','HEAD'),directory=join(root,config.destination),node=config.node;
if(revision!==process.argv[3]||revision!==git('rev-parse','main'))throw Error('Requested source must match merged main');
execFileSync('git',['merge-base','--is-ancestor',config.productCommit,revision],{cwd:root,stdio:'ignore'});
execFileSync('git',['merge-base','--is-ancestor',config.publishedMainCommit,revision],{cwd:root,stdio:'ignore'});
execFileSync('git',['diff','--exit-code',config.publishedMainCommit,revision,'--','packages',config.runner,'pnpm-lock.yaml'],{cwd:root,stdio:'ignore'});
execFileSync('git',['diff','--exit-code','HEAD','--','packages',config.runner,'pnpm-lock.yaml'],{cwd:root,stdio:'ignore'});
if(git('ls-files','--others','--exclude-standard','--','packages',config.runner,'pnpm-lock.yaml'))throw Error('Untracked runtime input');
if(sha(readFileSync(join(root,config.runner)))!==config.runnerSha256)throw Error('Acceptance protocol changed');
const preparation=JSON.parse(readFileSync(join(here,'preparation.json'),'utf8'));
if(preparation.revision!==revision||preparation.productCommit!==config.productCommit||preparation.destination!==directory||!preparation.sourceUnchanged)throw Error('Continuation preparation does not match this revision');
const saved=parseEnv(readFileSync(config.providerEnvironment,'utf8'));
const names=['EXPLORER_JEV_PROVIDER','EXPLORER_JEV_API_KEY','EXPLORER_JEV_ENDPOINT','EXPLORER_JEV_MODEL','EXPLORER_LLM_PROVIDER','EXPLORER_LLM_API_KEY','EXPLORER_LLM_ENDPOINT','EXPLORER_LLM_MODEL','EXPLORER_LLM_UPSTREAM_PROVIDER','EXPLORER_LLM_MAX_OUTPUT_TOKENS','EXPLORER_LLM_REASONING_EFFORT','EXPLORER_MODEL_TIMEOUT_MS','EXPLORER_NOUL_LOW','EXPLORER_NOUL_HIGH','EXPLORER_OPERATION_NOUL_LOW','EXPLORER_OPERATION_NOUL_HIGH','EXPLORER_CHOICE_THRESHOLD','EXPLORER_CLASSIFICATION_THRESHOLD','EXPLORER_IDENTITY_THRESHOLD','EXPLORER_EVIDENCE_THRESHOLD','EXPLORER_PLANNING_THRESHOLD'];
const env=Object.fromEntries(['HOME','TMPDIR','LANG','LC_ALL','HTTPS_PROXY','HTTP_PROXY','NO_PROXY'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
env.PATH=dirname(node)+':/usr/bin:/bin:/usr/sbin:/sbin';
for(const key of names)if(saved[key]!==undefined)env[key]=saved[key];
const budget=config.budget;
const args=['--import','tsx','--conditions=development',config.runner,'--dir',directory,'--resume','--extend-budget',
  '--rounds',String(budget.rounds),'--actions',String(budget.actions),'--model-requests',String(budget.modelRequests),
  '--minutes',String(budget.minutes),'--sample-seconds',String(budget.sampleSeconds),'--stall-minutes',String(budget.stallMinutes)];
const record={startedAt:new Date().toISOString(),directory,sourceRevision:revision,sourceMatchesMain:true,productCommit:config.productCommit,
  windowConfigSha256:sha(readFileSync(join(here,'window.json'))),args,
  providerConfiguration:'Existing provider variables only; database/service variables excluded; values never recorded.',
  stopControl:'Owned --request-stop protocol only; unchanged recovery/unknown/provider/usage stop gates.',purpose:config.purpose};
const log=openSync(join(here,'launch.log'),'wx',0o600);
writeFileSync(join(here,'launch.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
const child=spawn(node,args,{cwd:root,env,stdio:['ignore',log,log]});
record.pid=child.pid;writeFileSync(join(here,'launch.json'),JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify({started:true,pid:child.pid,directory,revision,log:join(here,'launch.log')}));
child.on('error',error=>{record.launchError=error.code||error.name;});
child.on('exit',(exitCode,signal)=>{record.finishedAt=new Date().toISOString();record.exitCode=exitCode;record.signal=signal;
  writeFileSync(join(here,'launch.json'),JSON.stringify(record,null,2)+'\n');closeSync(log);
  console.log(JSON.stringify({finished:true,exitCode,signal}));process.exitCode=exitCode??1;});
