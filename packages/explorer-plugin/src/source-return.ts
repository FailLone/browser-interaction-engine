import { nativeDocumentReturnReady, type Observation } from '@interaction/browser';
import type { PlanItem } from './types.js';
import { digest } from './policy.js';
import { currentHistoryAnchor } from './review-recovery.js';

/** Only an accepted page discovery obligation can use source-position arrival.
 * Regions, controls, operation samples and prerequisite paths remain stricter.
 */
export function pageSourceObligation(item:PlanItem) {
  return item.dispatchScope===true&&!item.prerequisites.length&&!!item.scope.url
    &&Object.entries(item.scope).every(([key,value])=>key==='url'||value===undefined);
}

/** Retry accounting for one native position, never permission or arrival proof.
 * Quotes, capture IDs and rebuilt DOM nodes cannot mint another retry.
 */
export function sourceReturnCondition(source:Observation,current:Observation):string|undefined {
  // Retry accounting may use the separately settled native document position.
  // This does not make its changing controls ready; SDK history dispatch still
  // checks the live document, exact entry, boundaries, dirty state and authority.
  const documentReady=nativeDocumentReturnReady(source,current);
  if((!source.stable||!current.stable)&&!documentReady||current.gaps.some(g=>g.critical)||current.boundaries?.length||!currentHistoryAnchor(source,current)||source.ruleVersion!==current.ruleVersion)return;
  const context=(o:Observation)=>Object.fromEntries(Object.entries(o.context).map(([key,value])=>[key,{status:value.status,value:value.value}]));
  if(digest(context(source))!==digest(context(current)))return;
  const from=current.navigation!.entries[current.navigation!.currentIndex],to=source.navigation!.entries[source.navigation!.currentIndex];
  const entry=(value:typeof from)=>({id:value.id,url:value.url,method:value.method});
  return digest({policy:'explorer-native-source-condition-v1',browserSessionId:current.navigation!.browserSessionId,from:entry(from),to:entry(to),
    context:context(current),ruleVersion:current.ruleVersion});
}
