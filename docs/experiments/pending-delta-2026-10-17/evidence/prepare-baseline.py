"""Create an isolated git archive with workspace imports rooted in that archive.

External installed dependencies are reused read-only. The caller must supply the
same installed dependency versions as the original experiment for reproduction.
"""
from pathlib import Path
import argparse
import io
import json
import subprocess
import tarfile
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--repo', required=True)
parser.add_argument('--revision', default='7cf3918d4e4da12346b1a091f0d2ddfbcdb65b35')
args = parser.parse_args()
repo = Path(args.repo).resolve()
root = Path(tempfile.mkdtemp(prefix='bie-pending-baseline-reproduction-'))
data = subprocess.check_output(['git', 'archive', args.revision], cwd=repo)
with tarfile.open(fileobj=io.BytesIO(data)) as archive:
    archive.extractall(root)
modules = [Path('node_modules')] + [p.relative_to(repo) for top in ['packages', 'apps'] for p in (repo/top).glob('*/node_modules')]
for relative in modules:
    source, destination = repo/relative, root/relative
    if not source.is_dir():
        continue
    destination.mkdir(parents=True, exist_ok=True)
    for entry in source.iterdir():
        if entry.name in ['.vite', '.vite-temp', '.bin']:
            continue
        if entry.name == '@interaction':
            (destination/entry.name).mkdir(exist_ok=True)
            for package in entry.iterdir():
                target = package.resolve().relative_to(repo)
                (destination/entry.name/package.name).symlink_to(root/target, target_is_directory=True)
        else:
            (destination/entry.name).symlink_to(entry.resolve(), target_is_directory=entry.is_dir())
print(json.dumps({'revision': args.revision, 'sourceRoot': str(root), 'cleanup': 'Remove only this generated archive when finished.'}, indent=2))
