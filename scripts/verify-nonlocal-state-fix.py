"""Run the unchanged e05f511 measurements against frozen before/after sources.

Node 24 on PATH:
  python3 scripts/verify-nonlocal-state-fix.py BASE_EXPORT --fix-revision COMMIT
The baseline must be an independent git archive, never a live checkout. Only
these scripts create their own fixtures/browsers/stores; no existing service or
task store is accessed. This entry point never prepares or changes product code.
"""
import argparse
import hashlib
import io
import json
import os
import subprocess
import tarfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE_REV = "1ed22389d07c34a7cca778f7802ed14c2701d94d"
SCRIPT_REV = "e05f5118821a75f6f0c010b7027cfc30012a85b7"
OUT = ROOT / "docs/experiments/nonlocal-state-fix-2026-10-16"
KINDS = ("conditions", "recovery", "continuation", "input-identity")
CONFIGS = ("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "vitest.config.ts", "tsconfig.json", "tsconfig.build.json")
sha = lambda data: hashlib.sha256(data).hexdigest()
now = lambda: datetime.now(timezone.utc).isoformat()


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def audit(root, commit):
    files = {}
    with tarfile.open(fileobj=io.BytesIO(git("archive", commit))) as archive:
        for member in archive:
            if not member.isfile() or not (member.name.startswith(("packages/", "apps/")) or member.name in CONFIGS):
                continue
            actual = (root / member.name).read_bytes()
            if actual != archive.extractfile(member).read():
                raise RuntimeError(f"Product differs from frozen source: {root / member.name}")
            files[member.name] = sha(actual)
    # Catch a source import satisfied only by an uncommitted extra module.
    for top in ("packages", "apps"):
        for directory, dirs, names in os.walk(root / top):
            dirs[:] = [name for name in dirs if name not in ("node_modules", "dist", ".git", ".data", ".vite", "coverage")]
            for name in names:
                path = Path(directory) / name
                relative = str(path.relative_to(root))
                if path.suffix in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json") and relative not in files:
                    raise RuntimeError(f"Extra runtime source not present in commit: {path}")
    # Workspace packages must resolve inside the tested source tree.
    modules = root / "node_modules/@interaction"
    for package in modules.iterdir():
        if not package.resolve().is_relative_to(root / "packages"):
            raise RuntimeError(f"Workspace dependency escapes isolated source: {package}")
    return {"root": str(root), "commit": commit, "files": files, "mismatches": []}


def script_audit(roots):
    result = {}
    for kind in KINDS:
        file = Path("scripts") / f"verify-exploration-{kind}.ts"
        expected = git("show", f"{SCRIPT_REV}:{file}")
        for root in roots:
            if (root / file).read_bytes() != expected:
                raise RuntimeError(f"Measurement script changed: {root / file}")
        result[str(file)] = sha(expected)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline_export", type=Path)
    parser.add_argument("--fix-revision", required=True)
    parser.add_argument("--audit-only", action="store_true", help="Check frozen sources and scripts without starting experiments or creating output")
    args = parser.parse_args()
    base = args.baseline_export.resolve()
    fix = git("rev-parse", f"{args.fix_revision}^{{commit}}").decode().strip()
    if (base / ".git").exists() or base == ROOT:
        raise SystemExit("Use an isolated baseline export, not a managed/live checkout")
    if git("rev-parse", "HEAD").decode().strip() != fix:
        raise SystemExit("HEAD must equal --fix-revision: the unchanged continuation script records HEAD")
    node = subprocess.check_output(["node", "--version"], text=True).strip()
    if not node.startswith("v24."):
        raise SystemExit("Node 24 is required")
    products_before = [audit(base, BASE_REV), audit(ROOT, fix)]
    # The committed baseline already contains these unchanged scripts. Do not
    # silently replace a changed measurement in either source tree.
    scripts_before = script_audit((base, ROOT))
    if args.audit_only:
        print(json.dumps({"products": [{"root": p["root"], "commit": p["commit"], "files": len(p["files"])} for p in products_before],
                          "scripts": scripts_before, "node": node, "noExperimentsStarted": True}, indent=2))
        return
    # A failed/partial run is retained too. Never overwrite previous evidence.
    if OUT.exists() and any(p.name == "source.json" or p.name.startswith(KINDS) for p in OUT.iterdir()):
        raise SystemExit("Output already contains a run; preserve it and inspect before any follow-up")
    OUT.mkdir(parents=True, exist_ok=True)
    versions = [("baseline", base, BASE_REV), ("fixed", ROOT, fix)]
    metadata = {"schemaVersion": 1, "startedAt": now(), "node": node,
        "playwright": {label: json.loads((root / "node_modules/playwright/package.json").read_text())["version"] for label, root, _ in versions},
        "productsBefore": products_before, "scriptRevision": SCRIPT_REV, "scripts": scripts_before, "commands": [],
        "protocol": {"trials": 160, "repeats": 5, "priceTicks": 100,
            "recoveryApi": {"baseline": "reachExplorationTarget", "fixed": "reachExplorationTarget"},
            "recoveryScriptVariant": "refactor",
            "variantNote": "The unchanged recovery script switches APIs by variant; both revisions already support target recovery, so both use refactor. File labels identify source revisions.",
            "otherVariantControls": "Continuation label affects metadata/output/temp-directory names only; conditions and input-identity revisions are provenance only.",
            "ordering": "Condition batches baseline then fixed; recovery order alternates by replicate; continuation and input batches baseline then fixed.",
            "limits": "Controlled fixtures and deterministic/counting providers; timings are descriptive, not real-site performance or exhaustion evidence."}}
    if len(set(metadata["playwright"].values())) != 1:
        raise RuntimeError("Playwright versions differ")

    def save():
        (OUT / "source.json").write_text(json.dumps(metadata, indent=2) + "\n")

    def run(kind, label, root, revision, replicate=None):
        filename = f"{kind}-{label}" + (f"-r{replicate}" if replicate else "")
        output = str(OUT / (filename + ".json"))
        command = ["pnpm", "exec", "tsx", "--conditions=development", f"scripts/verify-exploration-{kind}.ts"]
        if kind == "conditions":
            command += [f"--revision={revision}", f"--output={output}", "--runs=5", "--ticks=100"]
        elif kind == "recovery":
            command += ["--variant", "refactor", "--revision", revision, "--replicate", str(replicate), "--output", output]
        elif kind == "continuation":
            command += ["--label", label, "--revision", revision, "--repeats", "5", "--out", output]
        else:
            command += ["--revision", revision, "--runs", "5", "--output", output]
        entry = {"kind": kind, "variant": label, "command": command, "cwd": str(root), "startedAt": now()}
        metadata["commands"].append(entry); save()
        with (OUT / (filename + ".log")).open("x") as log:
            result = subprocess.run(command, cwd=root, stdout=log, stderr=subprocess.STDOUT)
        entry.update(exitCode=result.returncode, finishedAt=now()); save()
        print(filename, result.returncode, flush=True)
        if result.returncode:
            raise RuntimeError("Experiment command failed; saved evidence must be inspected before follow-up")

    save()
    try:
        for version in versions:
            run("conditions", *version)
        for replicate in range(1, 6):
            for version in versions if replicate % 2 else versions[::-1]:
                run("recovery", *version, replicate=replicate)
        for kind in ("continuation", "input-identity"):
            for version in versions:
                run(kind, *version)
        metadata["productsAfter"] = [audit(base, BASE_REV), audit(ROOT, fix)]
        metadata["scriptsAfter"] = script_audit((base, ROOT))
        if git("rev-parse", "HEAD").decode().strip() != fix:
            raise RuntimeError("HEAD changed during comparison")
        metadata["finishedAt"] = now()
    except BaseException as error:
        metadata["failure"] = {"at": now(), "type": type(error).__name__, "message": str(error)}
        raise
    finally:
        save()


if __name__ == "__main__":
    main()
