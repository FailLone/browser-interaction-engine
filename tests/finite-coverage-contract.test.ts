import {it,expect} from 'vitest';
import {explorerFixture} from './explorer-plugin-helpers.js';
import {browserOperationKey,browserTargetConditions,browserControlBindingKey} from '@interaction/browser';
import {finiteNavigationState} from '../packages/adapter-playwright/src/finite-coverage.js';

it('keeps finite operation obligations stable across unrelated selectors but retains constraints and target disclosure branches',async()=>{
 const f=await explorerFixture('<label>Pair<select id="pair"><option>A</option><option>B</option></select></label><label>Amount<input id="amount" type="number" min="1"></label><button aria-expanded="false" type="button">Open</button>');
 try{const s=await f.host.createSession({url:f.url,headless:true,coveragePolicy:'finite-ui-v1'});const o=f.host.observation(s.id),a=f.host.actions(s.id).find(a=>a.label==='Amount'&&a.kind==='fill')!;const changed=structuredClone(o);changed.controls.find(c=>c.selector==='#pair')!.selected=['B'];
 expect(browserOperationKey(a,o)).toBe(browserOperationKey(a,changed));expect(browserTargetConditions(a,o)?.key).toBe(browserTargetConditions(a,changed)?.key);
 expect(finiteNavigationState(o)).not.toEqual(finiteNavigationState(changed));changed.controls.find(c=>c.localId===a.localId)!.constraints.min='2';expect(browserOperationKey(a,o)).not.toBe(browserOperationKey(a,changed));
 const button=f.host.actions(s.id).find(a=>a.label==='Open')!;const expanded=structuredClone(o);expanded.controls.find(c=>c.localId===button.localId)!.expanded=true;expect(browserOperationKey(button,o)).not.toBe(browserOperationKey(button,expanded));
 const legacy=structuredClone(o);delete legacy.coveragePolicy;const legacyChanged=structuredClone(changed);delete legacyChanged.coveragePolicy;expect(browserOperationKey(a,legacy)).not.toBe(browserOperationKey(a,legacyChanged));
 }finally{await f.close();}
});
it('binds symmetric controls to distinct document instances, never ordinal or label identity',async()=>{
 const f=await explorerFixture('<label>Reference<input type="text"></label><label>Reference<input type="text"></label>');
 try{const s=await f.host.createSession({url:f.url,headless:true,coveragePolicy:'finite-ui-v1'}),o=f.host.observation(s.id);const refs=o.controls.filter(c=>c.tag==='input');expect(refs).toHaveLength(2);expect(browserControlBindingKey(refs[0],o)).not.toBe(browserControlBindingKey(refs[1],o));const rebuilt=structuredClone(o);rebuilt.instanceScope='new-document';expect(browserControlBindingKey(refs[0],o)).not.toBe(browserControlBindingKey(refs[0],rebuilt));
 }finally{await f.close();}
});
it('allows explicitly scoped local simulation while preserving submission risk and refusing other URLs',async()=>{
 const f=await explorerFixture('<form onsubmit="event.preventDefault()"><button>Submit</button></form>');
 try{const no=await f.host.createSession({url:f.url,headless:true,executionPolicy:'observed-ui'});let a=f.host.actions(no.id).find(a=>a.label==='Submit')!;expect(f.host.actionAvailability(no.id).actions.find(x=>x.actionId===a.id)?.blockers.some(b=>b.reason==='submission_not_authorized')).toBe(true);
 await f.host.stop(no.id);
 const yes=await f.host.createSession({url:f.url,headless:true,executionPolicy:'observed-ui',coveragePolicy:'finite-ui-v1',localSimulation:{url:f.url}});a=f.host.actions(yes.id).find(a=>a.label==='Submit')!;expect(a.risk).toBe('submission');expect(f.host.actionAvailability(yes.id).actions.find(x=>x.actionId===a.id)?.executable).toBe(true);const receipt=await f.host.execute(yes.id,a.id,'local-submit',undefined,{profile:'observed-ui-exploration',observationId:a.observationId});expect(receipt.status).toBe('succeeded');expect(f.host.operationReceiptCondition(yes.id,{attemptId:receipt.id}).conditionVerified).toBe(true);expect(receipt.effectsAssessment).toBe('not-assessed');
 await f.host.stop(yes.id);
 const other=await f.host.createSession({url:f.url,headless:true,executionPolicy:'observed-ui',localSimulation:{url:f.url+'different'}});a=f.host.actions(other.id).find(a=>a.label==='Submit')!;expect(f.host.actionAvailability(other.id).actions.find(x=>x.actionId===a.id)?.blockers.some(b=>b.reason==='submission_not_authorized')).toBe(true);
 }finally{await f.close();}
});
