/** Serialized into the page. Structural relations remain tentative operation evidence. */
export function collectPopupRelations() {
  const result: { content: Element; panel: Element; trigger?: Element; retained?: boolean }[] = [];
  const triggerFor = (panel: Element) => {
    const owner = panel.parentElement;
    if (!owner || getComputedStyle(owner).cursor !== 'pointer' || owner.parentElement && getComputedStyle(owner.parentElement).cursor === 'pointer') return;
    const siblings = Array.from(owner.children).filter(e => e !== panel);
    const title = siblings.length === 1 ? siblings[0] : undefined;
    if (title && (title.textContent || '').trim().length > 0 && (title.textContent || '').length <= 200 &&
      !title.matches('input,button,a,select,textarea') && !title.querySelector('input,button,a,select,textarea,[role=button]')) return owner;
  };
  for (const content of document.querySelectorAll('[role=listbox],[role=menu]')) {
    let panel = content;
    for (let parent = content.parentElement, depth = 0; parent && parent !== document.body && depth < 6; parent = parent.parentElement, depth++) {
      if (parent.matches('main,nav,header,footer,aside,form,dialog,[role=dialog],[role=alertdialog],[role=main],[role=navigation],[role=complementary],[aria-modal=true],[popover]')) break;
      if (parent.querySelectorAll('[role=listbox],[role=menu]').length !== 1) break;
      // A positioned owner containing the explicit opener is not itself the popup.
      if (content.id && Array.from(parent.querySelectorAll('[aria-controls],[aria-owns],[popovertarget]')).some(e => !content.contains(e)
        && ['aria-controls', 'aria-owns', 'popovertarget'].some(a => e.getAttribute(a)?.split(/\s+/).includes(content.id)))) break;
      if (['absolute', 'fixed'].includes(getComputedStyle(parent).position)) {
        if (panel === content) panel = parent;
        // An enclosing positioned panel owns its sibling search field as well
        // as the inner virtual list. Never widen to an arbitrary page ancestor.
        if (Array.from(parent.querySelectorAll('input,textarea,[contenteditable=true]')).some(e => !content.contains(e))) { panel = parent; break; }
      }
    }
    const trigger = panel !== content ? triggerFor(panel) : undefined;
    result.push({ content, panel, trigger });
  }
  // Filtering can remove the list while its panel and trigger remain. Retain
  // only that observed relationship, never transfer it to replacement nodes.
  // It supplies a tentative click hint, not permission or a successful exit.
  const tracker = (window as any).__interactionEvidenceTracker;
  for (const prior of (tracker.choicePopupRelations || []) as typeof result) {
    if (!prior.content.isConnected && prior.panel.isConnected && prior.trigger?.isConnected && triggerFor(prior.panel) === prior.trigger
      && prior.panel.querySelector('input,textarea,[contenteditable=true]') && !result.some(r => r.panel === prior.panel)) result.push({ ...prior, retained: true });
  }
  tracker.choicePopupRelations = result;
  return result;
}
