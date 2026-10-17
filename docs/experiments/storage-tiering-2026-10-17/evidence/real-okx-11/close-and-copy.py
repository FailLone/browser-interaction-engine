"""Prepared only: root may invoke --closed-copy after formal run11 settlement."""
import hashlib
from pathlib import Path

here = Path(__file__).resolve().parent
reference = here.parent / 'real-okx-10/close-and-copy.py'
source = reference.read_text()
assert hashlib.sha256(reference.read_bytes()).hexdigest() == 'f9e23c0ff80d2b9e70eda25c1422c2b6246f68a2b8511c0b14bcc0f6fe87dbc1', 'Retained close/copy tool changed'
for before, after in [
    ("\"SOURCE = ROOT / '.data/okx-storage-acceptance-20261017-v3'\"", "\"SOURCE = ROOT / '.data/okx-storage-acceptance-20261017-v4'\""),
    ("\"FROZEN = ROOT / '.data/okx-storage-acceptance-20261017-v2'\"", "\"FROZEN = ROOT / '.data/okx-storage-acceptance-20261017-v3'\""),
    ("\"'real-okx-9/closed-evidence.json'\"", "\"'real-okx-10/closed-evidence.json'\""),
    ("'Frozen run 9 changed'", "'Frozen run 10 changed'"),
    ("'run9FrozenBytesUnchanged'", "'run10FrozenBytesUnchanged'"),
    ("'frozen run 9.'", "'frozen run 10.'"),
    ("'bie-run10-receipt-audit-'", "'bie-run11-receipt-audit-'"),
    ("'run9Unchanged'", "'run10Unchanged'"),
]:
    assert source.count(before) == 1, 'Expected one close/copy transform site'
    source = source.replace(before, after)
exec(compile(source, str(reference), 'exec'), {'__file__': str(Path(__file__).resolve()), '__name__': '__main__'})
