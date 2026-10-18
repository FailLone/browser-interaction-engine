import {BrowserAdapter,type Observation} from '@interaction/adapter-playwright';
export function meterReadinessBrowser(limit=40,wallMs=60000) {
 const began=Date.now(),commands:{method:string;at:number;elapsedMs?:number}[]=[],captures:{id:string;ms:number;content:Observation['contentReadiness'];controls:unknown[];gaps:unknown[]}[]=[];
 const originals=new Map<string,any>();let rejected=0;
 const charge=(method:string)=>{if(commands.length>=limit||Date.now()-began>=wallMs){rejected++;throw Error('ASYNC_FIXTURE_BUDGET');}const row={method,at:Date.now()};commands.push(row);return row;};
 // Acquisition substeps and waits are counted, not hidden inside observe. Two
 // slots conservatively reserve capture screenshot and document verification.
 // Native dispatch includes Playwright's locator/actionability implementation.
 for(const method of ['start','execute','capture','readDOM','readHistory','waitForCaptureSample']){
  const original=(BrowserAdapter.prototype as any)[method];if(typeof original!=='function')continue;originals.set(method,original);
  (BrowserAdapter.prototype as any)[method]=async function(...args:any[]){const row:any=method==='capture'?{method,at:Date.now()}:charge(method);
   try{if(method==='capture'){charge('screenshot');charge('verify-document');}const result=await original.apply(this,args);
    if(method==='capture')captures.push({id:args[0],ms:Date.now()-row.at,content:result.contentReadiness,controls:result.controls.filter((c:any)=>c.visible).map((c:any)=>({name:c.name,id:c.localId,readiness:c.readiness})),gaps:result.gaps});return result;
   }finally{row.elapsedMs=Date.now()-row.at;}
  };
 }
 return {began,commands,captures,charge,get rejected(){return rejected;},restore(){for(const [method,original]of originals)(BrowserAdapter.prototype as any)[method]=original;}};
}
