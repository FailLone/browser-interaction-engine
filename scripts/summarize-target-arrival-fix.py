"""Recompute target-arrival follow-up evidence without browsers or task stores.

Keeps the previous failed experiment immutable. A valid dataset is not evidence
that the entire exploration architecture meets acceptance.
"""
import collections
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs/experiments/target-arrival-fix-2026-10-16"
OLD = ROOT / "docs/experiments/layered-direction-2026-10-16"


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
assert source["productsBefore"] == source["productsAfter"], "Frozen product changed during comparison"
assert len(source["commands"]) == 16 and all(c["exitCode"] == 0 for c in source["commands"])
summary = {"productCommits": {"baseline": source["productsBefore"][0]["commit"],
                             "previous": "de364fab170a9b92227bc4f982ca78fa6a0a4633",
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
    assert expected == document["scriptSha256"] == source["scripts"][script], (filename, "different measurement")
    scripts[script] = expected
    rows = document[field]
    for row in rows:
        fixtures[(kind, row["scenario"])].add(row["fixtureSha256"])
    if kind == "continuation":
        assert document["complete"]
    return rows


for label, directory, variant in (("baseline", OUT, "baseline"), ("previous", OLD, "refactor"), ("fixed", OUT, "refactor")):
    conditions = rows_from(directory, f"conditions-{'base' if variant == 'baseline' else variant}.json", "conditions", "results")
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
            assert len(row["oracle"]) == row["metrics"]["oracleClicks"]
        ticks = [r for row in rows for r in row["phaseRecord"] if r["label"].startswith("price-tick")]
        summary["conditions"].append({"variant": label, "scenario": scenario, "trials": 5,
            "errors": [r["errors"] for r in rows if r["errors"]],
            "fullyCoveredTrials": sum(not r["missingBranches"] for r in rows),
            "falseCoverageTrials": sum(r["metrics"]["falseCoverageChecks"] > 0 for r in rows),
            "metrics": {k: distribution([r["metrics"][k] for r in rows]) for k in (
                "oracleClicks", "newDistinctBranches", "duplicateOracleClicks", "recoveryActions", "retryKeyCount",
                "observedStateCount", "initialPlanRows", "finalPlanRows", "finalPendingRows", "modelRequests", "wallTimeMs")},
            "priceTickPlanRows": sorted(set(r["planRows"] for r in ticks)),
            "priceTickPendingRows": sorted(set(r["pendingPlanRows"] for r in ticks))})
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
            "statuses": dict(collections.Counter(r["result"]["status"] for r in measured)),
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
summary["formalTrials"] = sum(g["trials"] for kind in raw["fixed"] for g in summary[kind] if g["variant"] != "previous")
summary["historicalTrialsForComparison"] = 80
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
criteria["all_new_trials_measured"] = all(g["measuredTrials"] == 5 for g in summary["recovery"] if g["variant"] != "previous") and all(
    not g["errors"] for kind in ("conditions", "continuation", "inputs") for g in summary[kind] if g["variant"] != "previous")
criteria["cold_restart_coverage_preserved"] = fixed["continuation"]["cold_nested_restart"]["fullyCoveredTrials"] == 5
criteria["failed_recovery_pending_work_preserved"] = fixed["continuation"]["failed_recovery_restart"]["fullyCoveredTrials"] == 5 and all(
    not g["lostPending"] and not g["incorrectlySettled"] and g["validTrials"] == 5 for g in fixed["continuation"].values())
criteria["input_correspondences_preserved"] = all(not g["mismatchedChecks"] and g["actualInputEvents"] == 15 for g in fixed["inputs"].values())
criteria["modal_and_ready_target_controls_preserved"] = all(fixed["recovery"][s]["physicalArrivalAndSdkEvent"] == 5 for s in ("modal_reentry_changed_quote", "ready_target_ticking_quote"))
criteria["failed_inverse_does_not_claim_arrival"] = fixed["recovery"]["local_inverse_diverges"]["reportedArrivals"] == 0
criteria["unknown_dispatch_stays_blocked"] = fixed["recovery"]["unknown_outcome_injected"]["unknownDispatchBlocked"] == 5
summary["requestedFixCriteria"] = criteria
summary["requestedFixExperimentAccepted"] = all(criteria.values())
summary["remainingArchitectureBlockers"] = []
if any(g["falseCoverageTrials"] for g in fixed["conditions"].values()):
    summary["remainingArchitectureBlockers"].append("Undeclared nonlocal dependencies still admit false coverage in the negative control.")
if any(g["metrics"]["observedStateCount"]["max"] > 100 for g in fixed["conditions"].values()):
    summary["remainingArchitectureBlockers"].append("100 price changes still create 101 canonical states; storage convergence is unproved.")
summary["overallExplorationAccepted"] = False
summary["overallAcceptanceReason"] = "Known negative controls remain; isolated fixtures do not establish arbitrary dynamic-site exploration or exhaustion."
regression_path = OUT / "regression-full.json"
if regression_path.exists():
    tests = json.loads(regression_path.read_text())
    summary["regression"] = {k: tests[k] for k in ("numTotalTestSuites", "numPassedTestSuites", "numTotalTests", "numPassedTests", "numFailedTests", "success")}
    summary["regression"]["testFiles"] = len(tests["testResults"])
engineering_path = OUT / "engineering-checks.json"
if engineering_path.exists():
    summary["engineeringChecks"] = {c["name"]: c["exitCode"] for c in json.loads(engineering_path.read_text())}
(OUT / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({k: summary[k] for k in ("formalTrials", "datasetIntegrityChecksPassed", "requestedFixCriteria", "requestedFixExperimentAccepted", "remainingArchitectureBlockers")}, ensure_ascii=False, indent=2))
