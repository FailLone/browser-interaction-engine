"""Archive closed-run evidence and content hashes; never rewrite raw databases."""
import pathlib,json,gzip,hashlib
root=pathlib.Path(__file__).resolve().parents[3];raw=root/'.data/local-receipt-contract';dest=pathlib.Path(__file__).parent/'evidence';dest.mkdir(exist_ok=True)
allowed={'.json','.jsonl','.log','.diff'}
files=[p for p in raw.iterdir() if p.is_file() and p.suffix in allowed]
for folder in raw.iterdir():
    if folder.is_dir() and folder.name!='baseline':
        files += [p for p in folder.iterdir() if p.is_file() and p.suffix in allowed]
index=[]
for path in sorted(set(files)):
    data=path.read_bytes();name='__'.join(path.relative_to(root/'.data').parts)+'.gz';packed=gzip.compress(data,mtime=0);(dest/name).write_bytes(packed)
    index.append({'source':str(path.relative_to(root)),'archive':name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'archiveBytes':len(packed),'archiveSHA256':hashlib.sha256(packed).hexdigest()})
def file_hash(path):
    digest=hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''):digest.update(chunk)
    return digest.hexdigest()
closed=[]
for folder in raw.iterdir():
    if folder.is_dir() and folder.name!='baseline':
        for name in ['engine/engine.sqlite','engine.sqlite','explorer.sqlite']:
            path=folder/name
            if path.exists():closed.append({'path':str(path),'bytes':path.stat().st_size,'sha256':file_hash(path)})
(dest/'index.json').write_text(json.dumps({'files':index,'closedDatabasesRetainedLocally':closed},indent=2)+'\n')
print(json.dumps({'archives':len(index),'compressedBytes':sum(i['archiveBytes'] for i in index),'closedDatabases':len(closed)}))
