# Browser facts for recovery selection

`BrowserEngine.recoverySourceMaterial(sessionId, { sourceObservationId, currentObservationId })`
returns `{ source, actions, transition }`. It shares the source read between
observation ownership validation, action lookup and the existing occurrence
transition projection. Different source and comparison IDs require two observation
reads; identical IDs require one. Both IDs are explicit and may refer to historical
observations; `currentObservationId` does not assert that the browser is currently
there.

The result is a fresh, mutable copy isolated from storage, including stores that
return borrowed values. Modifying it cannot affect a later call. The SDK keeps no
cache between calls and does not freeze or modify stored objects. Action order,
duplicates, unsupported candidates and unknown facts remain available to the
caller's existing checks. Optional observation-scoped storage queries retain their
full-list fallback.

This method supplies facts only. It does not verify arrival, grant execution or
coverage, settle unknown outcomes, or replace dispatch validation. It performs
synchronous reads with the same consistency semantics as `observation`, `actions`
and `interactionTransition`; it does not create a cross-connection atomic snapshot
or start an implicit transaction. An existing `Persistence.transaction` can enclose
the read when an atomic record snapshot is needed.

The transition projection is eager, including for sources that a caller later
rejects. `Persistence.recordReadIsolation: 'detached'` explicitly guarantees that
entity reads return independent mutable copies. Memory/SQLite stores provide this
guarantee and retention forwards its backing store's current declaration. When
this guarantee is present and all three public SDK read methods are unmodified,
the method returns those already-isolated values without copying them again.
Unknown/borrowed stores and custom SDK projections retain the defensive copy.
The capability says nothing about freshness, identity or permission; a store
decorator must withdraw it if its reads introduce mutable aliases.

The method makes no latency claim; the caller's bounded cache and workload
determine the net benefit.
Subclasses and instance decorators that override `observation`, `actions` or
`interactionTransition` keep their public projections. Those calls use the
corresponding original methods, even when doing so requires additional reads.
