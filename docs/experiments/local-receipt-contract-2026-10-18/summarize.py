"""Report independent stages; correspondence alone is never progress."""
import pathlib,json,collections,sys
run=pathlib.Path(sys.argv[1]);rows=[json.loads(l) for l in (run/'timeline.jsonl').read_text().splitlines()];task=json.loads((run/'task-final.json').read_text())
dispatches=[e['data'] for e in rows if e['type']=='browser.dispatch'];attempts=json.loads(pathlib.Path(sys.argv[2]).read_text())['attempts']
source_ids={i for e in rows if e['type']=='plugin.event' and e['data']['type']=='branch.children_retained' for i in e['data']['data']['itemIds']}
items=[i for i in task['plan'] if i['id'] in source_ids and i.get('resolvedBy',{}).get('attemptId')]
sdk=collections.defaultdict(lambda:{'calls':0,'elapsedMs':0})
for e in rows:
 if e['type']=='sdk.call':
  d=e['data'];sdk[d['method']]['calls']+=1;sdk[d['method']]['elapsedMs']+=d['elapsedMs']
summary={'actualDispatches':len(dispatches),'succeeded':sum(a['status']=='succeeded' for a in attempts),'observedNewDocuments':sum(bool(a['documentChanged']) for a in attempts),
 'verifiedActualReceipts':[{'id':a['id'],'label':a['label'],'policy':a['condition'].get('policy')} for a in attempts if a['condition']['conditionVerified']],
 'retainedOriginalChildrenWithReceipts':[{'id':i['id'],'label':i['scope'].get('label'),'status':i['status'],'condition':i.get('conditionCompletion'),'resolvedBy':i['resolvedBy']} for i in items],
 'retainedOriginalChildrenCompleted':[{'id':i['id'],'label':i['scope'].get('label'),'resolvedBy':i['resolvedBy']} for i in items if i['status']=='succeeded' and i.get('conditionCompletion',{}).get('status')=='verified'],
 'verifiedNativeNavigations':[{'id':a['id'],'label':a['label'],'url':a['afterURL']} for a in attempts if a['condition'].get('policy')=='browser-native-navigation-receipt-v1' and a['condition']['conditionVerified']],
 'historyDispatches':[a for a in attempts if a['kind']=='history'],'reentryProposals':[e['data'] for e in rows if e['type']=='plugin.event' and 'reentry' in e['data']['type']],
 'entryDispatches':[{'label':d['action']['label'],'kind':d['action']['kind']} for d in dispatches if d['action']['label'] in ['交易','打开 现货 子菜单']],
 'sdkTimings':dict(sdk),'modelUsage':task['usage'],'independentAudit':json.loads((run/'result.json').read_text())}
(run/'stage-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2));print(json.dumps({k:v for k,v in summary.items() if k not in ['sdkTimings','reentryProposals','historyDispatches']},ensure_ascii=False))
