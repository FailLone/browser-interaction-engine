#!/usr/bin/env python3
"""Compare complete task/event JSON; map only newly appended plan UUIDs by append order.
No keys/statuses/evidence/unknown/route/times/arrays are removed or normalized.
"""
import json,sys,pathlib,hashlib,re
UUID=re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',re.I)

def canonicalize(path):
 data=json.loads(pathlib.Path(path).read_text());initial=data['initial'];oldids=[row['id'] for row in initial['plan']];assert len(oldids)==len(set(oldids))
 known=set(oldids);mapping={};previous=oldids;allstates=[]
 for state in data['states']:
  ids=[row['id'] for row in state['task']['plan']];assert len(ids)==len(set(ids));assert ids[:len(previous)]==previous,'Prior plan row removed/reordered'
  for id in ids[len(previous):]:
   assert id not in known and UUID.fullmatch(id),'Only genuine newly appended UUIDs may be mapped';known.add(id);mapping[id]=f'__NEW_PLAN_APPEND_{len(mapping)+1:04d}__'
  previous=ids
 def normalize(v):
  if isinstance(v,str):return mapping.get(v,v) # Exact confirmed new IDs only, never substrings or arbitrary UUIDs.
  if isinstance(v,list):return [normalize(x) for x in v]
  if isinstance(v,dict):return {k:normalize(x) for k,x in v.items()} # Object keys preserved, even if a UUID would appear there.
  return v
 def contains_token(v):
  if isinstance(v,str):return v in set(mapping.values())
  if isinstance(v,list):return any(contains_token(x) for x in v)
  if isinstance(v,dict):return any(k in set(mapping.values()) or contains_token(x) for k,x in v.items())
  return False
 assert not contains_token(data),'Canonical placeholder collides with actual input'
 canon=normalize(data)
 # Original IDs are never mapped. Conditions, source IDs and keys stay byte-for-byte values unless they are actual new plan UUID references.
 assert canon['initial']==initial
 return canon,{'newPlanIdCount':len(mapping),'mapping':mapping,'states':len(data['states']),'canonicalSha256':hashlib.sha256(json.dumps(canon,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()}

def differences(a,b,path='$',limit=20):
 out=[]
 def walk(x,y,p):
  if len(out)>=limit:return
  if type(x)!=type(y):out.append({'path':p,'left':x,'right':y});return
  if isinstance(x,dict):
   if x.keys()!=y.keys():out.append({'path':p,'missingLeft':list(y.keys()-x.keys()),'missingRight':list(x.keys()-y.keys())})
   for k in x.keys()&y.keys():walk(x[k],y[k],p+'.'+k)
  elif isinstance(x,list):
   if len(x)!=len(y):out.append({'path':p+'.length','left':len(x),'right':len(y)})
   for i,(xx,yy) in enumerate(zip(x,y)):walk(xx,yy,f'{p}[{i}]')
  elif x!=y:out.append({'path':p,'left':x,'right':y})
 walk(a,b,path);return out

if __name__=='__main__':
 left,right,out=map(pathlib.Path,sys.argv[1:]);a,am=canonicalize(left);b,bm=canonicalize(right);diff=differences(a,b)
 report={'left':str(left),'right':str(right),'leftRawSha256':hashlib.sha256(left.read_bytes()).hexdigest(),'rightRawSha256':hashlib.sha256(right.read_bytes()).hexdigest(),'leftCanonical':am,'rightCanonical':bm,'equal':a==b,'differences':diff,'policy':'Only exact newly appended plan UUID values are replaced in append order. All keys/array order/original IDs/evidence/statuses/attempts/unknown/route data and timestamps remain.'};out.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'equal':report['equal'],'differences':diff[:3]}));sys.exit(0 if report['equal'] else 1)
