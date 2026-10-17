# Event endpoint avoids complete task assembly

The event-only endpoint previously called `store.task(id)` only to reject a missing task. It now calls `taskHeader(id)`, which validates the task header without assembling plan occurrences, historical rounds or archived blocks. Event paging and error validation order remain unchanged. Reading audit events no longer validates the unrelated complete task body; full task reads retain their integrity checks.

The existing five synchronization tests passed on this one-line change (`tests.log`). They exercise the actual HTTP route through Fastify injection, event pagination, legacy endpoints and client synchronization. No new mirror test or browser/service was introduced. This is a caller-level removal of unnecessary work, not a measured end-to-end speed or disk-space claim. The archived byte-transfer candidate and storage format are unchanged.
