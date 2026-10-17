import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { build } from 'vite';

it('bundles the explorer UI without importing server-only plan dependencies',async()=>{
  const built=await build({configFile:false,logLevel:'silent',resolve:{conditions:['development']},build:{write:false,minify:false,
    lib:{entry:resolve('packages/explorer-plugin/src/ui.tsx'),formats:['es'],fileName:'explorer-ui'},rollupOptions:{external:['react']}}});
  const outputs=Array.isArray(built)?built:[built],chunks=outputs.flatMap(output=>'output' in output?output.output:[]).filter(output=>output.type==='chunk');
  expect(chunks.some(chunk=>chunk.code.includes('ExplorerWorkspace'))).toBe(true);
  expect(chunks.flatMap(chunk=>chunk.imports).filter(name=>name.startsWith('node:'))).toEqual([]);
  expect(chunks.some(chunk=>chunk.code.includes('__vite-browser-external'))).toBe(false);
});
