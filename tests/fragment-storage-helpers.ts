import {fragmentProjectionPolicy} from '@interaction/browser';
import {ExplorerStore} from '../packages/explorer-plugin/src/store.js';
import {TaskWriter} from '../packages/explorer-plugin/src/task-writer.js';
import type {FragmentSession} from '../packages/explorer-plugin/src/fragment-session.js';
import type {Task} from '../packages/explorer-plugin/src/types.js';
import type {FragmentTraversalLedger} from '../packages/explorer-plugin/src/fragment-records.js';
export const fragmentTask=():Task=>({id:'task',goal:'Explore',url:'https://example.test/',createdAt:'2026-10-18',updatedAt:'2026-10-18',revision:0,status:'paused',budget:{rounds:3,actions:300,durationMs:60000,modelRequests:10},usage:{rounds:0,actions:0,durationMs:0,modelRequests:0},sessionOptions:{},plan:[],rounds:[],sampleExcluded:[],exhaustive:false});
export function fragmentFixture(path=':memory:',legacy?:FragmentTraversalLedger):{store:ExplorerStore;writer:TaskWriter;session:FragmentSession;task:Task;close:()=>void}{
  const store=new ExplorerStore(path),task=fragmentTask();if(legacy)task.fragmentTraversal=legacy;store.save(task);
  const writer=new TaskWriter(store,store.taskState(task.id)),session=writer.fragments();
  return {store,writer,session,task:writer.task,close:()=>store.close()};
}
export const emptyLegacy=():FragmentTraversalLedger=>({policy:fragmentProjectionPolicy,epoch:0,revokedCandidates:{},obligations:{},fragments:[],mappings:[],events:[],states:[]});
