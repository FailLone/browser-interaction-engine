import {canonical,hash} from '@interaction/core';
import {interactionProjection} from './exploration.js';
import type {Control,Observation,NavigationScopeSnapshot} from './types.js';

/** Browser-side, bounded and inert. Only explicit navigation containers qualify.
 * Unresolved references block their dependent subtree, while full lookups remain
 * in evidence. Native fields are captured even when not retained as controls. */
export function collectNavigationScopes(controls:Control[],instance:(el:Element)=>string):NavigationScopeSnapshot[] {
 const result:NavigationScopeSnapshot[]=[],refs=new Set(['for','aria-labelledby','aria-describedby','aria-controls','aria-owns','aria-activedescendant','aria-details','aria-errormessage','headers','list','form','popovertarget','commandfor']);
 const encoder=new TextEncoder();let remaining=196608;
 const navigationRoots=[...document.querySelectorAll('nav,[role="navigation"]')].slice(0,8);
 const roots=new Map<Element,{kind:'navigation'|'disclosure';triggers:Element[];trees:Element[]}>();
 // Bound local result scopes using captured disclosure semantics, never labels,
 // application CSS or guessed URLs. Ancestors and IDREFs remain dependencies.
 const disclosures=[...document.querySelectorAll('[aria-expanded],details>summary')].filter(el=>el.closest('nav,[role="navigation"]'));
 for(const el of disclosures.slice(0,24)){
  const linked=[...(el.getAttribute('aria-controls')||'').split(/\s+/).filter(Boolean)].flatMap(id=>{
   const matches=document.querySelectorAll(`#${CSS.escape(id)}`);return matches.length===1?[matches[0]]:[];
  });
  const root=el.tagName==='SUMMARY'?el.parentElement!:el.hasAttribute('aria-controls')?el:el.closest('li,[role=listitem],[role=treeitem]')||
    (el.children.length&&!el.matches('button,[role=button]')?el:el.parentElement);
  if(!root||root.matches('html,body,main,header'))continue;
  const prior=roots.get(root);if(prior){prior.triggers.push(el);continue;}
  roots.set(root,{kind:'disclosure',triggers:[el],trees:[root,...linked.filter(target=>!root.contains(target))]});
 }
 for(const root of navigationRoots)if(!roots.has(root))roots.set(root,{kind:'navigation',triggers:[],trees:[root]});
 const visible=(el:Element)=>el.checkVisibility()&&!el.closest('[hidden],[aria-hidden=true],[inert]')&&getComputedStyle(el).visibility!=='hidden'&&el.getClientRects().length>0;
 for(const [root,description] of roots){
  const rootId=instance(root),members=controls.filter(c=>description.trees.some(tree=>c.instanceId===instance(tree)||c.domAncestry?.complete&&c.domAncestry.instanceIds.includes(instance(tree))));
  if(!members.length)continue;
  const scope:NavigationScopeSnapshot={rootId,kind:description.kind,triggerIds:description.triggers.map(instance),controlIds:members.map(c=>c.localId),blockedControlIds:[],contentSignals:[],complete:false,reasons:[]};result.push(scope);
  if(description.triggers.length===1){const trigger=description.triggers[0];scope.expanded=trigger.tagName==='SUMMARY'?(trigger.parentElement as HTMLDetailsElement).open:trigger.getAttribute('aria-expanded')==='true';}
  const ancestors:NonNullable<NavigationScopeSnapshot['binding']>['ancestors']=[],references:NonNullable<NavigationScopeSnapshot['binding']>['references']=[],fields:NonNullable<NavigationScopeSnapshot['binding']>['fields']=[];
  const trees=[...description.trees],seen=new Set<Element>(),lookups=new Map<string,Element|undefined>(),blocked=new Set<string>();let nodes=0;
  const associate=(target:Element,id:string)=>{if(!root.contains(target)){if(!trees.includes(target))trees.push(target);if(!references.some(r=>r.id===id))references.push({id,status:'unique',instanceId:instance(target),markup:target.outerHTML});}};
  for(let el=root.parentElement;el;el=el.parentElement){if(ancestors.length>=64){scope.reasons.push('ancestry_bound');break;}ancestors.push({id:instance(el),tag:el.tagName,attributes:Object.fromEntries([...el.attributes].map(a=>[a.name,a.value]))});}
  const scan=(el:Element)=>{
   if(seen.has(el))return;seen.add(el);if(++nodes>512){scope.reasons.push('node_bound');return;}
   const within=description.trees.some(tree=>tree===el||tree.contains(el));
   const busy=el.getAttribute('aria-busy')==='true';
   const progress=el.matches('[role=progressbar],progress')&&!(el instanceof HTMLProgressElement?el.position===1:Number(el.getAttribute('aria-valuenow'))>=Number(el.getAttribute('aria-valuemax')||100)&&el.hasAttribute('aria-valuenow'));
   const live=el.getAttribute('aria-live')&&el.getAttribute('aria-live')!=='off'||el.getAttribute('role')==='status';
   // A visible live-only result is an uncertainty signal, not a claim that its
   // text means "loading". It cannot certify an empty/exhausted disclosure.
   const placeholder=within&&description.kind==='disclosure'&&live&&!members.some(c=>c.visible&&c.enabled&&c.actions.length&&(c.instanceId===instance(el)||c.domAncestry?.instanceIds.includes(instance(el))));
   if((busy||within&&progress||placeholder)&&visible(el)){
    const signal={instanceId:instance(el),kind:busy?'busy' as const:progress?'progress' as const:'live-placeholder' as const,text:(el.textContent||'').slice(0,512)};
    scope.contentSignals!.push(signal);
    for(const c of members)if(description.triggers.some(t=>instance(t)===c.instanceId)||c.instanceId===instance(el)||c.domAncestry?.instanceIds.includes(instance(el)))blocked.add(c.localId);
   }
   if(el.matches('iframe,object,embed,canvas')||el.shadowRoot){scope.reasons.push('non_navigation_dependency');return;}
   if(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement||el instanceof HTMLSelectElement){
    const labels=[...el.labels||[]];fields.push({instanceId:instance(el),value:el.value,formId:el.form?instance(el.form):null,labelIds:labels.map(instance),
      ...(el instanceof HTMLInputElement?{checked:el.checked,indeterminate:el.indeterminate}:{}),...(el instanceof HTMLSelectElement?{selected:[...el.selectedOptions].map(o=>o.value)}:{})});
    if(el.form)associate(el.form,`native-form:${instance(el)}`);for(const label of labels)associate(label,`native-label:${instance(el)}:${instance(label)}`);
   }
   for(const attribute of el.attributes)if(refs.has(attribute.name))for(const token of attribute.value.split(/\s+/).filter(Boolean)){
    if(!lookups.has(token)){
      if(lookups.size>=64){scope.reasons.push('reference_bound');return;}
      const matches=document.querySelectorAll(`#${CSS.escape(token)}`),target=matches.length===1?matches[0]:undefined;lookups.set(token,target);
      if(target)associate(target,token);else references.push({id:token,status:matches.length?'ambiguous':'missing'});
    }
    if(!lookups.get(token))for(const control of members)if(!root.contains(el)||control.instanceId===instance(el)||control.domAncestry?.instanceIds.includes(instance(el)))blocked.add(control.localId);
   }
  };
  for(let el=root.parentElement;el;el=el.parentElement){scan(el);if(scope.reasons.length)break;}
  for(let i=0;i<trees.length&&!scope.reasons.length;i++){const tree=trees[i];scan(tree);for(const el of tree.querySelectorAll('*')){scan(el);if(scope.reasons.length)break;}}
  scope.blockedControlIds=[...blocked];
  if(scope.reasons.length)continue;
  const binding={baseURI:document.baseURI,markup:root.outerHTML,ancestors,references,fields},bytes=encoder.encode(JSON.stringify(binding)).length;
  if(bytes>remaining){scope.reasons.push('byte_bound');continue;}remaining-=bytes;
  scope.blockedControlIds=[...blocked];scope.binding=binding;scope.complete=true;
 }
 for(const el of disclosures.slice(24)){const localId=instance(el);if(controls.some(c=>c.localId===localId&&c.visible))result.push({rootId:localId,kind:'disclosure',triggerIds:[localId],controlIds:[localId],blockedControlIds:[localId],complete:false,reasons:['disclosure_bound']});}
 return result.sort((a,b)=>a.controlIds.length-b.controlIds.length);
}

type View=Pick<Observation,'documentId'|'url'|'controls'|'boundaries'|'scroll'|'navigationScopes'|'regionCandidates'|'structuralLists'|'components'>;
export function navigationScopeFor(o:Pick<Observation,'navigationScopes'|'controls'>,ids:readonly string[]) {
 if(!ids.length)return;
 return o.navigationScopes?.filter(s=>s.complete&&s.binding&&Array.isArray(s.blockedControlIds)&&ids.every(id=>s.controlIds.includes(id))
  &&s.controlIds.every(id=>o.controls.filter(c=>c.localId===id).length===1)).sort((a,b)=>a.controlIds.length-b.controlIds.length)[0];
}
export function navigationScopeProjection(o:View,scope:NavigationScopeSnapshot) {
 const ids=new Set(scope.controlIds),controls=o.controls.filter(c=>ids.has(c.localId));
 return hash(canonical({document:o.documentId,url:o.url,boundaries:o.boundaries,scroll:o.scroll,scope,
  interaction:interactionProjection({...o,controls}),controls:controls.map(c=>[c.instanceId,c.rect,c.visible,c.enabled,c.editable,c.readOnly,c.actionable,c.value,c.checked,c.pressed,c.selected,c.expanded,c.actionBasis,c.reviewBinding,c.reviewAttributes,c.reviewReuseBinding,c.classificationBinding,c.purposeBinding]),
  regions:o.regionCandidates?.filter(c=>c.controlIds.every(id=>ids.has(id))),
  lists:o.structuralLists?.filter(c=>c.members.some(m=>ids.has(m.localId))||c.traversalLocalIds.some(id=>ids.has(id))),
  components:o.components?.filter(c=>c.members.some(m=>ids.has(m.localId)))}));
}
