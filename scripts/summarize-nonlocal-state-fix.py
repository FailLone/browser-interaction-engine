"""Validate and summarize the frozen 160-trial nonlocal/state comparison.

Pure artifact inspection: no browsers or task stores. Both before/after recovery
runs must use the same target-recovery API. Passing these fixtures establishes
only the stated repair criteria, never arbitrary-page exploration/exhaustion.
"""
import argparse
import collections
import hashlib
import json
import math
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--input-dir", type=Path, default=ROOT / "docs/experiments/nonlocal-state-fix-2026-10-16")
OUT = parser.parse_args().input_dir.resolve()


def read(directory, name):
    return json.loads((directory / name).read_text())


def distribution(values):
    values = sorted(values)
    if not values:
        return None
    return {"min": min(values), "max": max(values), "sum": sum(values),
            "median": values[(len(values) - 1) // 2],
            "p95": values[math.ceil(len(values) * .95) - 1]}


def groups(rows):
    result = collections.defaultdict(list)
    for row in rows:
        result[row["scenario"]].append(row)
    return result


source = read(OUT, "source.json")
assert source.get("finishedAt"), "Comparison still running"
assert not source.get("failure"), source.get("failure")
assert source["productsBefore"] == source["productsAfter"], "Frozen product changed during comparison"
assert source["scripts"] == source["scriptsAfter"], "Measurement changed during comparison"
assert source["productsBefore"][0]["commit"] == "1ed22389d07c34a7cca778f7802ed14c2701d94d"
assert source["scriptRevision"] == "e05f5118821a75f6f0c010b7027cfc30012a85b7"
assert source["protocol"]["recoveryApi"] == {"baseline": "reachExplorationTarget", "fixed": "reachExplorationTarget"}
assert source["protocol"]["recoveryScriptVariant"] == "refactor"
assert source["protocol"]["trials"] == 160 and source["protocol"]["repeats"] == 5 and source["protocol"]["priceTicks"] == 100
assert len(source["commands"]) == 16 and all(c["exitCode"] == 0 for c in source["commands"])
assert collections.Counter((c["kind"], c["variant"]) for c in source["commands"]) == collections.Counter({
    (kind, variant): 5 if kind == "recovery" else 1
    for kind in ("conditions", "recovery", "continuation", "input-identity") for variant in ("baseline", "fixed")})
summary = {"productCommits": {"baseline": source["productsBefore"][0]["commit"],
                             "fixed": source["productsBefore"][1]["commit"]},
           "purpose": "Scoped repair acceptance; no claim of arbitrary-page restoration or exhaustive exploration.",
           "conditions": [], "recovery": [], "continuation": [], "inputs": []}
fixtures = collections.defaultdict(set)
scripts = {}
raw = {}


def rows_from(directory, filename, kind, field):
    document = read(directory, filename)
    script = "scripts/verify-exploration-" + kind + ".ts"
    expected = hashlib.sha256((ROOT / script).read_bytes()).hexdigest()
    original = subprocess.check_output(["git", "show", f"{source['scriptRevision']}:{script}"], cwd=ROOT)
    assert expected == hashlib.sha256(original).hexdigest(), "Measurement differs from original e05 script"
    assert expected == document["scriptSha256"] == source["scripts"][script], (filename, "different measurement")
    product = source["productsBefore"][0 if "-baseline" in filename else 1]
    revision = document.get("sourceRevision", document.get("declaredEngineRevision", document.get("revision")))
    assert revision == product["commit"], (filename, "wrong source revision")
    hashes = document.get("sourceHashes", document.get("engineSourceHashes", {}))
    if kind == "continuation":
        hashes = {"packages/explorer-plugin/src/runtime.ts": document["runtimeSha256"]}
    assert all(product["files"].get(path) == digest for path, digest in hashes.items()), (filename, "runtime source hash mismatch")
    if kind == "recovery":
        assert document["variant"] == "refactor", "Both sources must use the same target recovery API"
    if kind == "conditions":
        assert document["protocol"]["runs"] == 5 and document["protocol"]["ticks"] == 100
    scripts[script] = expected
    rows = document[field]
    for row in rows:
        fixtures[(kind, row["scenario"])].add(row["fixtureSha256"])
    if kind == "continuation":
        assert document["complete"]
    return rows


for label, directory, variant in (("baseline", OUT, "baseline"), ("fixed", OUT, "fixed")):
    conditions = rows_from(directory, f"conditions-{variant}.json", "conditions", "results")
    recovery = [row for repeat in range(1, 6) for row in rows_from(directory, f"recovery-{variant}-r{repeat}.json", "recovery", "runs")]
    continuation = rows_from(directory, f"continuation-{variant}.json", "continuation", "runs")
    inputs = rows_from(directory, f"input-identity-{variant}.json", "input-identity", "results")
    raw[label] = {"conditions": groups(conditions), "recovery": groups(recovery), "continuation": groups(continuation), "inputs": groups(inputs)}
    assert [len(raw[label][k]) for k in ("conditions", "recovery", "continuation", "inputs")] == [5, 6, 3, 2]
    for scenario, rows in groups(conditions).items():
        assert len(rows) == 5
        assert {r["run"] for r in rows} == set(range(1, 6))
        for row in rows:
            assert sorted(set(e["branch"] for e in row["oracle"])) == sorted(row["observedBranches"])
            assert sorted(set(row["expectedBranches"]) - set(row["observedBranches"])) == sorted(row["missingBranches"])
            assert len(row["oracle"]) == row["metrics"]["oracleClicks"]
            assert len(row["attempts"]) == row["metrics"]["actualActions"]
            assert len(set(k["stateId"] for k in row["keyRows"])) == row["metrics"]["observedStateCount"]
            assert len(set(k["key"] for k in row["keyRows"])) == row["metrics"]["retryKeyCount"]
            if scenario.startswith("price"):
                phases = [p for p in row["phaseRecord"] if p["label"].startswith("price-tick-")]
                assert [p["label"] for p in phases] == [f"price-tick-{n}" for n in range(1, 101)]
                assert len(set(k for p in phases for k in p["operationKeys"])) == row["metrics"]["priceTickRetryKeyCount"]
        ticks = [r for row in rows for r in row["phaseRecord"] if r["label"].startswith("price-tick")]
        summary["conditions"].append({"variant": label, "scenario": scenario, "trials": 5,
            "errors": [r["errors"] for r in rows if r["errors"]],
            "fullyCoveredTrials": sum(not r["missingBranches"] for r in rows),
            "falseCoverageTrials": sum(r["metrics"]["falseCoverageChecks"] > 0 for r in rows),
            "metrics": {k: distribution([r["metrics"][k] for r in rows]) for k in (
                "actualActions", "successfulActions", "oracleClicks", "newDistinctBranches", "duplicateOracleClicks", "recoveryActions", "retryKeyCount",
                "observedStateCount", "initialPlanRows", "finalPlanRows", "finalPendingRows", "modelRequests", "wallTimeMs")},
            "priceTickPlanRows": sorted(set(r["planRows"] for r in ticks)),
            "priceTickPendingRows": sorted(set(r["pendingPlanRows"] for r in ticks)),
            "planGrowth": [{"run": row["run"], "beforeDiscovery": row["metrics"]["initialPlanRows"],
                "afterInitialDiscovery": next((p["planRows"] for p in row["phaseRecord"] if p["label"] == "after-initial"), None),
                "final": row["metrics"]["finalPlanRows"], "finalPending": row["metrics"]["finalPendingRows"],
                "duringPriceTicks": (row["phaseRecord"][-1]["planRows"] - next(p["planRows"] for p in row["phaseRecord"] if p["label"] == "after-initial")) if scenario.startswith("price") else None}
                for row in rows]})
    for scenario, rows in groups(recovery).items():
        assert len(rows) == 5
        assert {r["replicate"] for r in rows} == set(range(1, 6))
        measured = [r for r in rows if "setupError" not in r]
        for row in measured:
            assert row["falseArrivalClaim"] == (row["reportedArrival"] and not row["oracle"]["physicalArrival"])
        summary["recovery"].append({"variant": label, "scenario": scenario, "trials": 5, "measuredTrials": len(measured),
            "setupErrors": [r["setupError"] for r in rows if "setupError" in r],
            "physicalArrivals": sum(r["oracle"]["physicalArrival"] for r in measured),
            "reportedArrivals": sum(r["reportedArrival"] for r in measured),
            "falseArrivalClaims": sum(r["falseArrivalClaim"] for r in measured),
            "actualSdkTargetEvents": sum(r["guardedBranchYield"] for r in measured),
            "physicalArrivalAndSdkEvent": sum(r["oracle"]["physicalArrival"] and r["guardedBranchYield"] for r in measured),
            "guardedTargetFailures": sum(r.get("targetExecution", {}).get("status") == "failed" for r in measured),
            "unknownDispatchBlocked": sum(r["unknown"]["guardedDispatchBlocked"] for r in measured),
            "recoveryErrors": [r["recoveryError"] for r in measured if r.get("recoveryError")],
            "statuses": dict(collections.Counter(r.get("result", {}).get("status", "THREW") for r in measured)),
            "recoveryActions": sum(len(r["recoveryAttempts"]) for r in measured),
            "entryReloads": sum(r["entryReopenAttempts"] for r in measured),
            "timeMs": distribution([r["durationMs"] for r in measured])})
    for scenario, rows in groups(continuation).items():
        assert len(rows) == 5
        assert {r["iteration"] for r in rows} == set(range(1, 6))
        for row in rows:
            required = row["oracle"]["mustExecute"]
            assert sorted(set(e["label"] for e in row["oracleEvents"] if e["label"] in required)) == row["oracle"]["covered"]
            assert sum(e["label"] in required for e in row["oracleEvents"]) == sum(row["oracle"]["leafCounts"].values())
        summary["continuation"].append({"variant": label, "scenario": scenario, "trials": 5,
            "validTrials": sum(r["valid"] for r in rows), "errors": [r["errors"] for r in rows if r["errors"]],
            "fullyCoveredTrials": sum(not r["oracle"]["missing"] for r in rows),
            "lostPending": sum(len(r["oracle"]["lostPending"]) for r in rows),
            "incorrectlySettled": sum(len(r["oracle"]["incorrectlySettled"]) for r in rows),
            "newBranchesAfterRestart": sum(len(r["oracle"]["newAfterRestart"]) for r in rows),
            "metrics": {k: distribution([r["metrics"][k] for r in rows]) for k in rows[0]["metrics"]},
            "finalStatuses": dict(collections.Counter(r["phases"][-1]["status"] for r in rows)),
            "hostClosesBeforeRestart": [r["restart"]["hostClosesBeforeFinish"] for r in rows]})
    for scenario, rows in groups(inputs).items():
        assert len(rows) == 5
        assert {r["run"] for r in rows} == set(range(1, 6))
        for row in rows:
            assert all(c["sourceValue"] == c["targetValue"] == "sample" for c in row["checks"])
        summary["inputs"].append({"variant": label, "scenario": scenario, "trials": 5,
            "errors": [r["errors"] for r in rows if r["errors"]],
            "actualInputEvents": sum(len(r["events"]) for r in rows),
            "mismatchedChecks": [{"run": r["run"], "phase": c["phase"], "reason": c["reason"]} for r in rows for c in r["checks"] if c["actual"] != c["expected"]],
            "falseEquivalentClaims": sum(c["actual"] and not c["expected"] for r in rows for c in r["checks"])})

assert all(len(hashes) == 1 for hashes in fixtures.values()), "Fixture changed between versions/runs"
summary["scriptHashes"] = scripts
summary["fixtureHashes"] = {f"{k[0]}/{k[1]}": next(iter(v)) for k, v in fixtures.items()}
summary["formalTrials"] = sum(g["trials"] for kind in raw["fixed"] for g in summary[kind])
assert summary["formalTrials"] == 160
summary["recoveryApi"] = source["protocol"]["recoveryApi"]
summary["datasetIntegrityChecksPassed"] = True
fixed = {kind: {g["scenario"]: g for g in summary[kind] if g["variant"] == "fixed"} for kind in raw["fixed"]}
criteria = {}
for scenario in ("nested_static", "nested_changed_quote"):
    group = fixed["recovery"][scenario]
    criteria[scenario] = group["physicalArrivalAndSdkEvent"] == 5 and group["reportedArrivals"] == 5 and group["falseArrivalClaims"] == 0
group = fixed["conditions"]["public-form-cycle"]
criteria["ab_coverage_without_duplicates"] = group["fullyCoveredTrials"] == 5 and group["metrics"]["duplicateOracleClicks"]["sum"] == 0 and group["falseCoverageTrials"] == 0
unknown = raw["fixed"]["continuation"]["unknown_recovery_restart"]
criteria["unknown_preserved_and_blocks_after_cold_restart"] = all(
    r["valid"] and r["metrics"]["unknownRetained"] and r["metrics"]["unresolvedUnknown"] > 0
    and not r["metrics"]["incorrectCompletion"] and not r["metrics"]["successfulExplorationAfterInjectedUnknown"]
    and r["phases"][-1]["status"] == "blocked" and r["restart"]["hostClosesBeforeFinish"] == 1
    and "Branch B" in r["oracle"]["missing"] and not r["oracle"]["lostPending"] and not r["oracle"]["incorrectlySettled"]
    for r in unknown)
criteria["no_false_arrival"] = all(g["falseArrivalClaims"] == 0 for g in fixed["recovery"].values())
criteria["all_trials_measured"] = all(g["measuredTrials"] == 5 and not g["recoveryErrors"] for g in summary["recovery"]) and all(
    not g["errors"] for kind in ("conditions", "continuation", "inputs") for g in summary[kind])
criteria["cold_restart_coverage_preserved"] = fixed["continuation"]["cold_nested_restart"]["fullyCoveredTrials"] == 5
criteria["failed_recovery_pending_work_preserved"] = fixed["continuation"]["failed_recovery_restart"]["fullyCoveredTrials"] == 5 and all(
    not g["lostPending"] and not g["incorrectlySettled"] and g["validTrials"] == 5 for g in fixed["continuation"].values())
criteria["input_correspondences_preserved"] = all(not g["mismatchedChecks"] and g["actualInputEvents"] == 15 for g in fixed["inputs"].values())
criteria["modal_and_ready_target_controls_preserved"] = all(fixed["recovery"][s]["physicalArrivalAndSdkEvent"] == 5 for s in ("modal_reentry_changed_quote", "ready_target_ticking_quote"))
criteria["failed_inverse_does_not_claim_arrival"] = fixed["recovery"]["local_inverse_diverges"]["reportedArrivals"] == 0
criteria["unknown_dispatch_stays_blocked"] = fixed["recovery"]["unknown_outcome_injected"]["unknownDispatchBlocked"] == 5
criteria["no_unnecessary_reentries_or_duplicate_leaves"] = all(
    row["metrics"]["unnecessaryReentries"] == 0 and row["metrics"]["repeatedNoProgressRecoveries"] == 0
    and row["metrics"]["duplicateLeafExecutions"] == 0
    for rows in raw["fixed"]["continuation"].values() for row in rows)
group = fixed["conditions"]["nonlocal-dependency"]
criteria["nonlocal_ab_actual_events_without_false_coverage"] = group["fullyCoveredTrials"] == 5 and group["falseCoverageTrials"] == 0 and group["metrics"]["duplicateOracleClicks"]["sum"] == 0 and all(
    collections.Counter(e["branch"] for e in row["oracle"]) == {"nonlocal:A": 1, "nonlocal:B": 1}
    for row in raw["fixed"]["conditions"]["nonlocal-dependency"])
for scenario in ("price-known", "price-unknown"):
    rows = raw["fixed"]["conditions"][scenario]
    criteria[f"{scenario}_100_ticks_one_state_one_key_one_click"] = all(
        not row["errors"] and row["metrics"]["observedStateCount"] == 1 and row["metrics"]["retryKeyCount"] == 1
        and row["metrics"]["priceTickRetryKeyCount"] == 1 and row["metrics"]["actualActions"] == 1
        and row["metrics"]["successfulActions"] == 1 and row["metrics"]["recoveryActions"] == 0
        and row["metrics"]["oracleClicks"] == 1 and row["metrics"]["falseCoverageChecks"] == 0
        and row["metrics"]["modelRequests"] == 0 and [e["branch"] for e in row["oracle"]] == ["price:run"]
        for row in rows)
    criteria[f"{scenario}_no_plan_growth_during_ticks"] = all(
        all(p["planRows"] == initial["planRows"] and p["pendingPlanRows"] == initial["pendingPlanRows"]
            for p in row["phaseRecord"] if p["label"].startswith("price-tick-"))
        for row in rows for initial in row["phaseRecord"] if initial["label"] == "after-initial")
criteria["input_oracle_preserved"] = all([e["branch"] for e in row["events"]] == ["A", "B", "C"] and all(e["value"] == "sample" for e in row["events"])
    for rows in raw["fixed"]["inputs"].values() for row in rows)
summary["requestedFixCriteria"] = criteria
summary["requestedFixExperimentAccepted"] = all(criteria.values())
summary["failedScopedCriteria"] = [name for name, accepted in criteria.items() if not accepted]
summary["remainingArchitectureLimitations"] = [
    "Unobserved JavaScript/network/free-text causal dependencies remain outside the selector model.",
    "Immutable observations, identity occurrences and sampling references still grow; only the graph index is bounded in the measured readout scenarios.",
    "Legacy SDK representative frontier keys are preserved as explicit sampling_policy_changed gaps, not automatically migrated.",
    "Shared-ID ambiguity, arbitrary-page restoration, long-run performance and real-site exhaustion are not solved by these fixtures.",
]
summary["overallExplorationAccepted"] = False
summary["overallAcceptanceReason"] = "Observed selector dependencies and finite state groups are scoped evidence. Unobserved JavaScript dependencies, arbitrary data combinations, observation retention and real-site exhaustion remain outside these measurements."
regression_path = OUT / "regression-full.json"
if regression_path.exists():
    tests = json.loads(regression_path.read_text())
    summary["regression"] = {k: tests[k] for k in ("numTotalTestSuites", "numPassedTestSuites", "numTotalTests", "numPassedTests", "numFailedTests", "success")}
    summary["regression"]["testFiles"] = len(tests["testResults"])
engineering_path = OUT / "engineering-checks.json"
if engineering_path.exists():
    summary["engineeringChecks"] = {c["name"]: c["exitCode"] for c in json.loads(engineering_path.read_text())}
(OUT / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({k: summary[k] for k in ("formalTrials", "datasetIntegrityChecksPassed", "requestedFixCriteria", "requestedFixExperimentAccepted", "failedScopedCriteria", "remainingArchitectureLimitations")}, ensure_ascii=False, indent=2))
