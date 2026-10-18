"""Read-only acceptance comparison; correspondence counts never grant progress."""
import json, pathlib, collections
root=pathlib.Path(__file__).resolve().parents[3]
base=root/'.data/component-correspondence'; current=root/'.data/async-component-integration'
summary={}
for label,directory in [('control',base/'okx-control-1'),('component-final',base/'okx-enhanced-final'),('integrated',current/'okx-frozen-1')]:
    if not (directory/'result.json').exists():continue
    result=json.loads((directory/'result.json').read_text());task=json.loads((directory/'task-final.json').read_text())
    rows=[json.loads(x) for x in (directory/'timeline.jsonl').read_text().splitlines()]
    dispatches=[e['data'] for e in rows if e['type']=='browser.dispatch'];executed={d['action']['id'] for d in dispatches}
    proofs=[p for e in rows if e['type']=='sdk.targetCorrespondences' for p in e['data']['results'] if p.get('equivalent') and p.get('policy')=='captured-component-pair/v1']
    sdk=collections.defaultdict(lambda:{'calls':0,'elapsedMs':0})
    for e in rows:
        if e['type']=='sdk.call':
            d=e['data'];sdk[d['method']]['calls']+=1;sdk[d['method']]['elapsedMs']+=d['elapsedMs']
    children={i for e in rows if e['type']=='plugin.event' and e['data']['type']=='branch.children_retained' for i in e['data']['data']['itemIds']}
    doneChildren=[{'id':i['id'],'scope':i['scope'],'resolvedBy':i.get('resolvedBy'),'attempts':i['attempts']} for i in task['plan'] if i['id'] in children and i['status']=='succeeded' and i.get('resolvedBy',{}).get('attemptId')]
    summary[label]={**{k:result.get(k) for k in ['accepted','elapsedMs','actions','branchCount','strictChains','checks','reason','chainRegions']},
      'dispatched':[{'number':d['number'],'id':d['action']['id'],'kind':d['action']['kind'],'label':d['action']['label'],'observationId':d['action']['observationId']} for d in dispatches],
      'entryDispatches':[{'label':d['action']['label'],'kind':d['action']['kind'],'observationId':d['action']['observationId']} for d in dispatches if d['action']['label'] in ['交易','打开 现货 子菜单']],
      'retainedChildrenCompletedByOwnReceipts':doneChildren,'componentProofs':len(proofs),'componentProvenExecutedActions':len({p['target']['actionId'] for p in proofs if p['target']['actionId'] in executed}),
      'boundOriginals':[i['id'] for i in task['plan'] if any(a.get('sourceAssociation',{}).get('proof',{}).get('policy')=='captured-component-pair/v1' for a in i['attempts'])],
      'sdkTimings':dict(sdk),'modelUsage':task['usage']}
(current/'comparison.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
print(json.dumps({name:{k:v for k,v in data.items() if k not in ['dispatched','entryDispatches','retainedChildrenCompletedByOwnReceipts','sdkTimings']} for name,data in summary.items()},ensure_ascii=False,indent=2))
