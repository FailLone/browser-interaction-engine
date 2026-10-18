import {type Observation,type EngineHooks} from '@interaction/adapter-playwright';
export function meterReadinessBrowser(limit=40,wallMs=60000) {
 const began=Date.now(),commands:{method:string;at:number;elapsedMs?:number}[]=[],captures:{id:string;ms:number;content:Observation['contentReadiness'];controls:unknown[];gaps:unknown[]}[]=[];
 const active=new Map<number,any>();let rejected=0;
 const charge=(method:string)=>{if(commands.length>=limit||Date.now()-began>=wallMs){rejected++;throw Error('ASYNC_FIXTURE_BUDGET');}const row={method,at:Date.now()};commands.push(row);return row;};
 // Preserve the original 40-step accounting, including the same conservative
 // screenshot/document reservations. Native implementations remain untouched.
 const hooks:EngineHooks={browserInstrumentation:{observe(event){
  if(event.phase==='before'){
   if(event.command==='capture'){active.set(event.id,{method:'capture',at:event.at});charge('screenshot');charge('verify-document');}
   else if(['start','execute','readDOM','readHistory','waitForCaptureSample'].includes(event.command))active.set(event.id,charge(event.command));
  }else{
   const row=active.get(event.id);if(row)row.elapsedMs=event.elapsedMs;
   if(event.command==='capture'&&event.status==='returned')captures.push({...event.result as any,ms:event.elapsedMs!});
   active.delete(event.id);
  }
 }}};
 return {began,commands,captures,charge,hooks,get rejected(){return rejected;},restore(){}};
}
