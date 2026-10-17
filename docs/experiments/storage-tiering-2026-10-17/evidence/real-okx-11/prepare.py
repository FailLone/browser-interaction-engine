"""Prepare v4 only after root confirms the fixed release and merge to main.

This file is prepared, not executed. Reuse the fixed run9 copy implementation:
mutable files are independent; immutable blobs may share hard links with v3.
"""
from pathlib import Path
import hashlib

here = Path(__file__).resolve().parent
reference = here.parent / 'real-okx-9/prepare.py'
expected = '170ce16c2a020bdf215325b9e448fcaa07030ed38aaa3e8a616a6e2f6473d172'
assert hashlib.sha256(reference.read_bytes()).hexdigest() == expected, 'Retained preparation changed'
source = reference.read_text()
for before, after in [
    ("SOURCE = ROOT / '.data/okx-storage-acceptance-20261017-v1'", "SOURCE = ROOT / '.data/okx-storage-acceptance-20261017-v3'"),
    ("DEST = ROOT / '.data/okx-storage-acceptance-20261017-v2'", "DEST = ROOT / '.data/okx-storage-acceptance-20261017-v4'"),
    ("'real-okx-8/closed-evidence.json'", "'real-okx-10/closed-evidence.json'"),
    ('Run 8 remains frozen.', 'Run 10 remains frozen.'),
    ('assert sys.argv[2] == revision',
     "assert sys.argv[2] == revision\n"
     "assert revision == subprocess.check_output(['git', 'rev-parse', 'main'], cwd=ROOT, text=True).strip(), 'HEAD commit must equal local main'\n"
     "subprocess.check_call(['git', 'merge-base', '--is-ancestor', 'f3c4316', revision], cwd=ROOT)"),
]:
    assert source.count(before) == 1, 'Expected one preparation transform site'
    source = source.replace(before, after)
exec(compile(source, str(reference), 'exec'), {'__file__': str(Path(__file__).resolve()), '__name__': '__main__'})
