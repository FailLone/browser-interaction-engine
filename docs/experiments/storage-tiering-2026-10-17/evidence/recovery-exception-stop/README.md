# Recovery exception stop checkpoint

Base: `7c1bf9c`; source hashes and exact selected test command are in `validation.json`.

The acceptance runner previously stopped on returned unverified/unreachable recovery results but only logged thrown errors. The SDK can throw `STALE_OBSERVATION` before target/source recovery; the plugin treats that code as a retryable invalidated step. The measurement run could therefore continue after its first recovery exception.

All three recovery wrappers now use one helper. It records the elapsed time and `outcome: "threw"`, requests stop before returning control to the plugin, and rethrows the identical error object. No SDK result status or attempt IDs are invented for a thrown call. Returned-result records and follow-up analysis remain compatible; separate `recoveryFailures` and returned/thrown counters make total calls and total elapsed time include exceptions.

Validation: 10 new helper cases and 3 existing returned-result guard cases passed. The other 43 tests in the existing file were intentionally skipped. Tests cover all three API success/result-denial/exception paths, synchronous throws and rejected promises, stop-before-caller ordering, original exception identity, and diagnostic-report failure. No browser, service, provider, or database was opened by these selected tests. Type checking is owned by the parent integration checkpoint.

The arrival-candidate assessment, progress ledger/window, and live unknown guard are byte-identical to the base sections. The conservative 600-second review window remains unchanged. Document-bound receipt coverage will be assessed separately against a frozen private copy after the real run; it is not injected into arrival candidates or cross-session novelty.

This proves the measurement stop/accounting behavior only. It does not establish real-site recovery success, performance improvement, or exhaustion.

主线程复核三个 wrapper 接线与错误保留，根类型检查和 diff 检查通过，见 `final-check.json`。packages/apps/lockfile 相对固定发布检查点 `7c1bf9c` 无变化，因此不重跑发布构建；类型检查只覆盖本次验收脚本与测试增量，不重标旧发布证据。
