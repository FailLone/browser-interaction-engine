"""Freeze completed public-run inputs. SQL reads only an immutable closed copy."""
import gzip, hashlib, json, pathlib, shutil, sqlite3, sys
source, output = map(pathlib.Path, sys.argv[1:3])
output.mkdir(parents=True, exist_ok=False)
original = source / 'engine/engine.sqlite'
assert not pathlib.Path(str(original) + '-wal').exists(), 'SOURCE_MUST_BE_CLOSED'
sha = lambda b: hashlib.sha256(b).hexdigest()
before = sha(original.read_bytes())
copy = output / 'closed-engine.sqlite'
shutil.copyfile(original, copy)
c = sqlite3.connect('file:' + str(copy.resolve()) + '?immutable=1', uri=True)
c.row_factory = sqlite3.Row
packs = {}
def decode(row):
    value = json.loads(row['json']); h = value.get('$interactionStorage')
    if not h: return value
    data = gzip.decompress(row['compressed_json'])
    if h.get('codec') == 'structural':
        assert len(data) == h['layoutBytes'] and sha(data) == h['layoutSha256']
        parts = []
        for item in json.loads(data):
            if isinstance(item, str): parts.append(item.encode()); continue
            ob = c.execute('select * from observation_objects where id=? and session_id=?', (item, h['sessionId'])).fetchone()
            assert ob is not None
            if ob['pack_id'] not in packs:
                pack = c.execute('select * from observation_packs where id=? and session_id=?', (ob['pack_id'], h['sessionId'])).fetchone()
                raw = gzip.decompress(pack['data']) if pack['codec'] == 'gzip' else pack['data']
                assert len(raw) == pack['bytes'] and hashlib.sha256(raw).digest() == pack['sha256']
                packs[ob['pack_id']] = raw
            raw = packs[ob['pack_id']][ob['byte_offset']:ob['byte_offset'] + ob['bytes']]
            assert len(raw) == ob['bytes'] and hashlib.sha256(raw).digest() == ob['sha256']
            parts.append(raw)
        data = b''.join(parts)
    assert len(data) == h['bytes'] and sha(data) == h['sha256']
    return json.loads(data)
lines = [json.loads(line) for line in (source / 'timeline.jsonl').read_text().splitlines()]
fronts = [r['data'] for r in lines if r['type'] == 'plugin.event' and r['data']['type'] == 'fragment.frontier']
ids = list(dict.fromkeys(f['data']['observationId'] for f in fronts))
actions = [decode(row) for row in c.execute("select * from entities where kind='action'")]
observations = [decode(c.execute("select * from entities where kind='observation' and id=?", (i,)).fetchone()) for i in ids]
rows = [dict(observation=o, actions=[a for a in actions if a.get('observationId') == o['id']]) for o in observations]
raw = json.dumps(rows, ensure_ascii=False, separators=(',', ':')).encode()
(output / 'captured.json.gz').write_bytes(gzip.compress(raw, mtime=0))
manifest = dict(source=str(source.resolve()), dbSHA256=before, inputSHA256=sha(raw), observations=len(rows), actions=sum(len(r['actions']) for r in rows), sourceUnchanged=sha(original.read_bytes()) == before)
(output / 'manifest.json').write_text(json.dumps(manifest, indent=2))
c.close(); print(json.dumps(manifest))
