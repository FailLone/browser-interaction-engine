"""Package closed JSON/log evidence; never open or mutate an engine database."""
import gzip, hashlib, json, pathlib

root = pathlib.Path(__file__).resolve().parents[3]
raw = root / '.data/component-correspondence'
out = pathlib.Path(__file__).resolve().parent / 'evidence'
out.mkdir(exist_ok=True)
files = list(raw.glob('*.log')) + list(raw.glob('plugin-*-proof-*.json'))
files += [raw / n for n in ['paid-ledger.json', 'source-freeze.json', 'original-test-files.json',
    'original-251-1.json', 'original-251-frozen.json', 'original-251-1-comparison.json',
    'original-251-frozen-comparison.json', 'okx-first-comparison.json',
    'dispatch-instrumentation.json', 'dispatch-instrumentation-2.json',
    'local-replay-1-cursor.json', 'local-replay-1-cursor.json.jsonl',
    'local-replay-final-cursor.json', 'local-replay-final-cursor.json.jsonl',
    'source-final-freeze.json', 'original-251-final-freeze.json', 'original-251-final-freeze-comparison.json',
    'paid-summary.json', 'opportunity-cost-before.json', 'opportunity-cost-after.json',
    'opportunity-cost-comparison.json', 'okx-final-comparison.json', 'final-integrity.json']]
files += [raw/'diagnosis'/n for n in ['opportunities-2.json', 'sdk-pairs-2.json']]
for run in ['okx-control-1', 'okx-enhanced-1', 'local-full-replay-1', 'local-full-replay-final', 'okx-enhanced-final']:
    files += [p for p in (raw/run).iterdir() if p.suffix in {'.json', '.jsonl', '.log', '.diff'}]
manifest = []
for path in sorted(set(files)):
    if not path.exists():
        raise FileNotFoundError(path)
    data = path.read_bytes()
    dest = out / (str(path.relative_to(raw)).replace('/', '__') + '.gz')
    packed = gzip.compress(data, compresslevel=9, mtime=0)
    dest.write_bytes(packed)
    manifest.append({'source': str(path.relative_to(root)), 'archive': dest.name,
        'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
        'archiveBytes': len(packed), 'archiveSha256': hashlib.sha256(packed).hexdigest()})
(out/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
print(json.dumps({'files': len(manifest), 'archiveBytes': sum(x['archiveBytes'] for x in manifest)}))
