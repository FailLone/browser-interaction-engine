// Audit the crawler's component classes on live OKX pages: over-merges (distinct
// controls sharing a class) and under-merges (one control changing class).
import {BrowserAdapter,PlaywrightAdapter} from '@interaction/adapter-playwright';
import {MemoryEvidenceStore} from '@interaction/storage-memory';
import {controlClass} from '@interaction/crawler';
const pages=['https://www.okx.com/convert/usd-to-btc','https://www.okx.com/price/bitcoin-btc'];
for(const url of pages){
 const a=new BrowserAdapter(new PlaywrightAdapter().parseOptions({url,headless:true,listExploration:'review'}),new MemoryEvidenceStore());
 await a.start();await a.page!.waitForTimeout(2000);
 const take=async()=>((await a.readDOM(false,false)) as any).controls.filter((c:any)=>c.visible&&c.actions.length);
 const first=await take();
 const groups=new Map<string,any[]>();for(const c of first){const k=controlClass(c);groups.set(k,[...(groups.get(k)||[]),c]);}
 const multi=[...groups.entries()].filter(([,v])=>v.length>1);
 const listDiffNames=multi.filter(([k,v])=>k.startsWith('list:')&&new Set(v.map((c:any)=>c.name)).size>1);
 const nonListDiffRegion=multi.filter(([k,v])=>!k.startsWith('list:')&&new Set(v.map((c:any)=>c.region)).size>1);
 console.log('\n==',url.split('okx.com')[1],'actionable',first.length,'classes',groups.size);
 console.log(' list classes merging differently-named members:',listDiffNames.length);
 for(const [k,v] of listDiffNames.slice(0,6))console.log('   ',v.length,'members e.g.',[...new Set(v.map((c:any)=>c.name.slice(0,18)))].slice(0,5).join(' | '));
 console.log(' non-list classes merging controls in different regions:',nonListDiffRegion.length);
 for(const [k,v] of nonListDiffRegion.slice(0,6))console.log('   ',JSON.stringify(k.slice(0,60)),'x',v.length);
 // Under-merge: same DOM instance gets a different class after ~5s of live updates.
 await a.page!.waitForTimeout(5000);const second=await take();
 const byInst=new Map(first.map((c:any)=>[c.instanceId,controlClass(c)]));
 const changed=second.filter((c:any)=>byInst.has(c.instanceId)&&byInst.get(c.instanceId)!==controlClass(c));
 console.log(' same element, class changed after 5s:',changed.length,changed.slice(0,4).map((c:any)=>byInst.get(c.instanceId)!.slice(-30)+' -> '+controlClass(c).slice(-30)));
 await a.close();
}
