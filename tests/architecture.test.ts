import { it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

it('keeps core package imports within its SDK boundary', () => {
  const directory = resolve('packages/core/src');
  const dependencies = JSON.parse(readFileSync('packages/core/package.json', 'utf8')).dependencies;
  expect(Object.keys(dependencies).sort()).toEqual(['@noble/hashes', 'zod']);
  for (const file of readdirSync(directory).filter(f => f.endsWith('.ts'))) {
    const source = ts.createSourceFile(file, readFileSync(resolve(directory, file), 'utf8'), ts.ScriptTarget.Latest);
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = node.moduleSpecifier.text;
        expect(target.startsWith('./') || target === 'zod' || target.startsWith('@noble/hashes/'), `${file} imports ${target}`).toBe(true);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const config = JSON.parse(readFileSync('packages/core/tsconfig.json', 'utf8'));
  expect(config.compilerOptions.lib).toEqual(['ES2023']); expect(config.compilerOptions.types).toEqual([]);
});

it('does not couple persistence plugins to browser or transport packages', () => {
  for (const name of ['storage-memory', 'storage-sqlite']) {
    const deps = JSON.parse(readFileSync(`packages/${name}/package.json`, 'utf8')).dependencies;
    expect(Object.keys(deps).filter(d => /playwright|fastify|browser|client/.test(d))).toEqual([]);
  }
});
