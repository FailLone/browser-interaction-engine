import {readFileSync} from 'node:fs';import {join} from 'node:path';
import {BrowserEngine} from '@interaction/browser';import {SqliteStore} from '@interaction/storage-sqlite';import {ExplorerPlugin,ExplorerStore} from '@interaction/explorer-plugin';
import {completedOperations} from '../packages/explorer-plugin/src/completion-evidence.js';
import {scopeFor,permitted,schedulingKeyFor} from '../packages/explorer-plugin/src/policy.js';
const dir=process.argv[2];const h=new BrowserEngine({persistence:new SqliteStore(join(dir,'engine'))});const s=new ExplorerStore(join(dir,'explorer.sqlite'));const t=s.task(readFileSync(join(dir,'task-id'),'utf8'));const p=new ExplorerPlugin(h,s,{});
for(const r of t.rounds){const o=h.observation(r.sessionId),snap=h.explorationSnapshot(r.sessionId,o.id,{includeHistoryAudit:false}),completed=completedOperations(h,t,o,snap.actions);console.log(JSON.stringify({round:r.number,observation:o.id,actions:snap.actions.filter(a=>['Post only','Duplicate controls','Background refresh'].includes(a.label)).map(a=>({label:a.label,value:a.value,scope:scopeFor(a,o),condition:schedulingKeyFor(a,o),completed:completed.has(a),permitted:permitted(a,o,snap.availability),blockers:snap.availability.actions.find(x=>x.actionId===a.id)?.blockers,tried:(p as any).wasTried(t,r,a,o),fresh:(p as any).freshAction(t,r,a,o,completed.has(a))}))}));}
await p.close();await h.close();
