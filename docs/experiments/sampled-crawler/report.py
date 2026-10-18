import json,sys,collections
for r in sys.argv[1:]:
  d=json.load(open(f'work/claude-probe/{r}/summary.json'));c=d['coverage']
  ev=[json.loads(l) for l in open(f'work/claude-probe/{r}/events.jsonl')]
  stop=[e for e in ev if e['type']=='stop'][-1]['reason']
  m=d['models'];inp=d.get('inputClassification',{})
  cost=m['jev']['costUsd']+m['llm']['costUsd']+inp.get('costUsd',0)
  print(f"== {r}: {d['elapsedMs']/1000:.0f}s stop={stop} actions={d['actions']} states={d['states']} pages={d['pages']} entry={d['onEntryPage']} failed={d['failed']} hovers={d['hovers']} fills={len(d['inputs']['filled'])}")
  print(f"   states/min {c['statesPerMinute']} lastNewState {c['lastNewStateAtMs']/1000:.0f}s")
  print(f"   models: JEV {m['jev']['calls']+inp.get('calls',0)} calls, LLM {m['llm']['calls']} calls, ${cost:.5f}; judge {{k:v for k,v in d['judge'].items() if k in ('answeredByJev','uncertain','answeredByLlm','cacheHits')}}")
  for p in sorted(c['pages'],key=lambda p:-p['classesSeen'])[:8]:print(f"   {p['page'].split('okx.com')[-1] or '/':38} classes {p['classesExecuted']:3}/{p['classesSeen']:3} ({p['classCoverage']:.0%})  text blocks {p['textBlocksSeen']:4} revealed {p['textBlocksRevealedByActions']}")
  print('   findings',d['findings'])
