import type { DomNodeEvidence } from '@interaction/adapter-playwright';

// Relationship targets may legitimately not exist while a conditional popup is
// closed. These gaps do not invalidate captured rectangles, styles or text boxes.
// Unknown gaps and truncated fields remain conservative evidence failures.
const relation = /^(aria-labelledby|aria-describedby|aria-controls|aria-owns|aria-details|aria-errormessage|for|list|popovertarget) references missing #/;
export function hasRelevantGaps(node: DomNodeEvidence, requiredRelations: string[] = []): boolean {
  return node.gaps.some(gap => {
    const attribute = gap.code === 'UNRESOLVED_DOM_RELATION' ? relation.exec(gap.message)?.[1] : undefined;
    return !attribute || requiredRelations.includes(attribute);
  });
}
