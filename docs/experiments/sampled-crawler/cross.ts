// Same component across documents: reload the page and navigate to a sibling page;
// count how many classes survive (same class = crawler treats it as already sampled).
import { BrowserDriver, controlClass, stateKey } from '@interaction/crawler';
const a = new BrowserDriver({ url: 'https://www.okx.com/convert/usd-to-btc', headless: true });
await a.start();
const take = async () => {
  await a.page!.waitForTimeout(2500);
  const d: any = await a.readDOM();
  const cs = d.controls.filter((c: any) => c.visible && c.actions.length);
  return {
    classes: new Set(cs.map(controlClass)),
    chrome: new Set(cs.filter((c: any) => c.landmark).map(controlClass)),
    key: stateKey({ url: d.url, title: d.title, controls: d.controls, overlays: d.overlays }),
    doc: d.documentId,
  };
};
const A = await take();
await a.page!.reload();
const B = await take();
await a.page!.goto('https://www.okx.com/convert/eur-to-btc');
const C = await take();
await a.page!.goto('https://www.okx.com/price/bitcoin-btc');
const D = await take();
const j = (x: Set<string>, y: Set<string>) => `${[...x].filter(k => y.has(k)).length}/${x.size}`;
console.log(
  'reload: same doc?',
  A.doc === B.doc,
  'classes kept',
  j(A.classes, B.classes),
  'state key equal',
  A.key === B.key,
);
console.log('sibling /convert/eur-to-btc: classes kept', j(A.classes, C.classes), 'chrome kept', j(A.chrome, C.chrome));
console.log('other template /price: chrome kept', j(A.chrome, D.chrome));
const lost = [...A.classes].filter(k => !B.classes.has(k));
console.log('lost on reload', lost.slice(0, 6));
await a.close();
