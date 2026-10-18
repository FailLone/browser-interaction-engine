import {expect,it} from 'vitest';
import {readFragmentMaterial,splitFragmentMaterial} from '../packages/explorer-plugin/src/fragment-codec.js';

it('shares large conditions while reconstructing exact bytes, escapes, order and whitespace',()=>{
  const modes=JSON.stringify(Array.from({length:27},(_,i)=>({binding:`选择器-${i}-\\\"`,state:{selected:['A','B']},relation:'observed-document-mode'})));
  const rawA=` { "name" : "first", "modes" : ${modes}, "tail":"\\u4e2d" }\n`,rawB=`{"modes":${modes},"name":"second"}`;
  const a=splitFragmentMaterial('guard',rawA),b=splitFragmentMaterial('guard',rawB);
  expect(a.atoms).toHaveLength(1);expect(b.atoms[0].id).toBe(a.atoms[0].id);expect(a.material.id).not.toBe(b.material.id);
  for(const [source,parts] of [[rawA,a],[rawB,b]] as const){const atoms=new Map(parts.atoms.map(atom=>[atom.id,atom]));expect(readFragmentMaterial(parts.material,id=>atoms.get(id)!)).toBe(source);}
  expect(splitFragmentMaterial('owner',rawA).material.id).not.toBe(a.material.id);
});
it('rejects missing or corrupt pieces, forged lengths and different bytes under a colliding address',()=>{
  const parts=splitFragmentMaterial('guard',JSON.stringify({a:'A'.repeat(300),b:'B'.repeat(300)})),atoms=new Map(parts.atoms.map(atom=>[atom.id,atom]));
  expect(()=>readFragmentMaterial(parts.material,()=>undefined!)).toThrow('CORRUPT_FRAGMENT_MATERIAL');
  expect(()=>readFragmentMaterial({...parts.material,bytes:parts.material.bytes+1},id=>atoms.get(id)!)).toThrow('CORRUPT_FRAGMENT_MATERIAL');
  expect(()=>readFragmentMaterial(parts.material,id=>({...atoms.get(id)!,raw:'X'.repeat(atoms.get(id)!.raw.length)}))).toThrow('CORRUPT_FRAGMENT_MATERIAL');
  expect(()=>splitFragmentMaterial('guard',JSON.stringify({a:'A'.repeat(300),b:'B'.repeat(300)}),()=> 'collision')).toThrow('FRAGMENT_MATERIAL_HASH_CONFLICT');
});
it('preserves short and legacy non-object material and rejects malformed object input',()=>{
  for(const raw of ['', '/buy', '[["a[1]","button"]]', '{"nested":{"x":["\\\"",false,null]}}']){
    const parts=splitFragmentMaterial('structure',raw);expect(readFragmentMaterial(parts.material,()=>{throw Error('unexpected atom');})).toBe(raw);
  }
  expect(()=>splitFragmentMaterial('guard','{"a":[')).toThrow('CORRUPT_FRAGMENT_MATERIAL');
});
