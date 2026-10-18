import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {BrowserEngine} from '@interaction/browser';
import {BrowserAdapter} from './packages/adapter-playwright/src/browser.ts';
import {SqliteStore} from '@interaction/storage-sqlite';
const dir=process.argv[2],protocol=JSON.parse(readFileSync(join(dir,'protocol.json'),'utf8')),budgetPath=join(dir,'budget.json');
const log=(type:string,data:unknown)=>appendFileSync(join(dir,'timeline.jsonl'),JSON.stringify({at:Date.now(),type,data})+'\n');
const count=()=>{const b=JSON.parse(readFileSync(budgetPath,'utf8'));if(Date.now()>=b.deadline||b.actions>=80)throw Error('ACCEPTANCE_BUDGET');b.actions++;writeFileSync(budgetPath,JSON.stringify(b));return b.actions;};
const allowed=(url:string)=>{const u=new URL(url);return u.protocol==='https:'&&u.hostname==='www.okx.com'&&/^\/(?:[a-z]{2}(?:-[a-z]+)?\/)?(?:convert\/usd-to-btc|trade-convert|trade-spot(?:\/btc-usdt)?)\/?$/.test(u.pathname);};
const inventory=()=>({url:location.href,title:document.title,controls:[...document.querySelectorAll('a,button,input,[role="menuitem"],[role="dialog"]')].filter(e=>e.checkVisibility()).map(e=>({tag:e.tagName,role:e.getAttribute('role'),text:(e.getAttribute('aria-label')||e.textContent||'').trim().slice(0,250),href:e.getAttribute('href'),checked:e instanceof HTMLInputElement?e.checked:undefined}))});
const start=BrowserAdapter.prototype.start,execute=BrowserAdapter.prototype.execute;
BrowserAdapter.prototype.start=async function(){log('browser.navigation',{number:count()});await start.call(this);await this.page!.route('**/*',async route=>{const r=route.request();if(r.isNavigationRequest()&&r.frame()===this.page!.mainFrame()&&!allowed(r.url())){log('scope.navigation_refused',{url:r.url()});await route.abort('blockedbyclient');}else await route.continue();});log('dom.initial',await this.page!.evaluate(inventory));};
BrowserAdapter.prototype.execute=async function(action,control){
 const number=count(),url=this.page!.url(),href=control?.tag==='a'?await this.page!.locator(control.selector).getAttribute('href'):undefined;
 const forbidden=/登录|注册|登陆|购买|卖出|买入|下单|确认交易|身份认证|居住|地区|国家|log\s*in|sign\s*(in|up)|place order|buy now|sell now|verify identity|country|residen/i.test(action.label||'');
 const allowedCheck=action.kind==='check'&&action.value===true&&control?.tag==='input'&&control.role==='checkbox'&&protocol.coverageContract.noticePreferences.includes(control.name)&&control.form==='document'&&engine.observation(action.sessionId).overlays?.at(-1)?.controlIds.includes(control.localId);
 const denied=!allowed(url)||!['click','check','hover','focus','scroll','history','press','dismiss'].includes(action.kind)||action.kind==='check'&&!allowedCheck||action.risk!=='interface'||forbidden||!!href&&!allowed(new URL(href,url).href)||action.kind==='press'&&!['Escape','Tab'].includes(String(action.value));
 log('browser.dispatch',{number,action,control,guardAllowed:!denied});if(denied){log('scope.dispatch_refused',{number,actionId:action.id,reason:'outside_public_navigation_authorization'});throw Error('OUTSIDE_PUBLIC_NAVIGATION_SCOPE');}
 log('dom.before',{number,actionId:action.id,inventory:await this.page!.evaluate(inventory)});
 try{await execute.call(this,action,control);log('browser.executed',{number,actionId:action.id,inventory:await this.page!.evaluate(inventory)});}catch(error){log('browser.error',{number,error:String(error)});throw error;}
};
const persistence=new SqliteStore(join(dir,'engine')),engine=new BrowserEngine({persistence});
let sid:string|undefined;
const timer=setTimeout(()=>{log('window.cooperative_stop',{reason:'reserve_final_durable_audit'});if(sid)void engine.pause(sid);},Math.max(1,JSON.parse(readFileSync(budgetPath,'utf8')).began+210000-Date.now()));
try{const s=await engine.createSession({url:protocol.entry,headless:true,settleMs:200,observeTimeoutMs:5000,actionTimeoutMs:8000,maxActions:80,maxDepth:30,maxDurationMs:210000});sid=s.id;writeFileSync(join(dir,'session-id'),sid);await engine.explore(sid);await engine.waitForIdle();}
catch(error){log('worker.error',{error:String(error)});}
finally{clearTimeout(timer);if(sid){writeFileSync(join(dir,'session-final.json'),JSON.stringify(engine.session(sid),null,2));writeFileSync(join(dir,'attempts.json'),JSON.stringify(engine.list(sid,'attempt'),null,2));writeFileSync(join(dir,'events.json'),JSON.stringify(persistence.events(sid),null,2));writeFileSync(join(dir,'frontier.json'),JSON.stringify(engine.list(sid,'frontier'),null,2));log('worker.settled',{status:engine.session(sid).status,reason:engine.session(sid).stopReason});}await engine.close();}
