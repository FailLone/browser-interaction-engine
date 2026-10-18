import {readFileSync,writeFileSync,existsSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
export function offlineProviders(url,directory){
 const tape=JSON.parse(readFileSync(new URL('./evidence/local-answers.json',import.meta.url),'utf8').replaceAll('{{LOCAL_URL}}',url));
 const path=join(directory,'offline-cursors.json');
 const provider=actor=>({name:'retained-successful-local-answers',model:'offline-recording',async decide(request){
  const state=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{},key=actor+':'+request.purpose,index=state[key]||0;
  const answer=tape.answers.filter(a=>a.actor===actor&&a.purpose===request.purpose)[index];
  if(!answer)throw Error('OFFLINE_TAPE_EXHAUSTED:'+key+':'+index);
  state[key]=index+1;writeFileSync(path,JSON.stringify(state));
  appendFileSync(join(directory,'offline-answers.jsonl'),JSON.stringify({actor,purpose:request.purpose,index,sourceDecisionId:answer.sourceDecisionId,pid:process.pid})+'\n');
  return structuredClone(answer.answer);
 }});
 return {jev:provider('jev'),llm:provider('llm')};
}
