import { id } from './util.js';
import type { ActionCandidate, BrowserHistory, Observation, Session } from './types.js';

export interface NavigationIntent {
  kind:'native-http-link'; sourceUrl:string; targetUrl:string; observationId:string;
  evidence: string[]; destinationVerified:false;
}
/** Native browser semantics; a destination is an intent, never a successful navigation. */
export function navigationIntent(action:ActionCandidate,o:Observation):NavigationIntent|undefined {
  if(action.observationId!==o.id||action.sessionId!==o.sessionId||action.kind!=='click'||action.risk!=='interface'||action.basis?.status!=='supported')return;
  const href=action.basis.evidence.find(e=>e.source==='html'&&e.rule==='hyperlink/v1')?.facts.href;
  const control=o.controls.find(c=>c.localId===action.localId);
  if(typeof href!=='string'||control?.tag!=='a'||control.reviewBinding?.attributes.download!==undefined)return;
  try{const target=new URL(href,o.url),source=new URL(o.url);if(!['http:','https:'].includes(target.protocol)||target.origin+target.pathname+target.search===source.origin+source.pathname+source.search)return;
    return {kind:'native-http-link',sourceUrl:o.url,targetUrl:target.href,observationId:o.id,evidence:['html:hyperlink/v1',`control:${control.localId}`],destinationVerified:false};
  }catch{return;}
}

export const historyPosition = (history: BrowserHistory) => ({ browserSessionId: history.browserSessionId,
  entryId: history.entries[history.currentIndex]?.id, url: history.entries[history.currentIndex]?.url });

/** Validate against native history evidence, never a URL guessed from a label. */
export function historyTarget(action: ActionCandidate, history?: BrowserHistory) {
  if (!history || action.kind !== 'history' || action.controlId || action.localId || action.source !== 'browser-history-return'
    || action.risk !== 'interface' || action.basis?.status !== 'supported') return;
  const current = history.entries[history.currentIndex];
  const targetIndex = history.entries.findIndex(e => e.id === action.value);
  const target = history.entries[targetIndex];
  if (!current || !target || targetIndex === history.currentIndex || target.method !== 'GET' || !/^https?:\/\//.test(target.url)) return;
  const evidence = action.basis.evidence.find(e => e.source === 'adapter-playwright' && e.rule === 'browser-history-return/v1'
    && e.facts.observationId === action.observationId && e.facts.browserSessionId === history.browserSessionId
    && e.facts.fromEntryId === current.id && e.facts.fromUrl === current.url && e.facts.toEntryId === target.id && e.facts.toUrl === target.url);
  return evidence ? target : undefined;
}

export function historyReturn(target: Observation, current: Observation, session: Session): ActionCandidate | undefined {
  if (session.dirty || current.boundaries?.length || current.gaps.some(g => g.critical) || target.gaps.some(g => g.critical)) return;
  const source = target.navigation, live = current.navigation;
  if (!source || !live || source.browserSessionId !== live.browserSessionId) return;
  const original = source.entries[source.currentIndex], from = live.entries[live.currentIndex];
  if (!original || !from || original.url !== target.url || from.url !== current.url || original.method !== 'GET') return;
  const action: ActionCandidate = { id: id(), sessionId: session.id, observationId: current.id, stateId: current.stateId,
    kind: 'history', value: original.id, label: 'Return to observed page', source: 'browser-history-return', risk: 'interface',
    replayable: false, excluded: false, sampleValidity: 'known', preconditions: { context: current.context, visible: true, enabled: true, identityResolved: true },
    basis: { status: 'supported', evidence: [{ source: 'adapter-playwright', rule: 'browser-history-return/v1', facts: {
      observationId: current.id, targetObservationId: target.id, browserSessionId: live.browserSessionId,
      fromEntryId: from.id, fromUrl: from.url, toEntryId: original.id, toUrl: original.url, method: 'GET',
    } }] } };
  return historyTarget(action, live) ? action : undefined;
}
