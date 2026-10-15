import type { Control, StructuralListCandidate } from './types.js';

/** Runs in the page. Repetition is a review prompt, never a business-purpose grant. */
export function discoverStructuralLists(elements: Element[], selected: Set<Element>, instance: (el: Element) => string, selector: (el: Element) => string, capabilities: (el: Element) => {actions:string[]}) {
  const clean=(s:string|null|undefined)=>(s||'').replace(/\s+/g,' ').trim();
  const label=(el:Element)=>clean(el.getAttribute('aria-label'))||clean((el.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>document.getElementById(id)?.textContent||'').join(' '));
  const visible=(el:Element)=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&!el.closest('[hidden],[inert]');};
  const atomic='a[href],button,input,select,textarea,[role=button],[role=link],[role=option],[role=checkbox],[role=radio],[role=switch],[contenteditable=true]';
  const scope='[role=listbox],select,dialog,[role=dialog],[role=alertdialog],[role=menu],[popover]';
  const tracker=(window as any).__interactionEvidenceTracker;
  type Remembered={template:string;slots:string[];qualification:{rowInstanceIds:string[];semanticOwner:boolean}};
  const history:WeakMap<Element,Map<string,Remembered>>=tracker.structuralLists??=new WeakMap();
  const byElement=new Set(elements);
  const limits={templatesTruncated:0,collectionsTruncated:false};
  const path=(root:Element,el:Element)=>{const parts:number[]=[];for(let n=el;n!==root;){const p=n.parentElement;if(!p)return '';parts.unshift([...p.children].indexOf(n));n=p;}return parts.join('/');};
  const targetElements=(row:Element)=>[...selected].filter(el=>(el===row||row.contains(el))&&!el.closest('[role=listbox],select')&&visible(el)&&capabilities(el).actions.length>0);
  const structure=(root:Element)=>{
    let count=0,limited=false;
    const walk=(el:Element,depth:number):unknown=>{
      if(++count>100||depth>8){limited=true;return null;}
      if(el!==root&&el.matches(scope))return ['independent-scope',el.tagName,el.getAttribute('role')];
      return [el.tagName,el.getAttribute('role')||'',el.getAttribute('type')||'',el.hasAttribute('href'),el.hasAttribute('contenteditable'),
        [...el.children].filter(c=>!c.matches('script,style,[hidden],[aria-hidden=true]')).map(c=>walk(c,depth+1))];
    };
    const value=walk(root,0);if(limited)limits.templatesTruncated++;return limited?undefined:JSON.stringify(value);
  };
  const recordKey=(row:Element)=>{
    const declared=['data-row-key','data-item-key','data-key'].find(k=>row.hasAttribute(k));
    if(declared)return JSON.stringify([declared,row.getAttribute(declared)]);
    const links=[...(row.matches('a[href]')?[row]:[]),...row.querySelectorAll('a[href]')].filter(el=>!el.parentElement?.closest('[role=listbox]'));
    if(links.length===1)return JSON.stringify(['href',links[0].getAttribute('href')]);
    const copy=row.cloneNode(true) as Element;
    copy.querySelectorAll('input,select,textarea,button,[role=button],[role=checkbox],[role=switch],script,style,[hidden],[aria-hidden=true],[role=tooltip],dialog,[role=dialog],[role=menu],[role=listbox],[popover]').forEach(el=>el.remove());
    const text=label(row)||clean(copy.textContent);
    return text&&text.length<=500?JSON.stringify(['description',text]):undefined;
  };
  const result:{owner:Element;template:string;qualification:Remembered['qualification'];members:{element:Element;row:Element;slot:string;recordKey?:string}[];binding:StructuralListCandidate['binding'];label:string;selector:string}[]=[];
  for(const owner of elements){
    // A semantic row owns fields, not repeated records. Its inherited pointer
    // cursor must not promote price/status cells to independent click targets
    // or turn changing cell text into record keys. Explicit cell operations
    // and nested collections are still discovered through their own elements.
    if(owner.matches('tr,[role=row]'))continue;
    if(owner===document.body||owner===document.documentElement||owner.matches(atomic)||owner.closest('[role=listbox],select')||!visible(owner)&&!history.has(owner))continue;
    const children=[...owner.children].filter(el=>!el.matches('script,style')&&visible(el));
    if(children.length<2&&!history.has(owner))continue;
    const buckets=new Map<string,{row:Element;targets:Element[]}[]>();
    for(const row of children){
      if(!byElement.has(row)||row.matches('h1,h2,h3,h4,h5,h6,[role=heading]'))continue;
      let targets=targetElements(row);
      // Repeated custom pointer rows are only tentative targets, even when the
      // pointer cursor is inherited from the collection owner.
      if(!targets.length&&getComputedStyle(row).cursor==='pointer'&&clean(row.textContent))targets=[row];
      if(!targets.length)continue;
      const template=structure(row);if(!template)continue;
      const bucket=buckets.get(template)||[];bucket.push({row,targets});buckets.set(template,bucket);
    }
    const remembered=history.get(owner)||new Map<string,Remembered>();
    for(const [template,rows] of buckets){
      const semantic=owner.matches('ul,ol,table,tbody,[role=list],[role=grid],[role=tree],[role=menu]');
      // Flat ordinary button bars are not inferred lists. Explicit lists and
      // repeated record wrappers/links/custom rows can provide ownership proof.
      const eligible=rows.every(({row})=>!row.matches('label,button,input,select,textarea,[role=button],[role=checkbox],[role=radio],[role=switch]'));
      if(!eligible||rows.length<(semantic?2:3))continue;
      const slots=[...new Set(rows.flatMap(({row,targets})=>targets.map(el=>path(row,el))))];
      if(!remembered.has(template))remembered.set(template,{template,slots,qualification:{rowInstanceIds:rows.map(({row})=>instance(row)),semanticOwner:semantic}});
    }
    if(!remembered.size)continue;history.set(owner,remembered);
    const ancestry:string[]=[];for(let p:Element|null=owner;p&&p!==document.documentElement;p=p.parentElement)ancestry.push(instance(p));
    for(const {template,slots,qualification} of remembered.values()){
      const rows=buckets.get(template)||[];
      const members=rows.flatMap(({row,targets})=>targets.filter(el=>slots.includes(path(row,el))).map(element=>({element,row,slot:path(row,element),recordKey:recordKey(row)})));
      if(result.length>=300){limits.collectionsTruncated=true;break;}
      result.push({owner,template,qualification,members,binding:{ownerInstanceId:instance(owner),ancestry,tag:owner.tagName.toLowerCase(),role:owner.getAttribute('role')||'',label:label(owner),template,templatePresent:rows.length>0||buckets.size===0},
        label:label(owner)||'Repeated record controls',selector:selector(owner)});
    }
  }
  // Prefer the nearest repeated record: an enclosing repeated section is a
  // separate region, not another list membership for all its descendants.
  for(const candidate of result)candidate.members=candidate.members.filter(m=>!result.some(other=>other!==candidate&&candidate.owner.contains(other.owner)&&candidate.owner!==other.owner&&other.members.some(n=>n.element===m.element)));
  return {candidates:result,limits};
}

/** Serialize the discovered DOM relationships after the ordinary control scan. */
export function describeStructuralLists(scan:ReturnType<typeof discoverStructuralLists>,controls:Control[],elements:Element[],instance:(el:Element)=>string):StructuralListCandidate[]{
  const byId=new Map(controls.map(c=>[c.instanceId,c]));
  const elementById=new Map(elements.map(el=>[instance(el),el]));
  return scan.candidates.map(candidate=>{
    const members=candidate.members.flatMap(m=>{const c=byId.get(instance(m.element));return c?.visible&&!c.list?[{localId:c.localId,rowInstanceId:instance(m.row),slot:m.slot,...(m.recordKey?{recordKey:m.recordKey}:{})}]:[];});
    const traversalLocalIds=controls.filter(c=>c.scroll&&elementById.get(c.instanceId)?.contains(candidate.owner)).map(c=>c.localId);
    return {ownerInstanceId:instance(candidate.owner),ownerSelector:candidate.selector,label:candidate.label,template:candidate.template,binding:candidate.binding,members,traversalLocalIds,
      evidence:[{source:'dom',rule:'repeated-record-list/v1',facts:{ownerInstanceId:instance(candidate.owner),ownerSelector:candidate.selector,template:candidate.template,
        qualification:candidate.qualification,members,
        meaning:'Repeated sibling records and corresponding control slots; business similarity, total size and operation purpose require caller judgment'}}]};
  });
}
