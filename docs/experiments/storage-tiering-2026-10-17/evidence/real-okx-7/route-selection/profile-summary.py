#!/usr/bin/env python3
"""Summarize sampled stacks below scheduledRecovery; inclusive groups overlap."""
import json,pathlib,collections,hashlib
HERE=pathlib.Path(__file__).resolve().parent
reports=[]
for name in ['sqlite.cpuprofile','controlled-sqlite.cpuprofile']:
 p=HERE/name;profile=json.loads(p.read_text());nodes={n['id']:n for n in profile['nodes']};parents={child:n['id'] for n in profile['nodes'] for child in n.get('children',[])}
 inclusive=collections.Counter();self_time=collections.Counter();groups=collections.Counter();selected=0;all_samples=0
 def key(n):
  f=n['callFrame'];url=f.get('url','');url=url[url.index('/packages/'):] if '/packages/' in url else url
  return (f.get('functionName',''),url,f.get('lineNumber',-1)+1)
 for node,us in zip(profile.get('samples',[]),profile.get('timeDeltas',[])):
  all_samples+=us;chain=[];at=node
  while at is not None:chain.append(nodes[at]);at=parents.get(at)
  hit=next((i for i,n in enumerate(chain) if n['callFrame']['functionName']=='scheduledRecovery'),None)
  if hit is None:continue
  chain=chain[:hit+1];selected+=us
  for k in {key(n) for n in chain}:inclusive[k]+=us
  self_time[key(chain[0])]+=us
  frames=[n['callFrame'] for n in chain]
  checks={'storage_sqlite_inclusive':any('/packages/storage-sqlite/' in f.get('url','') or 'better-sqlite3' in f.get('url','') for f in frames),
   'scope_projection_inclusive':any(f['functionName'] in ['scopeFor','actionScope','browserControlCorrespondence','browserTargetBinding'] for f in frames),
   'target_conditions_inclusive':any(f['functionName'] in ['browserTargetConditions','browserBranchConditions'] for f in frames),
   'interaction_transition_inclusive':any(f['functionName']=='interactionTransition' for f in frames),
   'decoder_inclusive':any(f['functionName']=='decodeStoredEntity' for f in frames)}
  for group,found in checks.items():
   if found:groups[group]+=us
 def rows(counter):return [{'function':k[0],'file':k[1],'profilerLine':k[2],'sampledMs':v/1000,'percentOfSelectedStacks':v/selected*100 if selected else 0} for k,v in counter.most_common(35)]
 reports.append({'profile':name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'allSampledMs':all_samples/1000,'scheduledRecoveryStackSampledMs':selected/1000,'inclusiveGroupsMs':{k:v/1000 for k,v in groups.items()},'inclusiveTop':rows(inclusive),'selfTop':rows(self_time),
  'limits':['Samples include only stacks containing scheduledRecovery; GC or JIT attributed to other roots is excluded.','Inclusive rows/groups overlap and must not be added.','TSX transpilation often reports line1; source function names/file paths, not these generated line numbers, identify locations.','Profile is diagnostic and excluded from formal paired medians.']})
(HERE/'profile-summary.json').write_text(json.dumps(reports,indent=2)+'\n')
print(json.dumps([{k:r[k] for k in ['profile','scheduledRecoveryStackSampledMs','inclusiveGroupsMs']} for r in reports]))
