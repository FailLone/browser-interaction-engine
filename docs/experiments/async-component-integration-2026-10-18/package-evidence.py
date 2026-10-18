"""Archive closed-run evidence only, with source hashes; never rewrite raw runs."""
import pathlib,json,gzip,hashlib
root=pathlib.Path(__file__).resolve().parents[3]; raw=root/'.data/async-component-integration'; dest=pathlib.Path(__file__).parent/'evidence'; dest.mkdir(exist_ok=True)
files=[p for p in raw.iterdir() if p.is_file() and p.suffix in ['.log','.json','.jsonl']]
for run in ['local-frozen-1','okx-frozen-1']:
    files += [p for p in (raw/run).iterdir() if p.is_file() and p.suffix in ['.json','.jsonl','.log','.diff']]
for name in ['integration-meter-readiness-1.log','integration-meter-readiness-2.log','integration-enabled-child-1.log','integration-types-1.log','integration-types-2.log']:
    p=root/'.data/component-correspondence'/name
    if p.exists():files.append(p)
files+=list((raw/'readiness-after-partition-1').glob('*/result.json'))
files.append(raw/'closed-diagnosis/result.json')
index=[]
for path in files:
    data=path.read_bytes();name=('__'.join(path.relative_to(root/'.data').parts))+'.gz';packed=gzip.compress(data,mtime=0);target=dest/name;target.write_bytes(packed)
    index.append({'source':str(path.relative_to(root)),'archive':name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'archiveBytes':len(packed),'archiveSHA256':hashlib.sha256(packed).hexdigest()})
def file_hash(path):
    digest=hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''):digest.update(chunk)
    return digest.hexdigest()
closed=[]
for run in ['local-frozen-1','okx-frozen-1']:
    for name in ['engine/engine.sqlite','explorer.sqlite']:
        path=raw/run/name
        if path.exists():closed.append({'path':str(path),'bytes':path.stat().st_size,'sha256':file_hash(path)})
(dest/'index.json').write_text(json.dumps({'files':index,'closedDatabasesRetainedLocally':closed},indent=2)+'\n')
print(json.dumps({'archives':len(index),'compressedBytes':sum(i['archiveBytes'] for i in index),'closedDatabases':len(closed)}))
