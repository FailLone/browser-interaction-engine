import type { BrowserEngine, Inspection, InspectionResult } from '@interaction/browser';

/** Example policy: this popup must fit the viewport and must not enlarge page scroll.
 * The caller chooses this policy; it is not a universal rule for all popups. */
export async function inspectPopup(reader: Pick<BrowserEngine, 'captureDetails' | 'captureNodes'>, inspection: Inspection): Promise<InspectionResult> {
  const result = (status: InspectionResult['status'], message: string, nodeIds?: string[]): InspectionResult => ({ ruleId: 'popup-contained', ruleVersion: '1', status, message, nodeIds });
  if (inspection.focus.kind !== 'overlay') return result('unsupported', 'This rule applies only to popup scopes');
  if (inspection.quality.status !== 'complete' || inspection.focus.confidence !== 'observed') return result('inconclusive', 'Required capture or scope evidence is incomplete');
  const baseline = inspection.baselines.find(b => b.role === 'scopeEntry');
  if (!baseline?.captureId || baseline.comparison !== 'comparable') return result('inconclusive', 'No comparable capture from before entering the popup');
  const current = await reader.captureDetails(inspection.sessionId, inspection.captureId);
  const before = await reader.captureDetails(inspection.sessionId, baseline.captureId);
  if (!current.compatibility.protocolSupported || !before.compatibility.protocolSupported || current.compatibility.unknownComponents.some(kind => inspection.requirements.required.includes(kind))) return result('inconclusive', 'Required evidence schema is unsupported');
  const environment = current.details?.snapshot?.dom?.environment; const prior = before.details?.snapshot?.dom?.environment;
  if (!environment?.scrollingElement || !prior?.scrollingElement) return result('inconclusive', 'Page scroll measurements are unavailable');
  const roots = inspection.focus.rootIds; const nodes = [];
  for (const rootId of roots) {
    let offset = 0;
    while (true) {
      const page = await reader.captureNodes(inspection.sessionId, inspection.captureId, { rootId, offset, limit: 500, depth: 100 });
      if (page.captureTruncated || page.depthLimited) return result('inconclusive', 'Popup subtree was truncated');
      nodes.push(...page.nodes); if (page.nextOffset === null) break; offset = page.nextOffset;
    }
  }
  const root = nodes.find(n => roots.includes(n.id)); if (!root?.rect || !root.layout) return result('inconclusive', 'Popup geometry is unavailable');
  // Normalize page scroll displacement before comparing viewport containment.
  const topAtEntry = root.rect.y + environment.scroll.y - prior.scroll.y;
  const leftAtEntry = root.rect.x + environment.scroll.x - prior.scroll.x;
  const outside = topAtEntry < -1 || leftAtEntry < -1 || topAtEntry + root.rect.height > environment.layoutViewport.height + 1 || leftAtEntry + root.rect.width > environment.layoutViewport.width + 1;
  const pageGrew = environment.scrollingElement.scrollHeight > prior.scrollingElement.scrollHeight + 1 || environment.scrollingElement.scrollWidth > prior.scrollingElement.scrollWidth + 1;
  const internalScroll = nodes.some(n => n.layout && /(auto|scroll)/.test(n.styles?.['overflow-y'] || '') && n.layout.scroll.height > n.layout.client.height + 1);
  if (outside && pageGrew) return result('fail', `Popup exceeds the viewport and page scroll extent increased. Internal scrolling: ${internalScroll}. This is correlated evidence; unrelated background changes may contribute.`, [root.id]);
  if (outside) return result('fail', `Popup exceeds the viewport. Internal scrolling: ${internalScroll}; page scroll may already have existed.`, [root.id]);
  if (pageGrew) return result('inconclusive', 'Page scroll extent increased while the popup fits; background changes or other layout effects need investigation', [root.id]);
  return result('pass', `Popup fits the viewport and page scroll extent did not increase. Internal scrolling: ${internalScroll}.`, [root.id]);
}
