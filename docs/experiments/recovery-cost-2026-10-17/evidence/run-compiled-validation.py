"""Build an exact commit in an owned archive and retain compiled smoke evidence."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--repo', required=True)
parser.add_argument('--revision', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
repo, output = Path(args.repo).resolve(), Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=True)
node_dir = Path('/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin')
env = dict(os.environ, PATH=f'{node_dir}:{os.environ["PATH"]}')
env.pop('NODE_OPTIONS', None)
env.pop('NODE_PATH', None)
node = str(node_dir / 'node')
pnpm = shutil.which('pnpm', path=env['PATH'])
assert pnpm
revision = subprocess.check_output(['git', 'rev-parse', args.revision], cwd=repo, text=True).strip()
prepare = repo / 'docs/experiments/pending-delta-2026-10-17/evidence/prepare-baseline.py'
setup = json.loads(subprocess.check_output([sys.executable, str(prepare), '--repo', str(repo), '--revision', revision], text=True))
root = Path(setup['sourceRoot']).resolve()
assert root != repo and root.name.startswith('bie-pending-baseline-reproduction-')
commands = []

def save(name, value):
    (output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

source_names = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', revision, '--',
    'packages', 'apps', 'scripts', 'tests', 'examples', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    'tsconfig.json', 'tsconfig.build.json', 'vitest.config.ts'], cwd=repo, text=True).splitlines()

def source_hashes():
    return {name: digest(root / name) for name in source_names}

def run(name, command):
    start = time.time()
    with (output / f'{name}.log').open('w') as log:
        result = subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
    commands.append({'name': name, 'command': command, 'cwd': str(root), 'startedAtEpoch': start,
        'elapsedSeconds': time.time() - start, 'exitCode': result.returncode, 'log': f'{name}.log'})
    save('commands.json', commands)
    print(json.dumps({'command': name, 'exitCode': result.returncode}), flush=True)
    if result.returncode:
        raise RuntimeError(f'{name} exited {result.returncode}; see retained log')

try:
    bin_links = {'tsc': '../typescript/bin/tsc', 'tsserver': '../typescript/bin/tsserver',
        'vite': '../vite/bin/vite.js', 'tsx': '../tsx/dist/cli.mjs', 'vitest': '../vitest/vitest.mjs',
        'playwright': '../playwright/cli.js'}
    binaries = root / 'node_modules/.bin'
    binaries.mkdir(exist_ok=True)
    for name, target in bin_links.items():
        (binaries / name).symlink_to(target)
    module_dirs = [root / 'node_modules'] + [p for top in ['packages', 'apps'] for p in (root / top).glob('*/node_modules')]
    links = []
    for modules in module_dirs:
        namespace = modules / '@interaction'
        if namespace.is_dir():
            for package in namespace.iterdir():
                resolved = package.resolve()
                inside = root in resolved.parents
                links.append({'link': str(package.relative_to(root)), 'resolved': str(resolved), 'insideArchive': inside})
                assert inside, f'Workspace dependency escapes archive: {package}'
    before = source_hashes()
    save('source-before.json', before)
    setup.update({'node': node, 'sourceFileCount': len(before), 'workspaceDependencyLinks': links, 'binLinks': bin_links,
        'dependencyIsolation': 'Workspace modules resolve into this archive; third-party packages are read-only shared links. Private .bin symlinks bypass original pnpm wrappers. Child NODE_PATH/NODE_OPTIONS unset.'})
    save('setup.json', setup)
    run('build', [pnpm, 'build'])
    modules = ['@interaction/core', '@interaction/browser', '@interaction/explorer-plugin', '@interaction/storage-sqlite',
        '@interaction/storage-memory', '@interaction/storage-retained', '@interaction/adapter-playwright']
    code = 'console.log(JSON.stringify(Object.fromEntries(' + json.dumps(modules) + '.map(name => [name, import.meta.resolve(name)]))))'
    resolved = json.loads(subprocess.check_output([node, '--input-type=module', '-e', code], cwd=root, env=env, text=True))
    for value in resolved.values():
        assert str(root) in value and '/dist/' in value, value
    save('compiled-module-paths.json', resolved)
    compiled = {}
    for directory in [root / 'dist'] + [p for top in ['packages', 'apps'] for p in (root / top).glob('*/dist')]:
        for path in directory.rglob('*'):
            if path.is_file():
                compiled[str(path.relative_to(root))] = {'bytes': path.stat().st_size, 'sha256': digest(path)}
    save('compiled-files.json', compiled)
    (root / '.data').mkdir(exist_ok=True)
    public_contract = r'''
import assert from 'node:assert/strict';
import ts from 'typescript';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { InteractionEngine } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { RetainedPersistence } from '@interaction/storage-retained';
const file = resolve('.data/navigation-public-types.mts');
writeFileSync(file, `
import { BoundedEntityChanges, type EntityChanges, type Persistence } from '@interaction/core';
import type { BrowserEngine } from '@interaction/browser';
import type { RetainedPersistence } from '@interaction/storage-retained';
declare const engine: BrowserEngine, retained: RetainedPersistence, store: Persistence;
type NotAny<T> = 0 extends (1 & T) ? false : true;
type Assert<T extends true> = T;
type FeedIsTyped = Assert<NotAny<ReturnType<NonNullable<Persistence['entityChanges']>>>>;
const changes: EntityChanges | undefined = store.entityChanges?.('attempt', 's');
const wrapped: EntityChanges | undefined = retained.entityChanges?.('attempt', 's');
const browser: EntityChanges | undefined = engine.store.entityChanges?.('attempt', 's');
const cacheable: false | undefined = changes?.cacheable;
new BoundedEntityChanges().changes('attempt', 's');
`);
const options = {module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022, strict: true, skipLibCheck: true, noEmit: true, types: ['node'], customConditions: []};
const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([file], options));
if (diagnostics.length) throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCurrentDirectory: ts.sys.getCurrentDirectory, getCanonicalFileName: x => x, getNewLine: () => '\n'}));
const backing = new MemoryStore(), engine = new InteractionEngine({ persistence: backing });
try {
  assert.equal(typeof engine.store.entityChanges, 'function');
  const initial = engine.store.entityChanges('attempt', 'fixture-session');
  backing.put('attempt', { id: 'fixture-attempt', sessionId: 'fixture-session', status: 'unknown' });
  const delta = engine.store.entityChanges('attempt', 'fixture-session', initial.token);
  assert.equal(delta.reset, false); assert.deepEqual(delta.ids, ['fixture-attempt']);
  const legacy = new Proxy(new MemoryStore(), {get(target, key) {
    if (key === 'entityChanges') return undefined;
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  }});
  const wrapper = new RetainedPersistence(legacy, { sweepIntervalMs: 0 });
  try { assert.equal(wrapper.entityChanges, undefined); } finally { wrapper.close(); }
  console.log('Compiled navigation feed public types, BrowserEngine forwarding, and legacy fallback: passed');
} finally { await engine.close(); }
'''
    (root / '.data/compiled-navigation-contract.mjs').write_text(public_contract)
    (output / 'compiled-navigation-contract.mjs').write_text(public_contract)
    run('navigation-public-contract', [node, '.data/compiled-navigation-contract.mjs'])
    run('smoke-built', [node, 'scripts/smoke-built.mjs'])
    shutil.copy2(root / 'docs/build-smoke.json', output / 'build-smoke.json')
    run('smoke-explorer', [node, 'scripts/smoke-explorer.mjs'])
    reports = list((root / '.data').glob('explorer-smoke-*/report.json'))
    assert len(reports) == 1
    report = json.loads(reports[0].read_text())
    shutil.copy2(reports[0], output / 'explorer-smoke.json')
    screenshot = Path(report['screenshot']).resolve()
    assert root in screenshot.parents
    shutil.copy2(screenshot, output / 'explorer-dashboard.png')
    save('artifact-map.json', {'rawReport': 'explorer-smoke.json', 'originalScreenshotPath': report['screenshot'], 'retainedScreenshot': 'explorer-dashboard.png'})
    after = source_hashes()
    save('source-after.json', after)
    assert before == after, 'Source changed during isolated build/smokes'
    save('summary.json', {'revision': revision, 'sourceFiles': len(before), 'sourceUnchanged': True,
        'workspaceDependencyLinks': len(links), 'allWorkspaceLinksInsideArchive': True, 'compiledFilesRecorded': len(compiled),
        'build': 'passed', 'publishedTypes': 'passed', 'compiledApiSmoke': 'passed', 'compiledExplorerUiSmoke': 'passed',
        'compiledNavigationPublicContract': 'passed',
        'actualBrowserActions': report['actualBrowserActions'], 'mockProviderRequests': report['modelRequests'],
        'screenshot': 'explorer-dashboard.png', 'screenshotReviewed': False,
        'limits': ['Owned fixture and explicit mock providers only; no real-site completeness claim.',
            'Concurrent suite/protocol runs mean elapsed command durations are audit data, not performance measurements.']})
finally:
    assert root.name.startswith('bie-pending-baseline-reproduction-') and root != repo
    shutil.rmtree(root)
    save('cleanup.json', {'removedArchive': str(root), 'removed': not root.exists(),
        'resources': 'Only the owned archive was removed; smoke scripts close their own fixture browser, HTTP servers and stores.'})
