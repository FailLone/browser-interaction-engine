// Can Playwright stop a navigation while keeping the current document and reporting the target?
import {createServer} from 'node:http';
import {chromium} from 'playwright';
const html=`<!doctype html><title>Home</title><main><input id="v" value="typed state">
<a href="/other">Plain link</a><button onclick="location.href='/scripted'">Scripted</button>
<form action="/submit"><button>Form</button></form><a href="#section">Hash</a>
<button onclick="history.pushState({},'','/spa-route')">Push</button><a href="/blank" target="_blank">Blank</a></main>`;
const s=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(req.url==='/'?html:'<title>Other</title>other');});
await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+(s.address() as any).port;
const b=await chromium.launch();const ctx=await b.newContext();const p=await ctx.newPage();
const events:string[]=[];let allow=true;
await p.route('**/*',async route=>{const r=route.request();
  if(r.isNavigationRequest()&&r.frame()===p.mainFrame()&&!allow){events.push('intercepted '+r.method()+' '+new URL(r.url()).pathname);await route.abort('aborted');}
  else await route.continue();});
ctx.on('page',np=>{events.push('popup '+np.url());void np.close();});
p.on('framenavigated',f=>{if(f===p.mainFrame())events.push('framenavigated '+new URL(f.url()).pathname+new URL(f.url()).hash);});
await p.goto(base+'/');allow=false;
const doc=()=>p.evaluate('window.__doc ??= Math.random()');const d0=await doc();
for(const name of ['Plain link','Scripted','Form','Hash','Push','Blank']){
  events.length=0;
  const loc=(name==='Plain link'||name==='Hash'||name==='Blank'?p.getByRole('link',{name}):p.getByRole('button',{name}));
  const box=(await loc.boundingBox())!;await p.mouse.click(box.x+box.width/2,box.y+box.height/2);
  await p.waitForTimeout(500);
  console.log(name.padEnd(10),'url',new URL(p.url()).pathname+new URL(p.url()).hash,'| same document',(await doc())===d0,'| input kept',await p.inputValue('#v'),'|',events.join('; '));
}
await b.close();s.close();
