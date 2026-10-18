# Crawljax-derived fragment traversal

Selected fragment traversal algorithms are translated from Crawljax commit `a9e14583e85569f6a7775fa6391c13cf53b3fd6d`, under the accompanying Apache-2.0 license.

Source methods: CandidateElement access/explored state; Fragment relative candidate mapping and access transfer; FragmentManager candidate influence, duplication factor and state selection; UnfiredFragmentCandidates local candidate selection. Each translated module identifies its source and host adaptations. No VIPS, OpenCV, APTED or Java library implementation is included. Host DOM segmentation is not upstream visual segmentation.

Evidence and original Java/TypeScript differential experiment: `/Users/xietian/Experiments/fraggen-port-evidence-20261018`. This package confirms source behavior, including false propagation between different hrefs, distance-cache collisions and stale unexplored state. The product must retain semantic guards, real SDK receipts and durable event provenance rather than reproducing those defects. Pruning is exploration metadata, never an actual execution or verified coverage receipt.
