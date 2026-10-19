import { BrowserDriver, stateKey } from '@interaction/crawler';
import { createHash } from 'node:crypto';
const a = new BrowserDriver({ url: 'https://www.okx.com/convert/usd-to-btc', headless: true });
await a.start();
await a.page!.waitForTimeout(2500);
const p = a.page!;
const close = p.getByRole('button', { name: 'Close' }).first();
await close.click().catch(() => {});
await p.waitForTimeout(500);
const tab = p.getByRole('tab', { name: '1W' }).first();
await tab.scrollIntoViewIfNeeded();
await p.waitForTimeout(800);
const chart = (await p.evaluate(
  `(()=>{const t=[...document.querySelectorAll('[role=tab]')].find(e=>e.textContent.trim()==='1W');let e=t;for(let i=0;i<10&&e;i++){if(e.querySelector('canvas,svg path'))break;e=e.parentElement;}const r=e.getBoundingClientRect();return {x:r.x,y:Math.max(0,r.y),width:r.width,height:Math.min(r.height,800),found:!!e.querySelector('canvas,svg path')};})()`,
)) as any;
console.log('chart box', chart);
const snap = async () => {
  const d: any = await a.readDOM();
  const img = await p.screenshot({ clip: { x: chart.x, y: chart.y, width: chart.width, height: chart.height } });
  return {
    key: stateKey({ url: d.url, title: d.title, text: d.text, controls: d.controls, overlays: d.overlays }),
    img,
    text: d.text,
  };
};
// Small grayscale thumbnail histogram distance (no extra deps): compare raw PNG via canvas in page.
const diffSrc = `async ([u,v])=>{const load=(s)=>new Promise(r=>{const i=new Image();i.onload=()=>{const c=document.createElement('canvas');c.width=32;c.height=16;const g=c.getContext('2d');g.drawImage(i,0,0,32,16);r(g.getImageData(0,0,32,16));};i.src='data:image/png;base64,'+s;});const A=await load(u),B=await load(v);let d=0;for(let k=0;k<A.data.length;k+=4)d+=Math.abs(A.data[k]-B.data[k]);return d/(A.data.length/4)/255;}`;
const diff = async (x: Buffer, y: Buffer) =>
  p.evaluate(`(${diffSrc})(${JSON.stringify([x.toString('base64'), y.toString('base64')])})`) as Promise<number>;
await p.screenshot({
  path: 'work/claude-probe/chart-before.png',
  clip: { x: chart.x, y: chart.y, width: chart.width, height: chart.height },
});
const s0 = await snap();
await p.waitForTimeout(3000);
const s1 = await snap();
await tab.click();
await p.waitForTimeout(2500);
const s2 = await snap();
await p.screenshot({
  path: 'work/claude-probe/chart-1w.png',
  clip: { x: chart.x, y: chart.y, width: chart.width, height: chart.height },
});
console.log(
  'idle 3s   : stateKey same',
  s0.key === s1.key,
  '| pixel diff',
  (await diff(s0.img, s1.img)).toFixed(3),
  '| text same',
  s0.text === s1.text,
);
console.log(
  'click 1W  : stateKey same',
  s1.key === s2.key,
  '| pixel diff',
  (await diff(s1.img, s2.img)).toFixed(3),
  '| text same',
  s1.text === s2.text,
);
console.log(
  'png bytes identical idle',
  createHash('md5').update(s0.img).digest('hex') === createHash('md5').update(s1.img).digest('hex'),
);
await a.close();
