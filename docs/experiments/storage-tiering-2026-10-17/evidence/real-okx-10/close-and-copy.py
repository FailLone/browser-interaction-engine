"""Reuse the settled-run closure once; never open the authoritative database."""
import hashlib
from pathlib import Path

here = Path(__file__).resolve().parent
reference = here.parent / 'real-okx-9/close-and-copy.py'
source = reference.read_text()
assert hashlib.sha256(reference.read_bytes()).hexdigest() == '056ba491d577d5051e5fdda0a4c8c647788ad03a82859a90cdd3d5ac5bfb3626'
for before, after in [
    ("SOURCE = ROOT / '.data/okx-storage-acceptance-20261017-v2'", "SOURCE = ROOT / '.data/okx-storage-acceptance-20261017-v3'"),
    ("FROZEN = ROOT / '.data/okx-storage-acceptance-20261017-v1'", "FROZEN = ROOT / '.data/okx-storage-acceptance-20261017-v2'"),
    ("'real-okx-8/closed-evidence.json'", "'real-okx-9/closed-evidence.json'"),
    ('Frozen run 8 changed', 'Frozen run 9 changed'),
    ('run8FrozenBytesUnchanged', 'run9FrozenBytesUnchanged'),
    ('frozen run 8.', 'frozen run 9.'),
    ('bie-run9-receipt-audit-', 'bie-run10-receipt-audit-'),
    ('run8Unchanged', 'run9Unchanged'),
]:
    assert source.count(before) == 1
    source = source.replace(before, after)
exec(compile(source, str(reference), 'exec'), {'__file__': str(Path(__file__).resolve()), '__name__': '__main__'})
