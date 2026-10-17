#!/usr/bin/env python3
"""Make the final report and manifest; deduplicate only byte-identical semantic artifacts."""
import gzip,hashlib,json,pathlib,shutil
HERE=pathlib.Path(__file__).resolve().parent
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def write(path,value):path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
index=HERE/'semantic-artifact-index.json'
if not index.exists():
 objects=HERE/'semantic-objects';objects.mkdir(exist_ok=True);rows=[]
 for source in sorted(HERE.glob('*-semantic.json.gz')):
  stored=source.read_bytes();logical=gzip.decompress(stored);digest=hashlib.sha256(logical).hexdigest();dest=objects/(digest+'.json.gz')
  if dest.exists():assert dest.read_bytes()==stored
  else:shutil.copy2(source,dest)
  rows.append({'originalPath':source.name,'archivePath':str(dest.relative_to(HERE)),'logicalBytes':len(logical),'logicalSha256':digest,'storedBytes':len(stored),'storedSha256':sha(dest)})
 assert len(rows)==12
 write(index,{'policy':'Full original semantic bytes retained, with exact-byte deduplication only. Trial paths resolve through this index. No IDs, order, task fields, original events or decisions removed.','artifacts':rows})
 for row in rows:(HERE/row['originalPath']).unlink()
s=json.loads((HERE/'summary.json').read_text());e=s['execution'];assert e['allExitZero'] and len(e['comparisons'])==6 and all(c['equal'] for c in e['comparisons'])
for row in json.loads(index.read_text())['artifacts']:
 stored=(HERE/row['archivePath']).read_bytes();logical=gzip.decompress(stored)
 assert len(stored)==row['storedBytes'] and hashlib.sha256(stored).hexdigest()==row['storedSha256'] and len(logical)==row['logicalBytes'] and hashlib.sha256(logical).hexdigest()==row['logicalSha256']
lines=['# Task-store hot-write follow-up','',
'Fixed archives: `106a1cdfddfe3e73cab9e01b28ba4dd8439653e2` → `855a3a47b513305077ef160a8d4d5716fe1780f9`. Twelve serial fresh processes completed successfully. Six baseline/current comparisons preserve the full initial/final task, ordered occurrence handles, original decisions and audit events. Every intermediate task was also checked against its complete expected state. Archive sources, full private frozen copy, fixture seeds and original frozen database hashes remained unchanged.','',
'The run7 case improves unchanged-round CAS by **13.50%**, active-item CAS by **15.78%**, and compatibility saves whose items are unchanged by **30.28%**. The history case improves those operations by **16.73%**, **17.68%**, and **39.77%** respectively. These are local ExplorerStore costs, not whole browser-round throughput.','',
'**Measured cost:** canonical JSON parsing of changed items moved into the write transaction. Changed-round transaction-body time rises by 0.521 ms (+48.4%) for run7 and 0.752 ms (+74.7%) for the history fixture. History changed-round total CAS rises 12.67%. The complete-read implementation and persisted layout are unchanged; no new full-read or storage saving is claimed.','',
'## Implementation and inputs','',
'The store now serializes/hashes each supplied record once, decoding canonical JSON only when the persisted content hash differs. It still respects a supplied toJSON result and derives all projections and packed values from that exact canonical string. A failed later write or stale CAS still rolls back all earlier transaction changes. No persistent cache, schema upgrade, new reference, deletion, or relaxed corruption check was added.','',
'Cold-packing uses the original eligibility and trigger, but first probes at most 64 eligible rows without transferring JSON to JavaScript. Below the threshold, it returns immediately. Threshold hits perform one extra bounded query before the original ordered pack. Old plain cold rows remain eligible on the next normal current-round delta; explicit maintenance still packs below the threshold. Tests cover 63/64, historical round promotion, older plain rows, unknown/occurrence retention and rollback.','',
'The unchanged run7 SQLite seed has 803 plan occurrences, one current round, 5,384 events and 123 decisions. Its 34 succeeded plan rows remain below the automatic packing threshold. Header JSON is 293,862 bytes, current-round JSON 446,912 bytes. The history fixture explicitly derives 5,000 plan rows from run7 values (4,990 succeeded, 10 unresolved) and adds one historical round. It is synthetic cost control, not replay or evidence of coverage.','',
'## Timings','',
'Values are milliseconds: median of each process’s per-operation median, then median across three fresh processes/version. Pairs run AB, BA, AB for each input. First full read is the first API read in a fresh process, without evicting OS page caches. Initialization, individual reads/writes and maintenance are separate. Correctness assertions, byte accounting and audit export are outside operation clocks.','']
labels={'startup':'Initialization','firstFullRead':'First full read','warmFullRead':'Repeated full read','activeRead':'Active item read','headerRead':'Header read','headerOnlyCAS':'Header-only CAS','unchangedRoundCAS':'Unchanged-round CAS','activeItemCAS':'Active-item CAS','changedRoundCAS':'Changed-round CAS','unchangedItemsFullSave':'Unchanged-items compatibility save','maintenance':'Explicit maintenance + reclaim'}
for name,data in s['scenarios'].items():
 a,b=data['variants']['baseline'],data['variants']['current'];lines += [f'### {name}','','| Operation | Baseline ms | Current ms | Change |','|---|---:|---:|---:|']
 for key,label in labels.items():
  aa,bb=a['timings'][key]['medianMs'],b['timings'][key]['medianMs'];lines.append(f'| {label} | {aa:.3f} | {bb:.3f} | {(bb/aa-1)*100:+.2f}% |')
 lines += ['','Transaction body only (excludes BEGIN/COMMIT and serialization before the transaction):','','| Write | Baseline ms | Current ms | Change |','|---|---:|---:|---:|']
 for key in ['headerOnlyCAS','unchangedRoundCAS','activeItemCAS','changedRoundCAS','unchangedItemsFullSave']:
  aa,bb=a['transactionBodies'][key]['medianMs'],b['transactionBodies'][key]['medianMs'];lines.append(f'| {labels[key]} | {aa:.3f} | {bb:.3f} | {(bb/aa-1)*100:+.2f}% |')
 aa,bb=a['medianMaxRSSKiB'],b['medianMaxRSSKiB'];lines += ['',f'Process maxRSS median: **{aa:,.0f} → {bb:,.0f} KiB**, {(bb-aa)/1024:+.2f} MiB ({(bb/aa-1)*100:+.2f}%). This includes complete task/occurrence comparisons, fixture data, retained audit material and semantic serialization. The measured difference is retained, but it is not isolated production heap.','']
lines += ['## Work counts and space','',
'A separate untimed final CAS instruments JSON.parse and cold-row transfers. For run7, baseline parses the unchanged 447,128-byte round (it includes nine intentionally appended cost-only strings) and transfers 34 cold rows / 83,288 JSON bytes. Current parses zero item bytes, transfers zero cold-row JSON bytes and performs one bounded qualification probe. History similarly eliminates the unchanged-round parse; its cold history was already packed, so both transfer zero cold JSON. These counts do not instrument the timed loops.','',
'Both versions have exactly the same logical task bytes and DB/WAL/SHM sizes at each reported boundary. Explicit maintenance’s reduction is existing schema4 functionality, not a new space benefit.','',
'| Input | Initial / final task JSON bytes | DB / WAL / SHM before maintenance | DB after maintenance | DB after close |','|---|---:|---:|---:|---:|']
for name,data in s['scenarios'].items():
 a,b=data['variants']['baseline'],data['variants']['current'];assert a['bytes']==b['bytes'];assert a['databaseFiles']==b['databaseFiles'];f=a['databaseFiles'][0];v=f['beforeMaintenance'];lines.append(f"| {name} | {a['bytes']['initialTask']:,} / {a['bytes']['finalTask']:,} | {v['db']:,} / {v['-wal']:,} / {v['-shm']:,} | {f['afterMaintenance']['db']:,} | {f['closed']['db']:,} |")
lines += ['','WAL is zero after maintenance; SHM is 32,768 bytes until the last connection closes, then zero. All samples within each version have these same sizes.','',
'## Validation and limits','',
'Four exact test files passed 47/47: the new write-cost tests plus existing packed, normalized and delta store suites. Logs are `focused-7.log` and `store-tests-47.log`. Original independent business-ID occurrences, plan order, all unknown/recovery debt, complete audit payloads and stale-writer rejection remain checked. The benchmark deliberately updates revision/time, one active row reason and current-round actions/tried; it makes no SDK execution or coverage claim. Random CAS tokens are checked for changes and stale rejection rather than equal random bytes across processes.','',
'The initially attempted joined-array JSON.parse path was slower than per-row parsing in its small feasibility probe and was rejected; `feasibility.json` retains that negative result. The current full-read implementation is unchanged. Small apparent gains/losses in read-only phases or initialization are samples, not evidence of an implemented read optimization. Changed-round lock duration is a real implementation tradeoff and remains a follow-up consideration for multiple writers.','',
'Reproduce with `runner.py --prepare`, then `runner.py --run` in a fresh evidence directory, then `finalize.py`. Requires the complete frozen-7 input, Node 24.22.0, installed dependencies and both Git revisions. The tracked archive helper path and SHA are in `preparation.json`; workspace imports resolve within each exact source archive. `initial-inspect.mjs` and `initial-probe.mjs` reproduce the earlier feasibility step using a complete private copy: put its parent directory (containing frozen-copy) in `/tmp/bie-task-store-next-path`, then invoke those files with Node 24. They never construct ExplorerStore.','',
'Complete semantic gzip bytes are retained under `semantic-objects`; `semantic-artifact-index.json` maps all twelve original filenames without discarding full input/output/audit content. `artifact-manifest.json` hashes all evidence files except itself. No private database or large temporary material was copied into the repository. Original and new evidence are separate. Formal workers ran after the root/lifecycle CPU release and before releasing it to the next test agent; light report/Git activity on the same machine remains possible.','']
(HERE/'report.md').write_text('\n'.join(lines))
manifest=[{'path':str(p.relative_to(HERE)),'bytes':p.stat().st_size,'sha256':sha(p)} for p in sorted(HERE.rglob('*')) if p.is_file() and p.name!='artifact-manifest.json']
write(HERE/'artifact-manifest.json',manifest)
print(json.dumps({'reportSha256':sha(HERE/'report.md'),'summarySha256':sha(HERE/'summary.json'),'manifestSha256':sha(HERE/'artifact-manifest.json'),'files':len(manifest)+1,'bytes':sum(r['bytes'] for r in manifest)+(HERE/'artifact-manifest.json').stat().st_size}))
