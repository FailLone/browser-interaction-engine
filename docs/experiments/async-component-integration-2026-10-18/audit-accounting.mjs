import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
const dir=resolve(process.argv[2]);
const events=readFileSync(join(dir,'timeline.jsonl'),'utf8').trim().split('\n').map(JSON.parse),budget=JSON.parse(readFileSync(join(dir,'budget.json'),'utf8'));
const commands=events.filter(e=>e.type==='browser.command').map(e=>e.data),starts=commands.filter(e=>e.phase==='before'),ends=commands.filter(e=>e.phase==='after');
const key=e=>e.driverId+':'+e.id,admitted=events.filter(e=>['browser.navigation','browser.dispatch'].includes(e.type));
const auxiliary={};for(const e of starts){const row=auxiliary[e.command]??={calls:0,returned:0,failed:0,elapsedMs:0,requestedWaitMs:0};row.calls++;row.requestedWaitMs+=e.input.milliseconds||0;}
for(const e of ends){const row=auxiliary[e.command];row[e.status]++;row.elapsedMs+=e.elapsedMs||0;}
const rejected=ends.filter(e=>['start','execute'].includes(e.command)&&e.operationStarted===false&&e.error?.includes('ACCEPTANCE_BUDGET'));
const expected=starts.filter(e=>['start','execute'].includes(e.command)).length-rejected.length;
const report={originalBoundary:'startup and native execute; recovery startup and failed admitted dispatch included',limit:80,ledgerActions:budget.actions,admittedEvents:admitted.length,expectedFromNativeEvents:expected,
 sequentialNumbers:admitted.every((e,i)=>e.data.number===i+1),paired:starts.every(e=>ends.filter(end=>key(end)===key(e)).length===1)&&ends.every(e=>starts.filter(start=>key(start)===key(e)).length===1),
 countMatches:budget.actions===admitted.length&&expected===budget.actions,budgetRefusals:rejected.length,withinBudget:budget.actions<=80,auxiliary,
 auxiliaryElapsedMeaning:'Nested logical operations overlap; elapsed sums are not wall time. Locator/actionability is part of compound native execute; launch/network setup is part of startup.',
 scriptBoundary:'All capture sampling, capture auxiliaries, history reads/waits, recovery, validation and public inventory are recorded separately; SDK queries appear in sdk.call.'};
writeFileSync(join(dir,'accounting-audit.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!report.paired||!report.countMatches||!report.sequentialNumbers||!report.withinBudget)process.exitCode=2;
