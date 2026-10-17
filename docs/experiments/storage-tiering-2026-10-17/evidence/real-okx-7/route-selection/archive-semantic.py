#!/usr/bin/env python3
"""Losslessly deduplicate complete semantic artifacts after successful comparisons."""
import pathlib,json,gzip,hashlib
HERE=pathlib.Path(__file__).resolve().parent
assert json.loads((HERE/'comparison-execution.json').read_text())['error'] is None
objects=HERE/'semantic-objects';objects.mkdir(exist_ok=True);index=[]
for p in sorted(HERE.glob('*-semantic.json')):
 data=p.read_bytes();digest=hashlib.sha256(data).hexdigest();target=objects/(digest+'.json.gz')
 if not target.exists():target.write_bytes(gzip.compress(data,compresslevel=6,mtime=0))
 assert gzip.decompress(target.read_bytes())==data
 index.append({'originalPath':p.name,'logicalBytes':len(data),'logicalSha256':digest,'archivePath':str(target.relative_to(HERE)),'storedBytes':target.stat().st_size,'storedSha256':hashlib.sha256(target.read_bytes()).hexdigest()})
for row in index:(HERE/row['originalPath']).unlink()
(HERE/'semantic-artifact-index.json').write_text(json.dumps({'policy':'Complete input/selected/task/events retained losslessly, deduplicated only by exact JSON byte SHA256; every trial maps to its complete content. Raw filenames in comparison records resolve through this index.','artifacts':index},indent=2)+'\n')
print(json.dumps({'logicalArtifacts':len(index),'uniqueObjects':len({r['archivePath'] for r in index}),'originalBytes':sum(r['logicalBytes'] for r in index),'storedBytes':sum(p.stat().st_size for p in objects.iterdir())}))
