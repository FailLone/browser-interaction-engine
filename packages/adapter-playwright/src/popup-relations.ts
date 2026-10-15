/** Serialized into the page. Structural relations remain tentative operation evidence. */
export function collectPopupRelations() {
  const result: { content: Element; panel: Element; trigger?: Element }[] = [];
  for (const content of document.querySelectorAll('[role=listbox],[role=menu]')) {
    let panel = content;
    for (let parent = content.parentElement, depth = 0; parent && parent !== document.body && depth < 6; parent = parent.parentElement, depth++) {
      if (parent.matches('dialog,[role=dialog],[role=alertdialog],[aria-modal=true],form')) break;
      if (parent.querySelectorAll('[role=listbox],[role=menu]').length !== 1) break;
      if (['absolute', 'fixed'].includes(getComputedStyle(parent).position)) {
        if (panel === content) panel = parent;
        // An enclosing positioned panel owns its sibling search field as well
        // as the inner virtual list. Never widen to an arbitrary page ancestor.
        if (Array.from(parent.querySelectorAll('input,textarea,[contenteditable=true]')).some(e => !content.contains(e))) { panel = parent; break; }
      }
    }
    const owner = panel.parentElement;
    let trigger: Element | undefined;
    if (owner && panel !== content && getComputedStyle(owner).cursor === 'pointer' &&
      (!owner.parentElement || getComputedStyle(owner.parentElement).cursor !== 'pointer')) {
      const siblings = Array.from(owner.children).filter(e => e !== panel);
      const title = siblings.length === 1 ? siblings[0] : undefined;
      if (title && (title.textContent || '').trim().length > 0 && (title.textContent || '').length <= 200 &&
        !title.matches('input,button,a,select,textarea') && !title.querySelector('input,button,a,select,textarea,[role=button]')) trigger = owner;
    }
    result.push({ content, panel, trigger });
  }
  return result;
}
