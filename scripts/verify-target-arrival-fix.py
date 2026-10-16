"""Run the unchanged e05f511 differential experiments in two isolated source trees.

Usage (Node 24 on PATH): python3 scripts/verify-target-arrival-fix.py BASE_EXPORT_DIR
The baseline must be an independent git archive, never a live worktree.
"""
import hashlib
import io
import json
import shutil
import subprocess
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = Path(sys.argv[1]).resolve()
OUT = ROOT / "docs/experiments/target-arrival-fix-2026-10-16"
BASE_REV = "4857ad571c19995480a4c149abd9b2868a94c965"
FIX_REV = "1ed22389d07c34a7cca778f7802ed14c2701d94d"
SCRIPT_REV = "e05f5118821a75f6f0c010b7027cfc30012a85b7"
if (BASE / ".git").exists() or BASE == ROOT:
    raise SystemExit("Use an isolated baseline export, not a managed/live checkout")
if any(OUT.glob("conditions-*.json")):
    raise SystemExit("Output already exists: retain prior results; do not overwrite a run")
OUT.mkdir(parents=True, exist_ok=True)
sha = lambda data: hashlib.sha256(data).hexdigest()


def audit(root, commit):
    archive = tarfile.open(fileobj=io.BytesIO(subprocess.check_output(["git", "archive", commit], cwd=ROOT)))
    files = {}
    for member in archive:
        if not member.isfile() or not (member.name.startswith(("packages/", "apps/")) or member.name in (
                "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "vitest.config.ts", "tsconfig.json", "tsconfig.build.json")):
            continue
        actual = (root / member.name).read_bytes()
        assert actual == archive.extractfile(member).read(), (root, member.name, "product differs from frozen source")
        files[member.name] = sha(actual)
    return {"root": str(root), "commit": commit, "files": files, "mismatches": []}


metadata = {"startedAt": datetime.now(timezone.utc).isoformat(), "node": subprocess.check_output(["node", "--version"], text=True).strip(),
            "playwright": json.loads((ROOT / "node_modules/playwright/package.json").read_text())["version"],
            "productsBefore": [audit(BASE, BASE_REV), audit(ROOT, FIX_REV)], "scriptRevision": SCRIPT_REV, "scripts": {}, "commands": []}
assert metadata["node"].startswith("v24.")
for name in ("conditions", "recovery", "continuation", "input-identity"):
    file = Path("scripts") / f"verify-exploration-{name}.ts"
    data = (ROOT / file).read_bytes()
    assert data == subprocess.check_output(["git", "show", f"{SCRIPT_REV}:{file}"], cwd=ROOT), (name, "measurement script changed")
    shutil.copyfile(ROOT / file, BASE / file)
    metadata["scripts"][str(file)] = sha(data)


def save():
    (OUT / "source.json").write_text(json.dumps(metadata, indent=2) + "\n")


def run(kind, variant, root, revision, replicate=None):
    label = "base" if variant == "baseline" and kind == "conditions" else variant
    filename = f"{kind}-{label}" + (f"-r{replicate}" if replicate else "")
    output = str(OUT / (filename + ".json"))
    command = ["pnpm", "exec", "tsx", "--conditions=development", f"scripts/verify-exploration-{kind}.ts"]
    if kind == "conditions":
        command += [f"--revision={revision}", f"--output={output}", "--runs=5", "--ticks=100"]
    elif kind == "recovery":
        command += ["--variant", variant, "--revision", revision, "--replicate", str(replicate), "--output", output]
    elif kind == "continuation":
        command += ["--label", variant, "--revision", revision, "--repeats", "5", "--out", output]
    else:
        command += ["--revision", revision, "--runs", "5", "--output", output]
    entry = {"command": command, "cwd": str(root), "startedAt": datetime.now(timezone.utc).isoformat()}
    metadata["commands"].append(entry)
    save()
    with (OUT / (filename + ".log")).open("w") as log:
        result = subprocess.run(command, cwd=root, stdout=log, stderr=subprocess.STDOUT)
    entry["exitCode"] = result.returncode
    entry["finishedAt"] = datetime.now(timezone.utc).isoformat()
    save()
    print(filename, result.returncode, flush=True)
    if result.returncode:
        raise SystemExit("Experiment command failed; inspect saved log before any follow-up")


versions = [("baseline", BASE, BASE_REV), ("refactor", ROOT, FIX_REV)]
save()
for version in versions:
    run("conditions", *version)
for replicate in range(1, 6):
    for version in versions if replicate % 2 else versions[::-1]:
        run("recovery", *version, replicate=replicate)
for kind in ("continuation", "input-identity"):
    for version in versions:
        run(kind, *version)
metadata["productsAfter"] = [audit(BASE, BASE_REV), audit(ROOT, FIX_REV)]
metadata["finishedAt"] = datetime.now(timezone.utc).isoformat()
save()
