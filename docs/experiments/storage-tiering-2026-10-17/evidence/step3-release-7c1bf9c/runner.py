#!/usr/bin/env python3
"""Build one fixed git archive, then inspect published declarations and retained receipts."""
import hashlib, json, os, pathlib, shutil, subprocess, tarfile, tempfile, time

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[4]
REVISION = '7c1bf9c25fbba0d2302db68e765e68bfffd61866'
NODEBIN = '/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin'

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

assert not (HERE / 'validation.json').exists(), 'Do not overwrite a completed checkpoint'
assert subprocess.check_output(['git', 'rev-parse', REVISION], cwd=ROOT, text=True).strip() == REVISION
owned = pathlib.Path(tempfile.mkdtemp(prefix='bie-step3-release-7c1bf9c-')).resolve()
archive = owned / 'archive'
archive.mkdir()
write(owned / 'ownership.json', {'revision': REVISION, 'purpose': 'isolated compiled release checkpoint', 'evidence': str(HERE)})
tracked = subprocess.check_output(['git', 'ls-tree', '--name-only', REVISION], cwd=ROOT, text=True).splitlines()
included = [p for p in tracked if p not in ['docs', '.data']]
tar = owned / 'source.tar'
with tar.open('wb') as stream:
    subprocess.run(['git', 'archive', '--format=tar', REVISION, '--', *included], cwd=ROOT, stdout=stream, check=True)
with tarfile.open(tar) as stream:
    for entry in stream.getmembers():
        path = pathlib.PurePosixPath(entry.name)
        assert not path.is_absolute() and '..' not in path.parts and not entry.issym() and not entry.islnk()
    stream.extractall(archive)
source = [{'path': str(p.relative_to(archive)), 'bytes': p.stat().st_size, 'sha256': sha(p)} for p in sorted(archive.rglob('*')) if p.is_file()]
write(HERE / 'source-manifest.json', source)
packages = [archive / 'package.json'] + sorted((archive / 'packages').glob('*/package.json')) + sorted((archive / 'apps').glob('*/package.json'))
names = {json.loads(p.read_text())['name']: p.parent for p in packages[1:]}
links, external = [], {}
for package in packages:
    local = package.parent / 'node_modules'
    local.mkdir(exist_ok=True)
    original = ROOT / package.parent.relative_to(archive) / 'node_modules'
    def link(name, src):
        dest = local / name
        if dest.exists(): return
        target = names[name] if name in names else src.resolve(strict=True)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.symlink_to(target, target_is_directory=True)
        if name in names:
            assert dest.resolve().is_relative_to(archive)
            links.append({'path': str(dest.relative_to(archive)), 'target': str(target.relative_to(archive))})
        else:
            assert 'node_modules' in target.parts
            external[name] = {'target': str(target), 'packageJsonSha256': sha(target / 'package.json') if (target / 'package.json').exists() else None}
    if original.is_dir():
        for entry in sorted(original.iterdir()):
            if entry.name.startswith('.'): continue
            if entry.name.startswith('@'):
                for dep in sorted(entry.iterdir()): link(entry.name + '/' + dep.name, dep)
            else: link(entry.name, entry)
    metadata = json.loads(package.read_text())
    for name in {**metadata.get('dependencies', {}), **metadata.get('devDependencies', {})}:
        if name in names: link(name, names[name])
(archive / '.data').mkdir()
(archive / 'docs').mkdir()
shutil.copy2(HERE / 'compiled-smoke.mjs', archive / '.data/compiled-smoke.mjs')
seed = HERE.parent / 'receipt-condition-batch/fixture.json.gz'
reference = HERE.parent / 'receipt-condition-batch/baseline-fixed.json'
env = os.environ.copy()
env['PATH'] = NODEBIN + ':' + str(ROOT / 'node_modules/.bin') + ':' + env['PATH']
env['NODE_OPTIONS'] = ''
env.pop('NODE_PATH', None)
env['BIE_RELEASE_FIXTURE'] = str(seed)
env['BIE_RELEASE_REFERENCE'] = str(reference)
env['BIE_RELEASE_RESULT'] = str(HERE / 'compiled-smoke.json')
validation = {'revision': REVISION, 'ownedDirectory': str(owned), 'archive': str(archive), 'archiveTarSha256': sha(tar),
              'sourceManifestSha256': sha(HERE / 'source-manifest.json'), 'workspaceLinks': links, 'externalDependencies': external,
              'fixtureSha256': sha(seed), 'referenceSha256': sha(reference), 'steps': [],
              'scope': 'Fixed archive only. No browser attachment, browser creation, service startup, or persistent task database.'}
write(HERE / 'preparation.json', validation)
for name, command in [('build', ['pnpm', 'run', 'build']), ('published-snapshot-types', ['node', 'scripts/smoke-public-types.mjs']), ('compiled-receipt-api', ['node', '.data/compiled-smoke.mjs'])]:
    start = time.time()
    with (HERE / (name + '.log')).open('w') as log:
        result = subprocess.run(command, cwd=archive, env=env, stdout=log, stderr=subprocess.STDOUT)
    validation['steps'].append({'name': name, 'argv': command, 'exitCode': result.returncode, 'startEpoch': start, 'endEpoch': time.time(), 'logSha256': sha(HERE / (name + '.log'))})
    if result.returncode:
        write(HERE / 'validation.json', validation)
        raise SystemExit(result.returncode)
validation['sourcesUnchanged'] = all(sha(archive / row['path']) == row['sha256'] for row in source)
assert validation['sourcesUnchanged']
outputs = []
for path in sorted(archive.rglob('*')):
    rel = path.relative_to(archive)
    if path.is_file() and not path.is_symlink() and 'node_modules' not in rel.parts and 'dist' in rel.parts:
        outputs.append({'path': str(rel), 'bytes': path.stat().st_size, 'sha256': sha(path)})
write(HERE / 'artifact-manifest.json', outputs)
validation['artifactManifestSha256'] = sha(HERE / 'artifact-manifest.json')
validation['artifactCount'] = len(outputs)
validation['smokeSha256'] = sha(HERE / 'compiled-smoke.json')
validation['allPassed'] = True
write(HERE / 'validation.json', validation)
print(json.dumps({'revision': REVISION, 'archive': str(archive), 'steps': validation['steps'], 'artifactCount': len(outputs), 'sourcesUnchanged': True}, ensure_ascii=False, indent=2))
