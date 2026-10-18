// Offline recorded-provider replay for the unchanged original browser harness.
// No provider network fallback. Cursors survive the harness's process restart.
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const file=process.env.COMPONENT_REPLAY_STATE;if(!file)throw Error('REPLAY_STATE_REQUIRED');
const tape=JSON.parse(readFileSync(new URL('./evidence/local-success-tape.json',import.meta.url),'utf8'));
const endpoints=new Map([[process.env.EXPLORER_JEV_ENDPOINT,'jev'],[process.env.EXPLORER_LLM_ENDPOINT,'llm']]);
const original=fetch,read=()=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;return {cursor:0};}};
const semantic=c=>c&&({tag:c.tag,role:c.role,name:c.name,label:c.label,stableKey:c.stableKey,readOnly:c.readOnly,editable:c.editable,attributes:c.reviewBinding?.attributes,
 nodes:c.classificationBinding?.nodes?.map(n=>({tag:n.tag,attributes:n.attributes,text:n.text}))});
globalThis.fetch=async(input,init)=>{
 const actor=endpoints.get(String(input));if(!actor)return original(input,init);
 const state=read(),source=tape.decisions[state.cursor],body=JSON.parse(init.body),request=actor==='llm'?JSON.parse(body.messages[1].content):{state:body.state};
 if(!source||source.actor!==actor)throw Error('REPLAY_SEQUENCE_MISMATCH');
 if(actor==='jev'&&JSON.stringify(body.questions)!==JSON.stringify(source.input.questions)||actor==='llm'&&(request.purpose!==source.purpose||request.instructions!==source.request.instructions))throw Error('REPLAY_QUESTION_MISMATCH');
 const a=source.request.state.material,b=request.state.material,oldControl=a.control||a.evidence?.current,newControl=b.control||b.evidence?.current;
 if(JSON.stringify(semantic(oldControl))!==JSON.stringify(semantic(newControl)))throw Error('REPLAY_CONTROL_MISMATCH');
 const currentURL=JSON.stringify(request.state).match(/http:\/\/127\.0\.0\.1:\d+\/(?:\?defects=off)?/)?.[0];
 const answer=JSON.parse(JSON.stringify(source.answer).replaceAll(tape.sourceUrl,currentURL||tape.sourceUrl));
 state.cursor++;writeFileSync(file,JSON.stringify(state));appendFileSync(file+'.jsonl',JSON.stringify({actor,purpose:source.purpose,sourceDecisionId:source.id,paidHttpRequests:0,replayedResponses:1})+'\n');
 if(actor==='jev')return Response.json(answer.response);
 const r=answer.response;return Response.json({id:r.id,provider:r.provider,model:answer.model,usage:answer.usage,choices:[{finish_reason:r.finishReason,message:{content:r.content}}]});
};
