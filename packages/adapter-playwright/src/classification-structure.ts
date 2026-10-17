import type {Control,Observation} from './types.js';
/** Structural classification keeps every node and actionable attribute. Native
 * passive readout names/values are evidence, not changes to the containing
 * element's interaction role. Explicit target facts remain exact. */
export function classificationStructure(c:Control,o:Observation):Control['classificationBinding'] {
 const structure=c.classificationBinding;if(!structure)return;
 const passive=new Set(o.controls.filter(x=>x.localId!==c.localId&&x.nativeReadOnly===true&&x.readOnly&&['input','textarea'].includes(x.tag)&&x.actions.length>0&&x.actions.every(k=>k==='fill')).map(x=>x.instanceId));
 if(!passive.size)return structure;
 return {...structure,nodes:structure.nodes.map(n=>{if(!passive.has(n.instanceId))return n;const {value:_value,'aria-label':_label,...attributes}=n.attributes;return {...n,attributes};})};
}
