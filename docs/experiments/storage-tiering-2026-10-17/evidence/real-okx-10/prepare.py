"""Prepare one owned continuation only after the fixed product release passes."""
from pathlib import Path
import hashlib

here = Path(__file__).resolve().parent
reference = here.parent / 'real-okx-9/prepare.py'
source = reference.read_text()
expected = '170ce16c2a020bdf215325b9e448fcaa07030ed38aaa3e8a616a6e2f6473d172'
assert hashlib.sha256(reference.read_bytes()).hexdigest() == expected
for before, after in [
    ("SOURCE = ROOT / '.data/okx-storage-acceptance-20261017-v1'", "SOURCE = ROOT / '.data/okx-storage-acceptance-20261017-v2'"),
    ("DEST = ROOT / '.data/okx-storage-acceptance-20261017-v2'", "DEST = ROOT / '.data/okx-storage-acceptance-20261017-v3'"),
    ("'real-okx-8/closed-evidence.json'", "'real-okx-9/closed-evidence.json'"),
    ('Run 8 remains frozen.', 'Run 9 remains frozen.'),
]:
    assert source.count(before) == 1
    source = source.replace(before, after)
exec(compile(source, str(reference), 'exec'), {'__file__': str(Path(__file__).resolve()), '__name__': '__main__'})
