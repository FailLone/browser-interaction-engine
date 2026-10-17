#!/usr/bin/env python3
"""One integration gate, not a repetition of codec/reader/collector unit gates."""
import hashlib, json, os, pathlib, subprocess, time

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[4]
NODEBIN = '/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin'
assert not (HERE / 'result.json').exists(), 'Never overwrite a completed checkpoint'
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
files = ['packages/adapter-playwright/src/browser.ts', 'packages/adapter-playwright/src/owner-dependencies.ts',
         'packages/adapter-playwright/src/owner-dependency-codec.ts', 'packages/adapter-playwright/src/types.ts',
         'packages/browser/src/document-coverage.ts', 'tests/owner-dependency-helpers.ts',
         'tests/document-operation-coverage.test.ts', 'tests/document-dispatch-witness.test.ts',
         'tests/owner-dependency-budget-allocation.test.ts', 'tests/native-dependency-coverage.test.ts']
before = {p: sha(ROOT / p) for p in files}
env = os.environ.copy(); env['PATH'] = NODEBIN + ':' + env['PATH']; env['NODE_OPTIONS'] = ''
pattern = ('seed checkpoint|shares receipt coverage|consumes the public proof|retains an unknown receipt|'
           'does not credit retained owner A|binds a stable actual supplied value|'
           'preserves complete required roots|does not change required proof|'
           'proves a stable complete real receipt|rejects a changed nonlocal hidden value')
steps = [('types', ['pnpm', 'typecheck']), ('production-boundaries', ['pnpm', 'exec', 'vitest', 'run',
         'tests/document-operation-coverage.test.ts', 'tests/document-dispatch-witness.test.ts',
         'tests/owner-dependency-budget-allocation.test.ts', 'tests/native-dependency-coverage.test.ts',
         '-t', pattern])]
report = {'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
          'reason': 'Production now serializes compact v3; verify real dispatch hash, receipt/frontier/plugin consumption, A/B and unknown guards, and optional exhaustion across that changed boundary.',
          'sourceBefore': before, 'steps': [],
          'priorTypeFailure': {'run': 1, 'exitCode': 2, 'file': 'tests/document-dispatch-witness.test.ts',
               'diagnosis': 'Seven TS2339 errors from direct raw graph property access after Observation became a union. The read-only test helper now decodes the graph; no product change or behavior rerun.',
               'repeatReason': 'Fix the reported consumer type errors; this final integration type check also includes new collector contracts.'},
          'scope': 'Owned ephemeral local fixture servers/browsers and in-memory stores only. No existing browser, original task database, service, full suite, or performance benchmark.'}
for name, command in steps:
    start = time.time()
    with (HERE / (name + '.log')).open('x') as stream:
        result = subprocess.run(command, cwd=ROOT, env=env, stdout=stream, stderr=subprocess.STDOUT)
    report['steps'].append({'name': name, 'command': command, 'exitCode': result.returncode,
                           'seconds': time.time() - start, 'logSha256': sha(HERE / (name + '.log'))})
    if result.returncode: break
report['sourceAfter'] = {p: sha(ROOT / p) for p in files}
report['sourcesUnchanged'] = report['sourceBefore'] == report['sourceAfter']
report['allPassed'] = len(report['steps']) == 2 and all(s['exitCode'] == 0 for s in report['steps']) and report['sourcesUnchanged']
with (HERE / 'result.json').open('x') as stream: json.dump(report, stream, indent=2); stream.write('\n')
print(json.dumps({'head': report['head'], 'steps': report['steps'], 'sourcesUnchanged': report['sourcesUnchanged'], 'allPassed': report['allPassed']}, indent=2))
raise SystemExit(0 if report['allPassed'] else 1)
