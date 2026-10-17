# Explicit dependency completeness evidence: reader checkpoint

One focused run of `tests/owner-dependency-absence.test.ts` passed all 28 cases. It used synthetic retained graphs and a synthetic dispatch witness, without a browser, service, persistent database or real-page replay. `source-before.json` and `validation.json` record identical source hashes before and after this run, including the separately developed codec/types/export dependencies. `tests.log` is the captured output with its trailing blank line omitted. This is not a performance measurement or real OKX admission result.

## Narrow contract

- An old `status: 'missing'` reference still fails. A new reference may carry `lookup: { scope: 'document-light-dom', documentId, matches }`; only an explicit zero count in the same document, zero targets, and no contradictory captured ID can establish absence. Ambiguous references always fail. Native association targets cannot use the zero-result exception.
- The lookup is a trusted producer assertion that its scoped query completed. A bounded retained node subset cannot independently prove that an uncaptured matching element does not exist. The reader validates the assertion's scope, document and cardinality against the raw edge and captured nodes; the source dispatch graph hash binds it to the actual retained attempt. It does not authenticate arbitrarily forged producer data.
- Lookup fields remain in the reference projection, so appearance, deletion, ambiguity or declaration changes cannot silently retain the old condition key. Missing dispatch evidence is not reconstructed.
- Only `ancestry: 'node-bounded-v1'` permits an ancestor chain longer than the old depth bound. The chain must remain within the same 512-node cap, include every parent, avoid cycles and terminate at `html`. The separate subtree/IDREF recursion depth remains 16. The new ancestry declaration is included in the condition projection; old records are not upgraded.
- Compact v3 snapshots are decoded once per observation object in a synchronous reader. The codec validates the wire and expanded representation limits; the reader then validates the same raw graph. Legacy v1/v2 retain their original raw byte bound and unmodified keys when new declarations are absent. Encoding is not evidence completeness.

The scope is deliberately the document light-DOM tree. DOM defines selector queries against the specified tree and returns a static result; that does not authorize a claim about another shadow tree. The producer must refuse unsupported scope or unsuccessful lookup. [DOM Standard: selector matching](https://dom.spec.whatwg.org/#scope-match-a-selectors-string), [querySelectorAll](https://dom.spec.whatwg.org/#dom-parentnode-queryselectorall).

## Discriminating checks

The 28 cases cover declared zero versus legacy missing; wrong document/scope/count, target contradiction and captured-ID contradiction; absent→present, present→absent and duplicate targets; source witness binding and declaration-key changes; 40 and 508 ancestor nodes accepted only with the explicit contract; 513 nodes, cycles, missing parents, closure omissions, non-HTML roots and unknown profiles rejected; deep subtree and IDREF traversal still rejected. Compact/raw normalization preserves a valid proof and key, malformed compact envelopes fail, and a graph exceeding the legacy raw byte limit is accepted only when its compact and expanded limits are independently valid.

These checks do not establish that the real OKX required closures now fit, that every live lookup is complete, or that recovery produces new coverage. That requires fresh capture and the existing real-run admission criteria. No historical incomplete graph is backfilled or marked successful here.
