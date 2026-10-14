import type { ActionBasis, ActionEvidence } from '@interaction/core';

// Serialized into the page. No imports or framework internals are used at runtime.
export function collectActionEvidence(el: Element) {
  const actionBasis: Record<string, ActionBasis> = {};
  const interactionHints: ActionEvidence[] = [];
  const tag = el.tagName.toLowerCase();
  const input = el as HTMLInputElement;
  const type = tag === 'input' ? input.type : tag;
  const role = el.getAttribute('role');
  const supports = (kind: string, source: string, rule: string, facts: ActionEvidence['facts']) => {
    const evidence = { source, rule, facts };
    if (actionBasis[kind]) actionBasis[kind].evidence.push(evidence);
    else actionBasis[kind] = { status: 'supported', evidence: [evidence] };
  };
  // Capabilities do not depend on disabled/readonly/visibility; those are preconditions.
  if (tag === 'button' || tag === 'input' && ['button', 'submit', 'reset', 'image'].includes(type)) {
    const button = el as HTMLButtonElement | HTMLInputElement;
    const formMethod = button.hasAttribute('formmethod') ? button.formMethod : button.form?.method;
    supports('click', 'html', 'native-button/v1', { tag, type: button.type, submitsForm: !!button.form && ['submit', 'image'].includes(button.type) && formMethod?.toLowerCase() !== 'dialog' });
  } else if (tag === 'a' && el.hasAttribute('href')) {
    supports('click', 'html', 'hyperlink/v1', { tag, href: el.getAttribute('href') });
  } else if (tag === 'summary' && el.parentElement?.tagName === 'DETAILS' && [...el.parentElement.children].find(c => c.tagName === 'SUMMARY') === el) {
    supports('click', 'html', 'details-summary/v1', { tag, parentTag: 'details', firstSummary: true });
  } else if (tag === 'select') {
    supports('select', 'html', 'native-select/v1', { tag });
  } else if (tag === 'input' && ['checkbox', 'radio'].includes(type)) {
    supports('check', 'html', 'native-checkable/v1', { tag, type });
  } else if (tag === 'textarea' || tag === 'input' && ['text', 'search', 'tel', 'url', 'email', 'password', 'number', 'date', 'time', 'datetime-local', 'month', 'week'].includes(type)) {
    supports('fill', 'html', 'native-text-entry/v1', { tag, type });
  } else if ((el as HTMLElement).isContentEditable) {
    supports('fill', 'html', 'editable-host/v1', { tag, contenteditable: el.getAttribute('contenteditable') });
  } else if (['button', 'link', 'tab', 'menuitem', 'option', 'combobox'].includes(role || '')) {
    supports('click', 'aria', 'declared-activation/v1', { role, implementation: 'unverified' });
  } else if (['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role || '')) {
    supports('check', 'aria', 'declared-checkable/v1', { role, implementation: 'unverified' });
  }
  // These describe focus, presentation or state, never a click contract.
  for (const attribute of ['tabindex', 'aria-expanded', 'aria-controls']) if (el.hasAttribute(attribute)) {
    interactionHints.push({ source: 'dom-signal', rule: `${attribute}/v1`, facts: { attribute, value: el.getAttribute(attribute) } });
  }
  if (getComputedStyle(el).cursor === 'pointer') interactionHints.push({ source: 'css', rule: 'pointer-cursor/v1', facts: { cursor: 'pointer', inherited: !!el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer' } });
  // A handler may only delegate, log or stop propagation. Do not infer its purpose
  // from source text or promote ancestors just because a descendant is actionable.
  if (el.hasAttribute('onclick') || typeof (el as HTMLElement).onclick === 'function') {
    const hint: ActionEvidence = { source: 'dom-signal', rule: 'click-handler/v1', facts: { inlineAttribute: el.hasAttribute('onclick'), handlerProperty: typeof (el as HTMLElement).onclick === 'function', purpose: 'unknown' } };
    interactionHints.push(hint);
    if (!actionBasis.click && !Object.keys(actionBasis).length) actionBasis.click = { status: 'tentative', evidence: [hint] };
  }
  return { actions: Object.keys(actionBasis), actionBasis, interactionHints };
}
