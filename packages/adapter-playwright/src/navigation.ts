import { id } from './util.js';
import type { ActionCandidate, BrowserHistory, Observation, Session } from './types.js';
import type { ObservedSourcePosition } from '@interaction/core';

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


/** A router may intercept a native link and preserve its fragment. Require the
 * captured HTTP destination, not a label or a guessed route, to match exactly. */
export function sameHTTPDestination(a:string,b:string):boolean {
 try{const x=new URL(a),y=new URL(b);return ['http:','https:'].includes(x.protocol)&&x.origin+x.pathname+x.search===y.origin+y.pathname+y.search;}catch{return false;}
}
function committedNavigationProof(current:Observation):boolean {
 const proof=current.navigationCapture,entry=current.navigation?.entries[current.navigation.currentIndex];
 if(!proof||proof.documentId!==current.documentId||proof.observedUrl!==current.url||proof.sourceUrl===current.url
   ||proof.samples<2||proof.settledMs<0||entry?.url!==current.url||entry.method!=='GET')return false;
 return proof.version===1?proof.sourceDocumentId!==current.documentId:
   proof.transition==='same-document-url'&&proof.sourceDocumentId===current.documentId&&proof.entryId===entry.id
   &&sameHTTPDestination(proof.requestedUrl,current.url);
}

/** Fresh URL/document samples plus native GET history establish a position,
 * including after local work on a continuously changing page. They never prove
 * a prior control returned, its old conditions, or a navigation action effect. */
export function settledNativePosition(o:Observation):boolean {
 const p=o.navigationPositionCapture,h=o.navigation,entry=h?.entries[h.currentIndex];
 return !!p&&p.version===1&&p.documentId===o.documentId&&p.url===o.url&&p.samples>=2&&p.settledMs>=0
   &&h?.browserSessionId===p.browserSessionId&&entry?.id===p.entryId&&entry.url===o.url&&entry.method==='GET'
   &&!o.gaps.some(g=>g.critical);
}

/** Only a committed, separately settled native document can avoid recapturing
 * unrelated changing controls before history return. No control readiness or
 * restored source-state equivalence is asserted here. */
export function nativeDocumentReturnReady(target: Observation, current: Observation) {
  return (target.stable||settledNativePosition(target))&&!target.gaps.some(g=>g.critical)&&!current.gaps.some(g=>g.critical)&&!current.boundaries?.length
    &&(committedNavigationProof(current)||settledNativePosition(current))
    &&observedSourcePosition(target,current).status==='returnable';
}

/** Native entry identity survives document changes; it never proves the old UI was restored. */
export function observedSourcePosition(target: Observation, current: Observation): ObservedSourcePosition {
  const checks: ObservedSourcePosition['checks'] = [];
  const result = (status: ObservedSourcePosition['status'], reason: string): ObservedSourcePosition => ({ status, reason, checks });
  const source = target.navigation, live = current.navigation;
  const original = source?.entries[source.currentIndex], position = live?.entries[live.currentIndex];
  checks.push({ name: 'native-history-evidence', result: source && live && original && position ? 'pass' : 'unknown' });
  if (!source || !live || !original || !position) return result('unknown', 'native_history_unavailable');
  checks.push({ name: 'native-browser-session', result: source.browserSessionId === live.browserSessionId ? 'pass' : 'fail' });
  if (source.browserSessionId !== live.browserSessionId) return result('unavailable', 'native_browser_session_changed');
  checks.push({ name: 'native-source-get', result: original.method === 'GET' && /^https?:\/\//.test(original.url) && original.url === target.url ? 'pass' : 'fail' });
  if (checks.at(-1)!.result !== 'pass') return result('unavailable', 'native_source_not_verified_get');
  const entries = live.entries.filter(entry => entry.id === original.id);
  checks.push({ name: 'native-source-entry', result: entries.length === 1 && entries[0].url === original.url && entries[0].method === 'GET' ? 'pass' : 'fail' });
  if (checks.at(-1)!.result !== 'pass') return result('unavailable', 'native_source_entry_unavailable');
  checks.push({ name: 'native-current-position', result: position.url === current.url && live.entries.filter(entry => entry.id === position.id).length === 1 ? 'pass' : 'unknown' });
  if (checks.at(-1)!.result !== 'pass') return result('unknown', 'native_current_position_unverified');
  const reached = position.id === original.id && current.url === target.url && position.method === 'GET';
  checks.push({ name: 'observed-source-position', result: reached ? 'pass' : 'fail' });
  return result(reached ? 'reached' : 'returnable', reached ? 'observed_source_position_reached' : 'native_source_return_available');
}

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
