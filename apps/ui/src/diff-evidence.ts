import type { BrowserDiffDetails } from '@interaction/browser';

type GapEntry = BrowserDiffDetails['gaps'][number];
export interface EvidenceGap extends GapEntry { supplemental?: boolean }

/** Follow explicit evidence references, without inferring a new identity or change. */
function attachReferences(entry: EvidenceGap, details: BrowserDiffDetails): EvidenceGap {
  const controlIds = new Set(entry.controlIds);
  const hypothesisIds = new Set(entry.hypothesisIds);
  for (const id of entry.controlIds) {
    const control = details.controls[id];
    control?.hypothesisIds.forEach(id => hypothesisIds.add(id));
    control?.alternatives.forEach(a => {
      controlIds.add(a.identityId);
      details.controls[a.identityId]?.hypothesisIds.forEach(id => hypothesisIds.add(id));
    });
  }
  for (const id of hypothesisIds) {
    const h = details.hypotheses.find(h => h.id === id);
    if (h) { controlIds.add(h.provisionalIdentityId); h.candidateIds.forEach(id => controlIds.add(id)); }
  }
  return { ...entry, controlIds: [...controlIds], hypothesisIds: [...hypothesisIds] };
}

/** Older diffs may omit an identity gap. Keep its evidence accessible in the gap
 * section, labelled as a UI supplement; the API response and raw diff stay intact. */
export function evidenceGaps(details: BrowserDiffDetails): EvidenceGap[] {
  const entries = details.gaps.map(entry => attachReferences(entry, details));
  const covered = new Set(entries.flatMap(entry => entry.controlIds));
  for (const control of Object.values(details.controls)) {
    if (control.correspondence !== 'uncertain' || covered.has(control.identityId)) continue;
    const entry = attachReferences({
      origin: 'enrichment', supplemental: true,
      gap: { code: 'IDENTITY_UNCERTAIN', reference: control.identityId, message: '详情中的历史身份对应尚未确定，原始 diff 未单列此缺口。' },
      controlIds: [control.identityId], hypothesisIds: control.hypothesisIds,
    }, details);
    entries.push(entry); entry.controlIds.forEach(id => covered.add(id));
  }
  return entries;
}
