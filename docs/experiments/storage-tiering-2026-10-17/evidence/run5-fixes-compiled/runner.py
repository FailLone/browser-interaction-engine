#!/usr/bin/env python3
"""Explicitly invoked isolated build acceptance. Preparation alone runs no build.
Run: python3 /tmp/bie-run5-fixes-compiled-edd32f9.py --run
No installs, provider credentials, original databases, or original dist writes.
"""
import argparse, hashlib, json, os, pathlib, shutil, signal, subprocess, sys, tarfile, tempfile, time, uuid

SOURCE = pathlib.Path('/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine')
REVISION = 'edd32f9e34a67ea482eedde9b3b64a6212647600'
NODE = pathlib.Path('/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin/node')
REL_EVIDENCE = pathlib.Path('docs/experiments/storage-tiering-2026-10-17/evidence/run5-fixes-compiled')
CONTRACT = r'''
import assert from 'node:assert/strict';
import ts from 'typescript';
import { writeFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserEngine } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { RetainedPersistence } from '@interaction/storage-retained';
const root=realpathSync(process.cwd()), file=resolve('.data/run4-public-consumer.mts');
const source=`
import type { BrowserEngine } from '@interaction/browser';
import type { ObservedSourceReturnResult, Persistence } from '@interaction/core';
import type { RetainedPersistence } from '@interaction/storage-retained';
declare const engine: BrowserEngine, store: Persistence, retained: RetainedPersistence;
type Assert<T extends true> = T;
type NotAny<T> = 0 extends (1 & T) ? false : true;
type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
type Result = Awaited<ReturnType<BrowserEngine['returnToObservedSource']>>;
type IsTyped = Assert<NotAny<Result>>;
type ExactPublicResult = Assert<Equal<Result, ObservedSourceReturnResult>>;
type Status = Assert<Equal<Result['status'], 'SOURCE_REACHED'|'PRECONDITIONS_CHANGED'|'UNREACHABLE'|'UNVERIFIED'>>;
type FalseFlags = Assert<Equal<Result['checkpointVerified']|Result['currentExecution']|Result['executionAuthorized']|Result['sourceStateRestored'],false>>;
const promise: Promise<ObservedSourceReturnResult> = engine.returnToObservedSource('s',{observationId:'source',currentObservationId:'current'});
declare const result: Result;
const scope: 'observed-ui'|undefined=result.verificationScope;
const unresolved: string[]=result.diagnostics.unassessedEffectAttemptIds;
// @ts-expect-error Source arrival cannot become strict checkpoint success.
const strict: 'REACHED_VERIFIED'=result.status;
// @ts-expect-error Source arrival cannot authorize execution.
const authorized: true=result.executionAuthorized;
// @ts-expect-error The source observation is required.
engine.returnToObservedSource('s',{});
type OptionalScopedRead=Assert<Equal<{} extends Pick<Persistence,'listByObservation'>?true:false,true>>;
type ScopedTyped=Assert<NotAny<ReturnType<NonNullable<Persistence['listByObservation']>>>>;
const row: {id:string;observationId:string}[]|undefined=store.listByObservation?.<{id:string;observationId:string}>('action','s','o');
const wrapped: {id:string}[]|undefined=retained.listByObservation?.<{id:string}>('action','s','o');
declare const required: Omit<Persistence,'listByObservation'>;
const legacy: Persistence=required;
// @ts-expect-error The optional legacy hook cannot be called without a guard.
store.listByObservation('action','s','o');
// @ts-expect-error Generic scoped rows remain typed.
row?.[0].inventedPermission;
`;
writeFileSync(file,source);
const options={module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022,strict:true,skipLibCheck:true,noEmit:true,types:['node'],customConditions:[]};
const program=ts.createProgram([file],options),diagnostics=ts.getPreEmitDiagnostics(program);
if(diagnostics.length)throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:ts.sys.getCurrentDirectory,getCanonicalFileName:x=>x,getNewLine:()=> '\n'}));
const declarations=program.getSourceFiles().map(f=>realpathSync(f.fileName)).filter(p=>p.includes('/packages/')&&!p.includes('/node_modules/'));
assert.ok(declarations.some(p=>p.endsWith('/core/dist/ports.d.ts')));
for(const p of declarations)assert.ok(p.startsWith(root+sep)&&p.includes('/dist/'),`Nonpublished workspace declaration: ${p}`);
const modules=[];
for(const name of ['core','browser','adapter-playwright','storage-memory','storage-retained','storage-sqlite','explorer-plugin','client','rules']){
 const path=realpathSync(fileURLToPath(import.meta.resolve('@interaction/'+name)));
 assert.ok(path.startsWith(root+sep)&&path.includes('/dist/'),`Workspace import escaped archive: ${path}`);
 modules.push({name:'@interaction/'+name,path});
}
const seed=store=>{
 store.put('observation',{id:'now',sessionId:'fixture-session'});
 store.put('observation',{id:'old',sessionId:'fixture-session'});
 for(const row of [{id:'old-action',sessionId:'fixture-session',observationId:'old'},{id:'a',sessionId:'fixture-session',observationId:'now',value:{n:1}},{id:'b',sessionId:'other',observationId:'now'},{id:'c',sessionId:'fixture-session',observationId:'now'}])store.put('action',row);
};
const backing=new MemoryStore();let scopedCalls=[];
const scoped=backing.listByObservation.bind(backing);
backing.listByObservation=function(...args){assert.equal(this,backing);scopedCalls.push(args);return scoped(...args);};
const engine=new BrowserEngine({persistence:backing,retention:{sweepIntervalMs:0}});
let legacyReads=0,optimized;
try{
 seed(backing);assert.equal(typeof engine.returnToObservedSource,'function');
 assert.equal(typeof engine.store.listByObservation,'function');
 optimized=engine.actions('fixture-session','now');assert.deepEqual(optimized.map(x=>x.id),['a','c']);
 assert.deepEqual(scopedCalls,[['action','fixture-session','now']]);
 optimized[0].value.n=99;assert.equal(engine.actions('fixture-session','now')[0].value.n,1);
 optimized=engine.actions('fixture-session','now');
}finally{await engine.close();}
const old=new MemoryStore(),list=old.list.bind(old);
old.listByObservation=undefined;
old.list=function(...args){if(args[0]==='action')legacyReads++;return list(...args);};
const fallback=new BrowserEngine({persistence:old,retention:{sweepIntervalMs:0}});
try{
 seed(old);assert.equal(fallback.store.listByObservation,undefined);
 assert.deepEqual(fallback.actions('fixture-session','now'),optimized);
 assert.equal(legacyReads,1);
}finally{await fallback.close();}
const raw=new MemoryStore(),wrapper=new RetainedPersistence(raw,{sweepIntervalMs:0});
try{seed(raw);assert.deepEqual(wrapper.listByObservation('action','fixture-session','now'),optimized);}finally{wrapper.close();}
const report={publishedNarrowSourceResult:'passed',optionalPersistenceMethod:'passed',retainedBoundForwarding:'passed',browserEngineForwarding:'passed',legacyFullListFallback:'passed',copyIsolation:'passed',driverStarts:0,sourceReturnDispatches:0,modules,declarations};
writeFileSync('.data/run4-contract-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
'''

def sha(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
    return h.hexdigest()

def write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,indent=2,ensure_ascii=False)+'\n')

def manifests(paths,root):
    return [{'path':str(p.relative_to(root)),'bytes':p.stat().st_size,'sha256':sha(p)} for p in sorted(set(paths)) if p.is_file() and not p.is_symlink()]

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run',action='store_true',help='Explicitly start the archive build and local fixture smoke tests')
    parser.add_argument('--pnpm',default=shutil.which('pnpm'))
    args=parser.parse_args()
    if not args.run:
        print('Prepared only. Pass --run after the root CPU window is released.');return 0
    assert NODE.is_file() and args.pnpm, 'Node 24.22.0 and an installed pnpm executable are required; installation is forbidden'
    pnpm=pathlib.Path(args.pnpm).resolve()
    assert subprocess.check_output(['git','rev-parse',REVISION],cwd=SOURCE,text=True).strip()==REVISION
    evidence=SOURCE/REL_EVIDENCE
    evidence.mkdir(parents=True,exist_ok=False)  # Never overwrite a prior acceptance run.
    shutil.copy2(__file__,evidence/'runner.py');(evidence/'compiled-public-contract.mjs').write_text(CONTRACT)
    token=str(uuid.uuid4());archive=pathlib.Path(tempfile.mkdtemp(prefix='bie-run4-compiled-edd32f9-')).resolve()
    marker=archive/'.owned-compiled-acceptance.json';write(marker,{'token':token,'revision':REVISION})
    commands=[];setup={};ok=False;error=None;source_before=[];source_paths=[];artifacts=[]
    allowed=['HOME','TMPDIR','TMP','TEMP','LANG','LC_ALL','PLAYWRIGHT_BROWSERS_PATH']
    env={k:os.environ[k] for k in allowed if k in os.environ}
    env.update({'CI':'true','PATH':str(archive/'node_modules/.bin')+os.pathsep+str(NODE.parent)+os.pathsep+'/usr/bin:/bin:/usr/sbin:/sbin','NO_COLOR':'1'})
    def run(name,argv,timeout=180):
        started=time.time();row={'name':name,'argv':list(map(str,argv)),'cwd':str(archive),'startedAtEpoch':started,'log':name+'.log'};commands.append(row)
        with open(evidence/(name+'.log'),'wb') as out:
            child=subprocess.Popen(row['argv'],cwd=archive,env=env,stdout=out,stderr=subprocess.STDOUT,start_new_session=True)
            try:code=child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                row['timedOut']=True;os.killpg(child.pid,signal.SIGTERM)
                try:code=child.wait(timeout=10)
                except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);code=child.wait()
            row.update(exitCode=code,elapsedSeconds=time.time()-started)
        write(evidence/'commands.json',commands)
        if code:raise RuntimeError(f'{name} failed with exit code {code}; see {name}.log')
    try:
        tar=archive/'source.tar'
        with open(tar,'wb') as out:subprocess.run(['git','archive','--format=tar',REVISION],cwd=SOURCE,stdout=out,check=True)
        with tarfile.open(tar) as tf:
            for member in tf.getmembers():
                path=pathlib.PurePosixPath(member.name)
                assert not path.is_absolute() and '..' not in path.parts and not member.issym() and not member.islnk(), 'Unsafe archive entry'
                # Never materialize a usable environment/credential file. The tracked example is inert documentation.
                assert not any(part=='.env' or part.startswith('.env.') and not part.endswith('.example') for part in path.parts), 'Tracked runtime environment file is forbidden'
            tf.extractall(archive)
        tar.unlink()
        source_paths=[p for p in archive.rglob('*') if p.is_file() and p!=marker and (p.parent==archive or p.relative_to(archive).parts[0] in {'packages','apps','scripts','examples','tests'})]
        source_before=manifests(source_paths,archive);write(evidence/'source-before.json',source_before)
        package_files=[archive/'package.json']+sorted((archive/'packages').glob('*/package.json'))+sorted((archive/'apps').glob('*/package.json'))
        workspaces={json.loads(p.read_text())['name']:p.parent for p in package_files[1:]}
        links=[];shared=[]
        def link_package(name,src,dst):
            dst.parent.mkdir(parents=True,exist_ok=True)
            target=workspaces.get(name,src.resolve(strict=True))
            dst.symlink_to(target,target_is_directory=True)
            row={'link':str(dst.relative_to(archive)),'resolved':str(dst.resolve())}
            if name in workspaces:
                row['insideArchive']=dst.resolve().is_relative_to(archive);assert row['insideArchive'];links.append(row)
            else:
                assert 'node_modules' in target.parts, f'Non-workspace dependency outside installed third-party storage: {name}'
                shared.append(row)
        for package in package_files:
            parent=package.parent;original=SOURCE/parent.relative_to(archive)/'node_modules';local=parent/'node_modules';local.mkdir(exist_ok=True)
            if original.is_dir():
                for entry in sorted(original.iterdir()):
                    if entry.name.startswith('.'):continue
                    if entry.name.startswith('@'):
                        for dep in sorted(entry.iterdir()):link_package(entry.name+'/'+dep.name,dep,local/entry.name/dep.name)
                    else:link_package(entry.name,entry,local/entry.name)
            # Explicit workspace dependencies are linked even if the original package used hoisting.
            meta=json.loads(package.read_text())
            for name,version in {**meta.get('dependencies',{}),**meta.get('devDependencies',{})}.items():
                if name in workspaces and not (local/name).exists():link_package(name,SOURCE/workspaces[name].relative_to(archive),local/name)
        bins={'tsc':'typescript/bin/tsc','tsserver':'typescript/bin/tsserver','vite':'vite/bin/vite.js','tsx':'tsx/dist/cli.mjs','vitest':'vitest/vitest.mjs','playwright':'playwright/cli.js'}
        for package in package_files:
            directory=package.parent/'node_modules/.bin';directory.mkdir(exist_ok=True)
            for name,relative in bins.items():
                target=archive/'node_modules'/relative
                assert target.is_file(),f'Missing installed command {name}'
                (directory/name).symlink_to(target)
            (directory/'node').symlink_to(NODE);(directory/'pnpm').symlink_to(pnpm)
        (archive/'.data').mkdir(exist_ok=True)
        (archive/'.data/compiled-public-contract.mjs').write_text(CONTRACT)
        setup={'revision':REVISION,'sourceRoot':str(archive),'ownerToken':token,'node':str(NODE),'pnpm':str(pnpm),'sourceFileCount':len(source_before),'workspaceDependencyLinks':links,'thirdPartyReadOnlySharedLinks':shared,'privateBinEntries':list(bins)+['node','pnpm'],'environmentPolicy':'Allowlist only; NODE_OPTIONS, NODE_PATH and all provider credentials omitted. No .env loaded.','executionPolicy':'Only owned local fixtures and explicit smoke mocks. No installation or dev/main builds.','cleanup':'Only the archive with the matching ownership marker may be removed.'}
        write(evidence/'setup.json',setup)
        run('build',[pnpm,'build'])
        run('published-types',[NODE,'scripts/smoke-public-types.mjs'])
        run('compiled-public-contract',[NODE,'.data/compiled-public-contract.mjs'])
        run('smoke-built',[NODE,'scripts/smoke-built.mjs'])
        run('smoke-explorer',[NODE,'scripts/smoke-explorer.mjs'])
        assert (archive/'docs/build-smoke.json').is_file(),'smoke-built report missing'
        reports=sorted((archive/'.data').glob('explorer-smoke-*/report.json'));assert len(reports)==1,'Expected exactly one owned explorer report'
        explorer=json.loads(reports[0].read_text());screenshot=pathlib.Path(explorer['screenshot']).resolve();assert screenshot.is_relative_to(archive) and screenshot.is_file()
        for src,name in [(archive/'docs/build-smoke.json','build-smoke.json'),(reports[0],'explorer-smoke.json'),(screenshot,'explorer-dashboard.png'),(archive/'.data/run4-contract-report.json','compiled-contract-report.json')]:
            shutil.copy2(src,evidence/name);artifacts.append({'source':str(src.relative_to(archive)),'artifact':name,'sha256':sha(evidence/name)})
        write(evidence/'artifact-map.json',artifacts)
        ok=True
    except BaseException as exc:
        error=f'{type(exc).__name__}: {exc}';(evidence/'runner-error.txt').write_text(error+'\n')
    finally:
        try:
            if source_before:
                after=manifests(source_paths,archive);write(evidence/'source-after.json',after)
                # smoke-built writes docs/build-smoke.json; hash actual source/config/test inputs separately from generated reports.
                unchanged=after==source_before
                if not unchanged:ok=False;error=(error or '')+' Archived source files changed.'
            else:unchanged=False
            compiled=[p for p in archive.rglob('*') if p.is_file() and 'dist' in p.relative_to(archive).parts and 'node_modules' not in p.relative_to(archive).parts]
            write(evidence/'compiled-files.json',manifests(compiled,archive))
            write(evidence/'summary.json',{'revision':REVISION,'passed':ok,'sourceUnchanged':unchanged,'sourceFiles':len(source_before),'compiledFiles':len(compiled),'commands':[{k:r.get(k) for k in ['name','exitCode','timedOut','elapsedSeconds']} for r in commands],'error':error,'screenshot':'explorer-dashboard.png' if (evidence/'explorer-dashboard.png').exists() else None,'screenshotReviewed':False,'limits':['Only owned local fixture/mock-provider smoke, not real OKX acceptance.','No performance claim: elapsed durations are command audit data.','The extra contract checks types and storage wrapping; source-return browser behavior remains covered by the separate product suite.','A human/root visual review of the saved screenshot is still required.']})
        finally:
            removed=False;cleanup_error=None
            try:
                assert archive.name.startswith('bie-run4-compiled-edd32f9-') and archive!=SOURCE.resolve()
                assert not archive.is_symlink() and json.loads(marker.read_text())['token']==token
                shutil.rmtree(archive);removed=not archive.exists()
            except BaseException as exc:cleanup_error=str(exc);ok=False
            write(evidence/'cleanup.json',{'ownedArchive':str(archive),'removed':removed,'error':cleanup_error,'scope':'Only matching-marker archive removed. Child commands used owned process groups; smoke scripts own and close fixture resources.'})
            write(evidence/'artifact-manifest.json',manifests([p for p in evidence.iterdir() if p.name!='artifact-manifest.json'],evidence))
    print(json.dumps({'evidence':str(evidence),'passed':ok,'error':error},ensure_ascii=False))
    return 0 if ok else 1

if __name__=='__main__':sys.exit(main())
