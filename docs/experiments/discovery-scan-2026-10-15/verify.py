import json
from pathlib import Path
p = Path(__file__).parent
d = json.loads((p / 'acceptance.json').read_text())
a, b = d['before'], d['after']
assert d['sourceFilesUnchanged'] and d['sourceObservationUnchanged']
assert a['url'] == b['url'] == 'https://www.okx.com/convert/btc-to-usd'
assert a['documentId'] == b['documentId'] and a['instanceScope'] == b['instanceScope']
assert a['observationId'] != b['observationId'] and a['stable'] and b['stable']
assert a['actionCount'] == b['actionCount'] == 0 and not d['attempts']
assert d['firstRejected']['code'] == 'STALE_DISCOVERY_SCAN'
assert len(d['records']) == 1
r = d['records'][0]
assert r['source'] == 'gpt-5.6-sol/low' and r['evidence'] and r['status'] == 'active'
assert r['observationId'] == a['observationId'] and r['resultObservationId'] == b['observationId']
assert r['topologyKey'] == a['discovery']['topologyKey'] == b['discovery']['topologyKey']
assert r['budget'] == dict(offset=0, elements=2000, templateNodes=500, templateDepth=20, collections=500)
for s in (a,b):
    assert s['discovery']['nodeCount'] == s['discovery']['signal']['scanned'] == 1556
    assert s['discovery']['signal']['omitted'] == 0
    assert s['controlCount'] == 302 and s['structuralListCount'] == 16 and s['actionCountCandidates'] == 209
    assert s['boundaries']
    assert any(g['code'] == 'UNSUPPORTED_CANVAS' for g in s['gaps'])
    assert any(g['code'] == 'EVENT_LISTENER_COVERAGE' for g in s['gaps'])
assert a['discovery']['structural']['templatesTruncated'] == 17
assert b['discovery']['structural']['templatesTruncated'] == 1
omissions = b['discovery']['structural']['omissions']
assert len(omissions) == 1
assert omissions[0]['ownerSelector'] == '#root' and omissions[0]['kind'] == 'template_nodes'
assert omissions[0]['limit'] == 500 and omissions[0]['observed'] == 501
assert b['discovery']['structural']['rowWindowsTruncated'] == 0
assert not b['discovery']['structural']['collectionsTruncated']
assert b['discovery']['supplement']['requestId'] == r['id']
assert b['discovery']['supplement']['status'] == 'active'
assert d['completionStatus'] == 'blocked' and d['exhaustive'] is False and d['counts']['succeeded'] == 0
completed = [e for e in d['scanEvents'] if e['type'] == 'discovery.scan_completed']
assert len(completed) == 1 and completed[0]['data']['resultObservationId'] == b['observationId']
assert len([e for e in d['scanEvents'] if e['type'] == 'discovery.scan_recorded']) == 1
print('Verified: stale request rejected; sourced bounded supplement; immutable evidence; 17→1 limitations; zero actions; remaining gaps retained.')
