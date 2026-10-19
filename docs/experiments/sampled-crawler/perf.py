import json,sys
for r in sys.argv[1:]:
  ev=[json.loads(l) for l in open(f'work/claude-probe/{r}/events.jsonl')];d=json.load(open(f'work/claude-probe/{r}/summary.json'))
  bt=0
  for i,e in enumerate(ev):
    if e['type']=='backtrack':
      nxt=next((x for x in ev[i+1:] if x['type'] in('action','stop')),None)
      if nxt: bt+=nxt['at']-e['at']
  p=0;ft=0;nf=0
  for e in ev:
    if e['type']=='action' and e['outcome']=='failed':ft+=e['at']-p;nf+=1
    if e['type'] in('action','backtrack','state','judgement'):p=e['at']
  print(f"{r}: {d['elapsedMs']/1000:.0f}s actions={d['actions']} states={d['states']} pages={d['pages']} backtracks={d['backtracks']} historyBacks={d.get('historyBacks','-')} backtrack-time={bt/1000:.0f}s failed={nf} failed-time={ft/1000:.1f}s actions/min={d['actions']/(d['elapsedMs']/60000):.1f}")
