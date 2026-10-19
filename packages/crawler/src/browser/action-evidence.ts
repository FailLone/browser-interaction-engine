import type { ActionBasis, ActionEvidence } from './types.js';

// Serialized into the page without imported runtime helpers. Event metadata is
// read through own data descriptors without invoking its handlers or accessors.
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
  if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset', 'image'].includes(type))) {
    const button = el as HTMLButtonElement | HTMLInputElement;
    const formMethod = button.hasAttribute('formmethod') ? button.formMethod : button.form?.method;
    supports('click', 'html', 'native-button/v1', {
      tag,
      type: button.type,
      submitsForm: !!button.form && ['submit', 'image'].includes(button.type) && formMethod?.toLowerCase() !== 'dialog',
    });
  } else if (tag === 'a' && el.hasAttribute('href')) {
    supports('click', 'html', 'hyperlink/v1', { tag, href: el.getAttribute('href') });
  } else if (
    tag === 'summary' &&
    el.parentElement?.tagName === 'DETAILS' &&
    [...el.parentElement.children].find(c => c.tagName === 'SUMMARY') === el
  ) {
    supports('click', 'html', 'details-summary/v1', { tag, parentTag: 'details', firstSummary: true });
  } else if (tag === 'select') {
    supports('select', 'html', 'native-select/v1', { tag });
  } else if (tag === 'input' && ['checkbox', 'radio'].includes(type)) {
    supports('check', 'html', 'native-checkable/v1', { tag, type });
  } else if (
    tag === 'textarea' ||
    (tag === 'input' &&
      [
        'text',
        'search',
        'tel',
        'url',
        'email',
        'password',
        'number',
        'date',
        'time',
        'datetime-local',
        'month',
        'week',
      ].includes(type))
  ) {
    supports('fill', 'html', 'native-text-entry/v1', { tag, type });
  } else if ((el as HTMLElement).isContentEditable) {
    supports('fill', 'html', 'editable-host/v1', { tag, contenteditable: el.getAttribute('contenteditable') });
  } else if (['button', 'link', 'tab', 'menuitem', 'option', 'combobox'].includes(role || '')) {
    supports('click', 'aria', 'declared-activation/v1', { role, implementation: 'unverified' });
  } else if (['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role || '')) {
    supports('check', 'aria', 'declared-checkable/v1', { role, implementation: 'unverified' });
  }
  // These describe focus, presentation or state, never a click contract.
  for (const attribute of ['tabindex', 'aria-expanded', 'aria-controls'])
    if (el.hasAttribute(attribute)) {
      interactionHints.push({
        source: 'dom-signal',
        rule: `${attribute}/v1`,
        facts: { attribute, value: el.getAttribute(attribute) },
      });
    }
  if (getComputedStyle(el).cursor === 'pointer')
    interactionHints.push({
      source: 'css',
      rule: 'pointer-cursor/v1',
      facts: {
        cursor: 'pointer',
        inherited: !!el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer',
      },
    });
  // A handler may only delegate, log or stop propagation. Do not infer its purpose
  // from source text or promote ancestors just because a descendant is actionable.
  const handler = (el as HTMLElement).onclick;
  // Exact empty bodies have no target operation. This recognizes syntax, not
  // framework names or handler business intent. Parameters/default expressions,
  // native/bound functions and every nonempty body remain unknown.
  let emptyHandler = false;
  if (typeof handler === 'function' && !el.hasAttribute('onclick'))
    try {
      emptyHandler = /^(?:function(?:\s+[\w$]+)?\s*\(\s*\)|\(\s*\)\s*=>)\s*\{\s*\}$/.test(
        Function.prototype.toString.call(handler).trim(),
      );
    } catch {
      /* Opaque function remains an interaction hint. */
    }
  if (emptyHandler)
    interactionHints.push({
      source: 'javascript-syntax',
      rule: 'empty-handler-body/v1',
      facts: { parameterCount: 0, body: 'empty', otherListeners: 'not-enumerated' },
    });
  if (el.hasAttribute('onclick') || (typeof handler === 'function' && !emptyHandler)) {
    const hint: ActionEvidence = {
      source: 'dom-signal',
      rule: 'click-handler/v1',
      facts: {
        inlineAttribute: el.hasAttribute('onclick'),
        handlerProperty: typeof (el as HTMLElement).onclick === 'function',
        purpose: 'unknown',
      },
    };
    interactionHints.push(hint);
    if (!actionBasis.click && !Object.keys(actionBasis).length)
      actionBasis.click = { status: 'tentative', evidence: [hint] };
  }
  // React delegates native listeners to a root, but attaches current event props
  // to their actual DOM target. These are untrusted operation hints, not evidence
  // of what the function does. Do not borrow a child's/ancestor's props, invoke
  // getters, inspect closures or infer that other listeners are absent.
  const propsKeys = Object.getOwnPropertyNames(el).filter(key => key.startsWith('__reactProps$'));
  if (propsKeys.length === 1) {
    const props = Object.getOwnPropertyDescriptor(el, propsKeys[0])?.value;
    if (props && typeof props === 'object') {
      const events: Record<string, string | undefined> = {
        onClick: 'click',
        onMouseEnter: 'hover',
        onMouseOver: 'hover',
        onPointerEnter: 'hover',
        onPointerOver: 'hover',
        onMouseLeave: undefined,
        onPointerLeave: undefined,
        onFocus: undefined,
        onBlur: undefined,
        onKeyDown: undefined,
        onInput: undefined,
        onChange: undefined,
      };
      for (const [eventProperty, kind] of Object.entries(events))
        if (typeof Object.getOwnPropertyDescriptor(props, eventProperty)?.value === 'function') {
          const hint: ActionEvidence = {
            source: 'runtime-metadata',
            rule: 'react-event-prop/v1',
            facts: {
              eventProperty,
              binding: 'own-data-property',
              purpose: 'unknown',
              otherListeners: 'not-enumerated',
            },
          };
          interactionHints.push(hint);
          if (kind && !actionBasis[kind]) actionBasis[kind] = { status: 'tentative', evidence: [hint] };
          else if (kind && actionBasis[kind].status === 'tentative') actionBasis[kind].evidence.push(hint);
        }
    }
  } else if (propsKeys.length > 1)
    interactionHints.push({
      source: 'runtime-metadata',
      rule: 'ambiguous-react-event-props/v1',
      facts: { count: propsKeys.length, purpose: 'unknown' },
    });
  return { actions: Object.keys(actionBasis), actionBasis, interactionHints };
}
