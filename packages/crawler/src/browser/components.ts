import type { BrowserComponent, Control } from './types.js';

/** Serialized collector: groups structure; never invents values from sibling indexes. */
export function collectComponents(
  elements: Element[],
  controls: Control[],
  popups: { content: Element; panel: Element; trigger?: Element }[],
): BrowserComponent[] {
  const tracker = (window as any).__interactionEvidenceTracker;
  const instance = (el: Element): string => {
    if (!tracker.ids.has(el)) tracker.ids.set(el, `${tracker.documentId}:${++tracker.counter}`);
    return tracker.ids.get(el);
  };
  const clean = (value: string | null | undefined) => {
    const s = (value || '').replace(/\s+/g, ' ').trim();
    return s.length <= 200 ? s : '';
  };
  const label = (el: Element) =>
    clean(
      el.getAttribute('aria-label') ||
        (el.getAttribute('aria-labelledby') || '')
          .split(/\s+/)
          .map(id => document.getElementById(id)?.textContent || '')
          .join(' ') ||
        (el.tagName === 'FIELDSET' ? el.querySelector(':scope > legend')?.textContent : ''),
    );
  const byElement = new Map(elements.map((e, i) => [e, controls[i]]));
  const roots = new Map<Element, { kind: string; declared: boolean; trigger?: Element; content?: Element }>();
  for (const root of document.querySelectorAll(
    'fieldset,[role=radiogroup],[role=tablist],[role=listbox],[role=menu],[role=group],[data-component-kind]',
  )) {
    roots.set(root, {
      kind: root.getAttribute('data-component-kind') || root.getAttribute('role') || 'group',
      declared: true,
    });
  }
  for (const popup of popups) {
    if (popup.panel !== popup.content) roots.delete(popup.content);
    roots.set(popup.panel, { kind: 'choice-popup', declared: false, trigger: popup.trigger, content: popup.content });
  }
  // Equal-role direct siblings suggest a group, not its business type or order values.
  for (const el of elements) {
    const parent = el.parentElement;
    if (!parent || parent === document.body || roots.has(parent)) continue;
    const members = Array.from(parent.children)
      .map(e => byElement.get(e))
      .filter((c): c is Control => !!c && c.actions.length > 0);
    if (
      members.length >= 2 &&
      members.length <= 20 &&
      members.every(
        c => c.role === members[0].role && ['button', 'radio', 'checkbox', 'tab', 'option'].includes(c.role),
      )
    ) {
      roots.set(parent, { kind: 'choice-group', declared: false });
    }
  }
  const result: BrowserComponent[] = [];
  for (const [root, details] of roots) {
    const members = controls.flatMap((c, i) => {
      const el = elements[i];
      if (!el || !((root.contains(el) && el !== root) || el === details.trigger) || !c.actions.length) return [];
      if (
        el !== details.trigger &&
        [...roots.keys()].some(inner => inner !== root && root.contains(inner) && inner.contains(el))
      )
        return [];
      const value =
        el.getAttribute('data-component-value') ??
        (el.matches('input[type=radio],input[type=checkbox],option,[role=option],[role=radio]')
          ? el.getAttribute('value')
          : null);
      return [
        {
          localId: c.localId,
          role: el === details.trigger ? 'trigger' : c.actions.includes('fill') ? 'input' : c.role,
          name: c.name,
          ...(value !== null ? { value } : {}),
          ...(c.checked !== null
            ? { selected: c.checked }
            : el.hasAttribute('aria-selected')
              ? { selected: el.getAttribute('aria-selected') === 'true' }
              : {}),
        },
      ];
    });
    if (!members.length) continue;
    const nodeId = instance(root);
    const r = root.getBoundingClientRect();
    result.push({
      id: `component:${nodeId}`,
      rootNodeId: nodeId,
      kind: details.kind,
      name:
        label(root) ||
        (root.parentElement ? label(root.parentElement) : '') ||
        (details.trigger ? byElement.get(details.trigger)?.name || '' : ''),
      members,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      basis: {
        status: details.declared ? 'supported' : 'tentative',
        evidence: [
          {
            source: details.declared ? 'page-declaration' : 'dom-structure',
            rule: details.declared
              ? 'declared-component/v1'
              : details.content
                ? 'choice-popup-component/v1'
                : 'sibling-choice-group/v1',
            facts: {
              rootNodeId: nodeId,
              kind: details.kind,
              meaning: details.declared ? 'page-declared' : 'unverified',
              memberCount: members.length,
            },
          },
        ],
      },
    });
  }
  for (const component of result) {
    const root = [...roots.keys()].find(r => instance(r) === component.rootNodeId)!;
    for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const parent = result.find(c => c.rootNodeId === instance(ancestor));
      if (parent) {
        component.parentId = parent.id;
        break;
      }
    }
  }
  return result;
}
