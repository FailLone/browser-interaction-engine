import {canonical,hash} from '@interaction/core';
import {interactionProjection} from './exploration.js';
import type {Control,Observation,NavigationScopeSnapshot} from './types.js';

/** Browser-side, bounded and inert. Only explicit navigation containers qualify.
 * Missing references, forms, embedded content or bounds leave the scope unknown. */
export function collectNavigationScopes(controls:Control[],instance:(el:Element)=>string):NavigationScopeSnapshot[] {
 const result:NavigationScopeSnapshot[]=[],refs=new Set(['for','aria-labelledby','aria-describedby','aria-controls','aria-owns','aria-activedescendant','aria-details','aria-errormessage','headers','list','form','popovertarget','commandfor']);
 const encoder=new TextEncoder();let remaining=196608;
 for(const root of [...document.querySelectorAll('nav,[role="navigation"]')].slice(0,8)){
  const rootId=instance(root),members=controls.filter(c=>c.instanceId===rootId||c.domAncestry?.complete&&c.domAncestry.instanceIds.includes(rootId));
  if(!members.length)continue;
  const scope:NavigationScopeSnapshot={rootId,controlIds:members.map(c=>c.localId),complete:false,reasons:[]};result.push(scope);
  const ancestors:NonNullable<NavigationScopeSnapshot['binding']>['ancestors']=[],references:NonNullable<NavigationScopeSnapshot['binding']>['references']=[];
  const trees=[root],seen=new Set<Element>(),lookups=new Set<string>();let nodes=0;
  for(let el=root.parentElement;el;el=el.parentElement){if(ancestors.length>=64){scope.reasons.push('ancestry_bound');break;}ancestors.push({id:instance(el),tag:el.tagName,attributes:Object.fromEntries([...el.attributes].map(a=>[a.name,a.value]))});}
  const scan=(el:Element)=>{
   if(seen.has(el))return;seen.add(el);if(++nodes>512){scope.reasons.push('node_bound');return;}
   if(el.matches('input,select,textarea,form,iframe,object,embed,canvas')||el.shadowRoot){scope.reasons.push('non_navigation_dependency');return;}
   for(const attribute of el.attributes)if(refs.has(attribute.name))for(const token of attribute.value.split(/\s+/).filter(Boolean)){
    if(lookups.has(token))continue;lookups.add(token);
    if(lookups.size>64){scope.reasons.push('reference_bound');return;}
    const matches=document.querySelectorAll(`#${CSS.escape(token)}`);
    if(matches.length!==1){scope.reasons.push('unresolved_reference');continue;}
    const target=matches[0];if(!root.contains(target)&&!trees.includes(target)){trees.push(target);references.push({id:token,instanceId:instance(target),markup:target.outerHTML});}
   }
  };
  for(let el=root.parentElement;el;el=el.parentElement){scan(el);if(scope.reasons.length)break;}
  for(let i=0;i<trees.length&&!scope.reasons.length;i++){const tree=trees[i];scan(tree);for(const el of tree.querySelectorAll('*')){scan(el);if(scope.reasons.length)break;}}
  if(scope.reasons.length)continue;
  const binding={markup:root.outerHTML,ancestors,references},bytes=encoder.encode(JSON.stringify(binding)).length;
  if(bytes>remaining){scope.reasons.push('byte_bound');continue;}remaining-=bytes;
  scope.binding=binding;scope.complete=true;
 }
 return result;
}

type View=Pick<Observation,'documentId'|'url'|'controls'|'boundaries'|'scroll'|'navigationScopes'|'regionCandidates'|'structuralLists'|'components'>;
export function navigationScopeFor(o:Pick<Observation,'navigationScopes'|'controls'>,ids:readonly string[]) {
 if(!ids.length)return;
 return o.navigationScopes?.filter(s=>s.complete&&s.binding&&ids.every(id=>s.controlIds.includes(id))
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
