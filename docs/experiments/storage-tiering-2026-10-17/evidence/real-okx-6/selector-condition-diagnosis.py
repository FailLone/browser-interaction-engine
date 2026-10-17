"""Read archived run6 material and authenticated evidence only; no DB/SDK/browser.
Run plan-growth-extract.py first if its private material file is no longer present.
Then run the companion .ts with Node24 --import tsx --conditions=development.
"""
import collections, gzip, hashlib, json, pathlib, subprocess, tempfile

out = pathlib.Path(__file__).resolve().parent
root = out.parents[4]
sha = lambda data: hashlib.sha256(data).hexdigest()
encode = lambda value: json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
source_paths = ['packages/adapter-playwright/src/branch-conditions.ts', 'packages/adapter-playwright/src/target-arrival.ts', 'packages/adapter-playwright/src/browser.ts', 'packages/adapter-playwright/src/identity-context.ts', 'packages/adapter-playwright/src/structural-lists.ts', 'packages/adapter-playwright/src/util.ts', 'packages/core/src/identity.ts']
sources = {p: sha((root / p).read_bytes()) for p in source_paths}
extraction = json.loads((out / 'plan-growth-extraction.json').read_text())
material = json.loads(pathlib.Path(extraction['material']).read_text())
ids = ['c11abe9e-e2a4-44f2-bf53-64ebf22a1dd2', 'f23494e8-671d-40fa-abe2-c39c51ef09a7', '7d2b74b2-0f19-41f9-aa3b-0a76be24dd30', 'fd34f210-b228-4d61-ab92-6bcebe74ccb9']
fields = ['id', 'sessionId', 'instanceScope', 'documentId', 'capturedAt', 'ruleVersion', 'url', 'stable', 'controls', 'components', 'regions', 'context', 'gaps', 'boundaries', 'overlays', 'navigation']
frames = [{'observation': {k: material['observations'][id][k] for k in fields if k in material['observations'][id]}, 'actions': material['actions'][id]} for id in ids]

base = root / '.data/okx-storage-acceptance-20261017-v1-frozen-6/engine/evidence'
artifact = ids[0] + '.details.json'
manifest_path = base / (artifact + '.meta.json')
manifest_bytes = manifest_path.read_bytes()
manifest = json.loads(manifest_bytes)
chunks = []
for block in manifest['blocks']:
    data = (base / 'blobs' / block['blob']).read_bytes()
    if block['encoding'] == 'gzip': data = gzip.decompress(data)
    assert len(data) == block['bytes'] and sha(data) == block['sha256']
    chunks.append(data)
data = b''.join(chunks)
assert len(data) == manifest['bytes'] and sha(data) == manifest['sha256']
details = json.loads(data)
assert details['observationId'] == ids[0]
assert manifest['sha256'] == material['observations'][ids[0]]['evidence']['artifacts']['details']['sha256']
nodes = {node['id']: node for node in details['dom']['nodes']}
suffix = lambda value: value.rsplit(':', 1)[-1]
slim = lambda n: {k: n[k] for k in ['id', 'parentId', 'children', 'tag', 'nodeType', 'attributes', 'gaps'] if k in n} | {'computedStyle': {k: n.get('styles', {}).get(k) for k in ['display', 'visibility', 'position']}}
rows = []
for c in frames[0]['observation']['controls']:
    if c['name'] != 'Open sub-menu': continue
    row = nodes[c['reviewBinding']['parentInstanceId']]
    children = [nodes[id] for id in row['children']]
    links = [n for n in children if n.get('tag') == 'a' and n.get('attributes', {}).get('href')]
    assert len(links) == 1 and all(n.get('styles', {}).get('visibility') == 'hidden' for n in children)
    assert row.get('styles', {}).get('visibility') == 'hidden' and row.get('tag') == 'li'
    # The present recordScopes predicate removes even a direct record anchor
    # when its hidden visibility is inherited from the containing menu/row.
    rows.append({'controlId': c['localId'], 'row': slim(row), 'children': [slim(n) for n in children], 'directRecordHref': links[0]['attributes']['href'],
                 'directLinkRejectedByCurrentRecordScopes': links[0]['styles']['visibility'] == 'hidden',
                 'allRowChildrenRejectedByCurrentVisibilityPredicate': True,
                 'noDirectRowTextNodeRemains': all(n.get('nodeType') == 'element' for n in children),
                 'originalSelector': {k: c.get(k) for k in ['name', 'instanceId', 'visible', 'expanded', 'stableKey', 'identityScope', 'identityContext', 'hypothesisId', 'reviewBinding']}})
assert len(rows) == 2 and len({r['directRecordHref'] for r in rows}) == 2
snapshot = pathlib.Path(tempfile.mkdtemp(prefix='okx-run6-selector-diagnosis-')) / 'frames.json'
snapshot.write_text(encode(frames))
assert sources == {p: sha((root / p).read_bytes()) for p in source_paths}
report = {'protocol': 'run6-selector-condition-diagnosis-v1', 'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
          'sourceSha256': sources, 'archivedInputDatabaseSha256': extraction['inputHashes'],
          'method': {'reads': 'previous authenticated raw extraction + frozen evidence files', 'databaseConnections': 0, 'sdkConstructors': 0, 'browserProviderNetworkCalls': 0, 'productOrTestWrites': 0},
          'privateFrames': str(snapshot), 'privateFramesSha256': sha(snapshot.read_bytes()),
          'evidenceValidation': {'artifact': artifact, 'bytes': len(data), 'sha256': sha(data), 'verifiedBlocks': len(chunks), 'manifestSha256': sha(manifest_bytes), 'domTruncated': details['dom'].get('nodesTruncated'), 'scope': 'selected row and direct children are present; overall DOM completeness is not claimed'},
          'captureFindings': rows,
          'frameHashes': {frame['observation']['id']: sha(encode(frame).encode()) for frame in frames},
          'authorizations': {'identity': False, 'execution': False, 'coverage': False, 'recovery': False, 'retryRelease': False}}
(out / 'selector-condition-diagnosis.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'frames': len(frames), 'privateFrames': str(snapshot), 'rows': [{'controlId': r['controlId'], 'directRecordHref': r['directRecordHref']} for r in rows]}, indent=2))
