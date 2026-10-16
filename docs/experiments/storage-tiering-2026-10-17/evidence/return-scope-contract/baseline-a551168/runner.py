#!/usr/bin/env python3
"""Explicitly invoked isolated baseline regression reproduction. Preparation runs no test.
Run after root releases CPU: python3 /tmp/bie-return-scope-baseline-a551168.py --run
No installs, provider credentials, original databases, or original dist writes.
"""
import argparse, hashlib, json, os, pathlib, shutil, signal, subprocess, sys, tarfile, tempfile, time, uuid

SOURCE = pathlib.Path('/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine')
REVISION = 'a551168515a7ae62c74f54f53f143a47b24abcd9'
NODE = pathlib.Path('/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin/node')
REL_EVIDENCE = pathlib.Path('docs/experiments/storage-tiering-2026-10-17/evidence/return-scope-contract/baseline-a551168')
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
    parser.add_argument('--run',action='store_true',help='Explicitly run only the unmodified return-to-scope baseline test; no build')
    parser.add_argument('--pnpm',default=shutil.which('pnpm'))
    args=parser.parse_args()
    if not args.run:
        print('Prepared only. Pass --run after the root full-suite CPU window is released.');return 0
    assert NODE.is_file() and args.pnpm, 'Node 24.22.0 and an installed pnpm executable are required; installation is forbidden'
    pnpm=pathlib.Path(args.pnpm).resolve()
    assert subprocess.check_output(['git','rev-parse',REVISION],cwd=SOURCE,text=True).strip()==REVISION
    evidence=SOURCE/REL_EVIDENCE
    evidence.mkdir(parents=True,exist_ok=False)  # Never overwrite a prior acceptance run.
    shutil.copy2(__file__,evidence/'runner.py')
    token=str(uuid.uuid4());archive=pathlib.Path(tempfile.mkdtemp(prefix='bie-return-scope-a551168-')).resolve()
    marker=archive/'.owned-compiled-acceptance.json';write(marker,{'token':token,'revision':REVISION})
    commands=[];setup={};ok=False;error=None;source_before=[];source_paths=[];test_exit=None
    allowed=['HOME','TMPDIR','TMP','TEMP','LANG','LC_ALL','PLAYWRIGHT_BROWSERS_PATH']
    env={k:os.environ[k] for k in allowed if k in os.environ}
    env.update({'CI':'true','PATH':str(archive/'node_modules/.bin')+os.pathsep+str(NODE.parent)+os.pathsep+'/usr/bin:/bin:/usr/sbin:/sbin','NO_COLOR':'1'})
    def run(name,argv,timeout=240,check=True):
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
        if check and code:raise RuntimeError(f'{name} failed with exit code {code}; see {name}.log')
        return code
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
        setup={'revision':REVISION,'sourceRoot':str(archive),'ownerToken':token,'node':str(NODE),'pnpm':str(pnpm),'sourceFileCount':len(source_before),'workspaceDependencyLinks':links,'thirdPartyReadOnlySharedLinks':shared,'privateBinEntries':list(bins)+['node','pnpm'],'environmentPolicy':'Allowlist only; NODE_OPTIONS, NODE_PATH and all provider credentials omitted. No .env loaded.','executionPolicy':'Only unmodified tests/explorer-return-to-scope.test.ts and its owned local fixtures/mock providers. No build, installation, or dev/main writes.','cleanup':'Only the archive with the matching ownership marker may be removed.'}
        write(evidence/'setup.json',setup)
        test=archive/'tests/explorer-return-to-scope.test.ts'
        test_hash=sha(test)
        shutil.copy2(test,evidence/'explorer-return-to-scope.test.ts.txt')
        blob=subprocess.check_output(['git','rev-parse',REVISION+':tests/explorer-return-to-scope.test.ts'],cwd=SOURCE,text=True).strip()
        write(evidence/'test-source.json',{'revision':REVISION,'path':'tests/explorer-return-to-scope.test.ts','gitBlob':blob,'sha256':test_hash,'modified':False})
        code=run('baseline-test',[NODE,'--conditions=development','node_modules/vitest/vitest.mjs','run','tests/explorer-return-to-scope.test.ts','--reporter=default','--reporter=json','--outputFile=.data/return-scope-results.json'],check=False)
        test_exit=code
        result_path=archive/'.data/return-scope-results.json'
        assert result_path.is_file(),'Vitest JSON report missing'
        shutil.copy2(result_path,evidence/'vitest-results.json')
        results=json.loads(result_path.read_text())
        assertions=[case for suite in results.get('testResults',[]) for case in suite.get('assertionResults',[])]
        failures=[case for case in assertions if case.get('status')=='failed']
        passed=[case for case in assertions if case.get('status')=='passed']
        expected='expected "reachCheckpoint" to be called 1 times, but got 0 times'
        reproduced=code==1 and len(assertions)==5 and len(failures)==4 and len(passed)==1 and all(any(expected in message for message in case.get('failureMessages',[])) for case in failures)
        write(evidence/'baseline-result.json',{'revision':REVISION,'testExitCode':code,'baselineReproduced':reproduced,'testSuitePassed':test_exit==0 if test_exit is not None else None,'counts':{'total':len(assertions),'failed':len(failures),'passed':len(passed)},'expectedFailure':expected,'cases':[{'name':case.get('fullName') or case.get('title'),'status':case.get('status'),'failureMessages':case.get('failureMessages',[])} for case in assertions],'testSourceUnchanged':sha(test)==test_hash})
        if not reproduced:raise RuntimeError('Baseline did not reproduce exactly the four expected strict-checkpoint spy failures; retain output for diagnosis')
        ok=True
    except BaseException as exc:
        error=f'{type(exc).__name__}: {exc}';(evidence/'runner-error.txt').write_text(error+'\n')
    finally:
        try:
            if source_before:
                after=manifests(source_paths,archive);write(evidence/'source-after.json',after)
                # No archived source/config/test input is expected to change in the baseline reproduction.
                unchanged=after==source_before
                if not unchanged:ok=False;error=(error or '')+' Archived source files changed.'
            else:unchanged=False
            write(evidence/'summary.json',{'revision':REVISION,'baselineReproduced':ok,'testSuitePassed':test_exit==0 if test_exit is not None else None,'sourceUnchanged':unchanged,'sourceFiles':len(source_before),'commands':[{k:r.get(k) for k in ['name','exitCode','timedOut','elapsedSeconds']} for r in commands],'error':error,'limits':['Only the unchanged baseline return-to-scope test was run; no build or other suite.','A reproduced negative baseline is not a passing product test.','No performance claim, real provider, real-site browser, or original database was used.']})
        finally:
            removed=False;cleanup_error=None
            try:
                assert archive.name.startswith('bie-return-scope-a551168-') and archive!=SOURCE.resolve()
                assert not archive.is_symlink() and json.loads(marker.read_text())['token']==token
                shutil.rmtree(archive);removed=not archive.exists()
            except BaseException as exc:cleanup_error=str(exc);ok=False
            write(evidence/'cleanup.json',{'ownedArchive':str(archive),'removed':removed,'error':cleanup_error,'scope':'Only matching-marker archive removed. The single test command used an owned process group; fixture teardown owns its browsers, HTTP servers and stores.'})
            write(evidence/'artifact-manifest.json',manifests([p for p in evidence.iterdir() if p.name!='artifact-manifest.json'],evidence))
    print(json.dumps({'evidence':str(evidence),'baselineReproduced':ok,'error':error},ensure_ascii=False))
    return 0 if ok else 1

if __name__=='__main__':sys.exit(main())
