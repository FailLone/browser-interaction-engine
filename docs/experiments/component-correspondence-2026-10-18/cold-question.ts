import {readFileSync} from 'node:fs';
import {ExplorerStore} from '@interaction/explorer-plugin';
import {TaskWriter} from '../../../packages/explorer-plugin/src/task-writer.js';
import {ComponentJudgments} from '../../../packages/explorer-plugin/src/component-correspondence.js';
const [path,materialPath]=process.argv.slice(2),store=new ExplorerStore(path),writer=new TaskWriter(store,store.taskState('task'));
try {const material=JSON.parse(readFileSync(materialPath,'utf8')),q=await new ComponentJudgments().judge(material,{fragments:writer.fragments(),task:writer.task,
 providers:{jev:{name:'offline',model:'judge-v1',decide:async()=>{throw Error('COLD_PROVIDER_CALL');}},llm:{name:'offline',model:'explain-v1',decide:async()=>{throw Error('COLD_PROVIDER_CALL');}}},persist:()=>writer.flush(),signal:new AbortController().signal,stillValuable:()=>true,event:()=>{},decide:async()=>{throw Error('COLD_PROVIDER_CALL');}});
 console.log(JSON.stringify({pid:process.pid,status:q?.status,calls:q?.calls.length}));if(q?.status!=='no')process.exitCode=1;
}finally{store.close();}
