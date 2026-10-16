"""Recompute the frozen direction experiment's metrics, including negative results.

No browser, service, or task database access. Run from the repository root.
"""
import collections
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs/experiments/layered-direction-2026-10-16"


def read(name):
    return json.loads((OUT / name).read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def distribution(values):
    values = sorted(values)
    return {"min": min(values), "max": max(values), "sum": sum(values),
            "median": values[(len(values) - 1) // 2],
            "p95": values[max(0, math.ceil(len(values) * .95) - 1)]}


def groups(rows):
    result = collections.defaultdict(list)
    for row in rows:
        result[row["scenario"]].append(row)
    return result


def check_pair(documents, script, row_field):
    expected = digest(ROOT / "scripts" / script)
    for document in documents:
        assert document["scriptSha256"] == expected, (script, "script changed")
    fixtures = collections.defaultdict(set)
    for document in documents:
        for row in document[row_field]:
            assert row.get("fixtureSha256"), (script, "missing fixture hash")
            fixtures[row["scenario"]].add(row["fixtureSha256"])
    assert all(len(hashes) == 1 for hashes in fixtures.values()), (script, "unequal fixtures")
    return expected


summary = {"purpose": "Independent recomputation; a valid dataset does not mean the product passed acceptance.",
           "productCommits": {"base": "4857ad571c19995480a4c149abd9b2868a94c965",
                              "refactor": "de364fab170a9b92227bc4f982ca78fa6a0a4633"},
           "scriptHashes": {}, "conditions": [], "recovery": [], "continuation": [], "inputs": []}
conditions = [read(f"conditions-{v}.json") for v in ("base", "refactor")]
summary["scriptHashes"]["conditions"] = check_pair(conditions, "verify-exploration-conditions.ts", "results")
for variant, document in zip(("base", "refactor"), conditions):
    for scenario, rows in groups(document["results"]).items():
        assert len(rows) == 5
        for row in rows:
            assert sorted(set(e["branch"] for e in row["oracle"])) == sorted(row["observedBranches"])
            assert len(row["oracle"]) == row["metrics"]["oracleClicks"]
        ticks = [r for row in rows for r in row["phaseRecord"] if r["label"].startswith("price-tick")]
        summary["conditions"].append({"variant": variant, "scenario": scenario, "trials": len(rows),
            "errors": [r["errors"] for r in rows if r["errors"]],
            "fullyCoveredTrials": sum(not r["missingBranches"] for r in rows),
            "falseCoverageTrials": sum(r["metrics"]["falseCoverageChecks"] > 0 for r in rows),
            "metrics": {key: distribution([r["metrics"][key] for r in rows]) for key in (
                "oracleClicks", "newDistinctBranches", "duplicateOracleClicks", "recoveryActions", "retryKeyCount",
                "observedStateCount", "initialPlanRows", "finalPlanRows", "finalPendingRows", "modelRequests", "wallTimeMs")},
            "priceTickPlanRows": sorted(set(r["planRows"] for r in ticks)),
            "priceTickPendingRows": sorted(set(r["pendingPlanRows"] for r in ticks))})

recovery_docs = [read(f"recovery-{v}-r{rep}.json") for v in ("baseline", "refactor") for rep in range(1, 6)]
summary["scriptHashes"]["recovery"] = check_pair(recovery_docs, "verify-exploration-recovery.ts", "runs")
for variant in ("baseline", "refactor"):
    rows = [row for d in recovery_docs for row in d["runs"] if row["variant"] == variant]
    for scenario, trials in groups(rows).items():
        assert len(trials) == 5
        valid = [r for r in trials if "setupError" not in r]
        for row in valid:
            assert row["falseArrivalClaim"] == (row["reportedArrival"] and not row["oracle"]["physicalArrival"])
        summary["recovery"].append({"variant": variant, "scenario": scenario, "trials": 5, "measuredTrials": len(valid),
            "setupErrors": [r["setupError"] for r in trials if "setupError" in r],
            "physicalArrivals": sum(r["oracle"]["physicalArrival"] for r in valid),
            "reportedArrivals": sum(r["reportedArrival"] for r in valid),
            "falseArrivalClaims": sum(r["falseArrivalClaim"] for r in valid),
            "actualSdkTargetEvents": sum(r["guardedBranchYield"] for r in valid),
            "guardedTargetFailures": sum(r.get("targetExecution", {}).get("status") == "failed" for r in valid),
            "unknownDispatchBlocked": sum(r["unknown"]["guardedDispatchBlocked"] for r in valid),
            "recoveryActions": sum(len(r["recoveryAttempts"]) for r in valid),
            "entryReloads": sum(r["entryReopenAttempts"] for r in valid),
            "timeMs": distribution([r["durationMs"] for r in valid])})

continuation = [read(f"continuation-{v}.json") for v in ("baseline", "refactor")]
summary["scriptHashes"]["continuation"] = check_pair(continuation, "verify-exploration-continuation.ts", "runs")
for variant, document in zip(("baseline", "refactor"), continuation):
    assert document["complete"]
    for scenario, rows in groups(document["runs"]).items():
        assert len(rows) == 5
        for row in rows:
            required = row["oracle"]["mustExecute"]
            assert sorted(set(e["label"] for e in row["oracleEvents"] if e["label"] in required)) == row["oracle"]["covered"]
            assert sum(e["label"] in required for e in row["oracleEvents"]) == sum(row["oracle"]["leafCounts"].values())
        summary["continuation"].append({"variant": variant, "scenario": scenario, "trials": 5,
            "validTrials": sum(r["valid"] for r in rows), "errors": [r["errors"] for r in rows if r["errors"]],
            "fullyCoveredTrials": sum(not r["oracle"]["missing"] for r in rows),
            "lostPending": sum(len(r["oracle"]["lostPending"]) for r in rows),
            "incorrectlySettled": sum(len(r["oracle"]["incorrectlySettled"]) for r in rows),
            "newBranchesAfterRestart": sum(len(r["oracle"]["newAfterRestart"]) for r in rows),
            "metrics": {k: distribution([r["metrics"][k] for r in rows]) for k in rows[0]["metrics"]},
            "finalStatuses": dict(collections.Counter(r["phases"][-1]["status"] for r in rows)),
            "hostClosesBeforeRestart": [r["restart"]["hostClosesBeforeFinish"] for r in rows]})

inputs = [read(f"input-identity-{v}.json") for v in ("baseline", "refactor")]
summary["scriptHashes"]["inputs"] = check_pair(inputs, "verify-exploration-input-identity.ts", "results")
for variant, document in zip(("baseline", "refactor"), inputs):
    for scenario, rows in groups(document["results"]).items():
        assert len(rows) == 5
        for row in rows:
            for check in row["checks"]:
                assert check["sourceValue"] == check["targetValue"] == "sample"
        summary["inputs"].append({"variant": variant, "scenario": scenario, "trials": 5,
            "errors": [r["errors"] for r in rows if r["errors"]],
            "actualInputEvents": sum(len(r["events"]) for r in rows),
            "mismatchedChecks": [{"run": r["run"], "phase": c["phase"], "reason": c["reason"]} for r in rows for c in r["checks"] if c["actual"] != c["expected"]],
            "falseEquivalentClaims": sum(c["actual"] and not c["expected"] for r in rows for c in r["checks"])})

tests = read("regression-full.json")
summary["regression"] = {key: tests[key] for key in ("numTotalTestSuites", "numPassedTestSuites", "numTotalTests", "numPassedTests", "numFailedTests", "success")}
summary["formalTrials"] = sum(g["trials"] for group in ("conditions", "recovery", "continuation", "inputs") for g in summary[group])
summary["datasetIntegrityChecksPassed"] = True
summary["acceptanceBlockers"] = []
if any(g["variant"] == "refactor" and g["falseArrivalClaims"] for g in summary["recovery"]):
    summary["acceptanceBlockers"].append("Target arrival falsely claims closed native-details inputs ready; static recovery regressed.")
if any(g["variant"] == "refactor" and g["falseCoverageTrials"] for g in summary["conditions"]):
    summary["acceptanceBlockers"].append("Undeclared nonlocal dependencies still reuse coverage across distinct actual branches.")
if any(g["errors"] for g in summary["inputs"]):
    summary["acceptanceBlockers"].append("Some supplemental input experiments did not complete; inspect their errors.")
summary["acceptancePassed"] = not summary["acceptanceBlockers"]
(OUT / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({key: summary[key] for key in ("formalTrials", "regression", "datasetIntegrityChecksPassed", "acceptancePassed", "acceptanceBlockers")}, ensure_ascii=False, indent=2))
