"""Read closed acceptance outputs; mapping statistics never imply coverage."""
import collections, json, pathlib
root = pathlib.Path(__file__).resolve().parents[3] / '.data/component-correspondence'
summary = {}
for name in ['okx-control-1', 'okx-enhanced-1', 'okx-enhanced-final']:
    directory = root / name
    result = json.loads((directory/'result.json').read_text())
    rows = [json.loads(line) for line in (directory/'timeline.jsonl').read_text().splitlines()]
    task = json.loads((directory/'task-final.json').read_text())
    proofs = [p for row in rows if row['type']=='sdk.targetCorrespondences'
              for p in row['data']['results'] if p.get('equivalent') and p.get('policy')=='captured-component-pair/v1']
    actions = [row['data'] for row in rows if row['type']=='browser.dispatch']
    executed = {a['action']['id'] for a in actions}
    sdk = collections.defaultdict(lambda: {'calls': 0, 'ms': 0})
    for row in rows:
        if row['type'] != 'sdk.call': continue
        data = row['data']; sdk[data['method']]['calls'] += 1; sdk[data['method']]['ms'] += data['elapsedMs']
    summary[name] = {k: result.get(k) for k in ['accepted','elapsedMs','actions','branchCount','strictChains','checks','calls','taskStatus','taskReason']}
    summary[name].update(commands=result['actions'],componentProofs=len(proofs), componentProvenExecutedActions=len({p['target']['actionId'] for p in proofs if p['target']['actionId'] in executed}),
        boundOriginals=[i['id'] for i in task['plan'] if any(a.get('sourceAssociation',{}).get('proof',{}).get('policy')=='captured-component-pair/v1' for a in i['attempts'])],
        sdkTimings=sdk, actions=[{'number':a['number'],'kind':a['action']['kind'],'label':a['action']['label']} for a in actions])
(root/'okx-final-comparison.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({name:{k:v for k,v in data.items() if k not in ['actions','sdkTimings']} for name,data in summary.items()},ensure_ascii=False,indent=2))
