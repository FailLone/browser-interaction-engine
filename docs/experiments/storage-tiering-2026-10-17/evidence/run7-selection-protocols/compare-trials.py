#!/usr/bin/env python3
"""Exact trial-coordinate comparisons using the unchanged historical behavior projection."""
import collections
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
sys.dont_write_bytecode = True
here = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('protocol_summary', here / 'summarize.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def raw_rows(directory):
    read = lambda name: json.loads((directory / name).read_text())
    rows = {'conditions': read('conditions.json')['results'], 'continuation': read('continuation.json')['runs'], 'inputIdentity': read('input-identity.json')['results'], 'recovery': [row for n in range(1, 6) for row in read(f'recovery-refactor-r{n}.json')['runs']]}
    result = {}
    for kind, values in rows.items():
        for row in values:
            repeat = row.get('run', row.get('iteration', row.get('replicate')))
            key = (kind, row['scenario'], repeat)
            if key in result: raise ValueError(f'Duplicate trial {key}')
            result[key] = module.behavior(kind, row)
    if len(result) != 80: raise ValueError(f'Expected 80 trials, got {len(result)}')
    return result
current = raw_rows(here)
reports = {}
for label, name in [('900edf7', 'run6-factory-protocols')]:
    baseline = raw_rows(here.parent / name)
    if set(current) != set(baseline): raise ValueError('Trial-coordinate sets differ')
    pairs = []
    for key in sorted(current):
        diffs = module.differences(baseline[key], current[key])
        pairs.append({'kind': key[0], 'scenario': key[1], 'repeat': key[2], 'equal': not diffs, 'differences': diffs})
    counts = collections.Counter(re.sub(r'\[\d+\]', '[]', d['path']) for pair in pairs for d in pair['differences'])
    reports[label] = {'baselineDirectory': name, 'pairedTrials': len(pairs), 'equalTrials': sum(p['equal'] for p in pairs), 'changedTrials': sum(not p['equal'] for p in pairs), 'allBehaviorEqual': all(p['equal'] for p in pairs), 'changedFieldCounts': dict(counts), 'trials': pairs}
output = {'method': 'Same unmodified summarizer.behavior projection; paired by protocol/scenario/run-or-iteration-or-replicate. No oracle or ignored-field change.', 'summarizerSha256': hashlib.sha256((here/'summarize.py').read_bytes()).hexdigest(), 'comparisons': reports}
(here/'trial-comparison.json').write_text(json.dumps(output, indent=2)+'\n')
print(json.dumps({label: {k: v for k, v in value.items() if k != 'trials'} for label, value in reports.items()}, indent=2))
