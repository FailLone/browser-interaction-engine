import type { Control, OwnerDependencies, OwnerDependencyLimits, OwnerDependencyNode, OwnerDependencyReference, OwnerDependencyClosure } from './types.js';

/** Runs within one collectDOM evaluation. Bounded observable evidence only;
 * neither a business dependency discovery algorithm nor an identity grant. */
export function collectOwnerDependencies(controls: Control[], elements: Element[], instance: (el: Element) => string, documentId: string,
  limits: OwnerDependencyLimits = { nodes: 512, references: 64, bytes: 131072, depth: 16 }): OwnerDependencies {
  const result: OwnerDependencies = { version: 'browser-owner-dependencies-v1', documentId, baseURI: document.baseURI,
    selectorIds: controls.filter(c => c.checked != null || c.pressed != null || c.expanded != null || c.tag === 'select'
      || ['checkbox', 'radio', 'switch', 'tab', 'option', 'treeitem'].includes(c.role)).map(c => c.localId),
    inventoryComplete: true, roots: [], closures: [], nodes: [], references: [], limits: { ...limits }, complete: false, reasons: [] };
  const reasons = new Set<string>(), encoder = new TextEncoder();
  const size = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
  // Reserve room for bounded status/reason metadata. Entries are charged once;
  // replacing an ancestor-only node charges only its additional bytes.
  let bytes = size(result) + 1024;
  const reserve = (additional: number) => {
    if (bytes + additional > limits.bytes) { reasons.add('byte_budget'); return false; }
    bytes += additional; return true;
  };
  const incompleteInventory = () => {
    result.inventoryComplete = false; result.complete = false; result.reasons = [...reasons];
    // Never preserve a partial graph as a seemingly complete root inventory.
    result.roots = []; result.closures = []; result.nodes = []; result.references = [];
    if (size(result) > limits.bytes) { result.selectorIds = []; result.baseURI = ''; }
    return result;
  };
  if (bytes > limits.bytes) { reasons.add('byte_budget'); return incompleteInventory(); }
  // Native fields can affect operations outside their local DOM owner. The
  // existing action inventory excludes hidden inputs; do not silently claim
  // a complete dependency inventory or create new logical controls for them.
  const retainedElements = new Set(elements);
  for (const input of document.querySelectorAll('input,select,textarea')) if (!retainedElements.has(input)) {
    reasons.add('unretained_native_input'); return incompleteInventory();
  }
  const itemSelector = '[data-row-key],[data-item-key],li,tr,[role=row],[role=listitem],[role=treeitem],[role=option]';
  const idrefAttributes = new Set(['for', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant', 'aria-details', 'aria-errormessage', 'headers', 'list', 'form', 'popovertarget', 'commandfor']);
  const nodes = new Map<Element, OwnerDependencyNode | undefined>(), nodeIndices = new Map<string, number>();
  const nodeFailures = new Map<Element, string[]>(), expanded = new Map<Element, { children: Element[]; reasons: string[] }>();
  const references = new Map<Element, { indices: number[]; targets: Element[]; reasons: string[] }>();
  const associations = new Map<Element, { form?: HTMLFormElement; labels?: HTMLLabelElement[] }>();
  const idTargets = new Map<string, Element[]>(), closures = new Map<Element, OwnerDependencyClosure>();
  const fail = (local: Set<string>, reason: string) => { local.add(reason); reasons.add(reason); };
  const readNode = (el: Element) => {
    if (nodes.has(el)) return nodes.get(el);
    const local = new Set<string>();
    if (result.nodes.length >= limits.nodes) { fail(local, 'node_budget'); nodes.set(el, undefined); nodeFailures.set(el, [...local]); return; }
    const attributes: Record<string, string> = Object.create(null); let characters = 0;
    for (const attribute of el.attributes) {
      characters += attribute.name.length + attribute.value.length;
      if (characters > limits.bytes) { fail(local, 'byte_budget'); break; }
      attributes[attribute.name] = attribute.value;
    }
    const live: NonNullable<OwnerDependencyNode['live']> = {}, resolved: NonNullable<OwnerDependencyNode['resolved']> = {};
    const value = (text: string) => { if (text.length > limits.bytes) { fail(local, 'byte_budget'); return undefined; } return text; };
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) live.value = value(el.value);
    if (el instanceof HTMLInputElement) { live.checked = el.checked; live.indeterminate = el.indeterminate; }
    if (el instanceof HTMLOptionElement) live.selected = el.selected;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) live.readOnly = el.readOnly;
    if (el instanceof HTMLSelectElement || el instanceof HTMLInputElement) live.multiple = el.multiple;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el instanceof HTMLButtonElement || el instanceof HTMLOptionElement || el instanceof HTMLFieldSetElement) live.disabled = el.disabled;
    if (el instanceof HTMLAnchorElement || el instanceof HTMLAreaElement) resolved.href = value(el.href);
    if (el instanceof HTMLImageElement || el instanceof HTMLIFrameElement || el instanceof HTMLScriptElement) resolved.src = value(el.src);
    if (el instanceof HTMLFormElement) resolved.action = value(el.action);
    if ((el instanceof HTMLButtonElement || el instanceof HTMLInputElement) && el.hasAttribute('formaction')) resolved.formAction = value(el.formAction);
    const associated: NonNullable<OwnerDependencyNode['associations']> = {}, targets: { form?: HTMLFormElement; labels?: HTMLLabelElement[] } = {};
    if (el instanceof HTMLInputElement || el instanceof HTMLButtonElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement || el instanceof HTMLFieldSetElement || el instanceof HTMLOutputElement) {
      targets.form = el.form || undefined; associated.formId = targets.form ? instance(targets.form) : '';
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLButtonElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement || el instanceof HTMLOutputElement || el instanceof HTMLMeterElement || el instanceof HTMLProgressElement) {
      targets.labels = [];
      for (const label of el.labels || []) { if (targets.labels.length >= limits.references) { fail(local, 'reference_budget'); break; } targets.labels.push(label); }
      associated.labelIds = targets.labels.map(instance);
    }
    associations.set(el, targets);
    if (el.getRootNode() !== document || el.shadowRoot) fail(local, 'unsupported_shadow_scope');
    if (el instanceof HTMLIFrameElement || el instanceof HTMLObjectElement || el instanceof HTMLEmbedElement) fail(local, 'embedded_document');
    const node: OwnerDependencyNode = { id: instance(el), parentId: el.parentElement ? instance(el.parentElement) : '', tag: el.tagName.toLowerCase(),
      attributes, childrenComplete: false, ...(Object.keys(live).length ? { live } : {}), ...(Object.keys(associated).length ? { associations: associated } : {}),
      ...(Object.keys(resolved).length ? { resolved } : {}), complete: !local.size, reasons: [...local] };
    if (!reserve(size(node) + 1)) { nodes.set(el, undefined); nodeFailures.set(el, ['byte_budget']); return; }
    nodes.set(el, node); nodeIndices.set(node.id, result.nodes.length); result.nodes.push(node); return node;
  };
  const expand = (el: Element, node: OwnerDependencyNode) => {
    if (expanded.has(el)) return expanded.get(el)!;
    const local = new Set<string>(), children: NonNullable<OwnerDependencyNode['children']> = [], elements: Element[] = [];
    let characters = 0, count = 0;
    for (const child of el.childNodes) {
      if (++count > limits.nodes * 2) { fail(local, 'node_budget'); break; }
      if (child instanceof Element) { elements.push(child); children.push({ nodeId: instance(child) }); }
      else if (child.nodeType === Node.TEXT_NODE) {
        characters += child.textContent?.length || 0;
        if (characters > limits.bytes) { fail(local, 'byte_budget'); break; }
        children.push({ text: child.textContent || '' });
      } else if (child.nodeType !== Node.COMMENT_NODE) fail(local, 'unsupported_child_node');
    }
    const updated = { ...node, children, childrenComplete: !local.size };
    if (reserve(Math.max(0, size(updated) - size(node)))) Object.assign(node, updated);
    else { fail(local, 'byte_budget'); elements.length = 0; }
    const entry = { children: elements, reasons: [...local] }; expanded.set(el, entry); return entry;
  };
  const readReferences = (el: Element, node: OwnerDependencyNode) => {
    if (references.has(el)) return references.get(el)!;
    const local = new Set<string>(), indices: number[] = [], targets: Element[] = [];
    const add = (attribute: string, token: string, matches: Element[]) => {
      if (result.references.length >= limits.references) { fail(local, 'reference_budget'); return; }
      const status = matches.length === 1 ? 'unique' : matches.length ? 'ambiguous' : 'missing';
      // At most two matches are required to prove ambiguity; no first-match
      // inference or traversal into an arbitrarily chosen duplicate target.
      const ref: OwnerDependencyReference = { sourceId: node.id, attribute, token, status, targetIds: matches.slice(0, 2).map(instance) };
      if (!reserve(size(ref) + 1)) { fail(local, 'byte_budget'); return; }
      indices.push(result.references.length); result.references.push(ref);
      if (status === 'unique') targets.push(matches[0]); else fail(local, status === 'missing' ? 'missing_idref' : 'ambiguous_idref');
    };
    for (const [attribute, raw] of Object.entries(node.attributes)) if (idrefAttributes.has(attribute)) {
      for (const token of new Set(raw.trim().split(/\s+/).filter(Boolean))) {
        if (!idTargets.has(token)) { const found = document.querySelectorAll(`#${CSS.escape(token)}`); idTargets.set(token, found.length > 1 ? [found[0], found[1]] : found.length ? [found[0]] : []); }
        add(attribute, token, idTargets.get(token)!);
      }
    }
    const associated = associations.get(el);
    if (associated?.form) add('native:form', '', [associated.form]);
    for (const label of associated?.labels || []) add('native:label', instance(label), [label]);
    const entry = { indices, targets, reasons: [...local] }; references.set(el, entry); return entry;
  };
  const buildClosure = (owner: Element): OwnerDependencyClosure => {
    const prior = closures.get(owner); if (prior) return prior;
    const local = new Set<string>(), members = new Set<string>(), refIds = new Set<number>(), subtreeIds = new Set<string>();
    const visited = new Map<Element, number>();
    const ancestors = (el: Element, depth: number) => {
      let parent = el.parentElement, steps = 0;
      while (parent) {
        if (++steps > limits.depth) { fail(local, 'ancestor_depth'); break; }
        visit(parent, false, depth); parent = parent.parentElement;
      }
    };
    const visit = (el: Element, subtree: boolean, depth: number) => {
      if (depth > limits.depth) { fail(local, 'dependency_depth'); return; }
      const mode = subtree ? 2 : 1; if ((visited.get(el) || 0) >= mode) return; visited.set(el, mode);
      const node = readNode(el);
      if (!node) { for (const reason of nodeFailures.get(el) || ['node_unavailable']) fail(local, reason); return; }
      members.add(node.id); for (const reason of node.reasons) fail(local, reason);
      const refs = readReferences(el, node);
      for (const ref of refs.indices) refIds.add(ref);
      for (const reason of refs.reasons) fail(local, reason);
      for (const target of refs.targets) {
        subtreeIds.add(instance(target)); visit(target, true, depth + 1); ancestors(target, depth + 1);
      }
      if (subtree) {
        const tree = expand(el, node); for (const reason of tree.reasons) fail(local, reason);
        for (const child of tree.children) visit(child, true, depth + 1);
      }
    };
    if (owner === document.body || owner === document.documentElement) { fail(local, 'broad_owner_scope'); visit(owner, false, 0); }
    else { subtreeIds.add(instance(owner)); visit(owner, true, 0); }
    ancestors(owner, 0);
    // Nested semantic rows retain all enclosing record bindings, including
    // sibling links. No visibility/popup heuristic proves those irrelevant.
    for (let record = owner.parentElement?.closest(itemSelector); record; record = record.parentElement?.closest(itemSelector)) {
      subtreeIds.add(instance(record)); visit(record, true, 0);
    }
    const closure: OwnerDependencyClosure = { id: instance(owner), subtreeId: instance(owner), nodeIds: [...members].sort(),
      referenceIds: [...refIds].sort((a, b) => a - b), subtreeIds: [...subtreeIds].sort(), complete: !local.size, reasons: [...local].sort() };
    if (!reserve(size(closure) + 1)) { closure.complete = false; closure.reasons = [...new Set([...closure.reasons, 'byte_budget'])]; }
    result.closures.push(closure); closures.set(owner, closure); return closure;
  };
  const selectorIds = new Set(result.selectorIds), order = controls.map((control, index) => ({ control, element: elements[index] }))
    .sort((a, b) => Number(selectorIds.has(b.control.localId)) - Number(selectorIds.has(a.control.localId)));
  for (const { control, element } of order) {
    if (!element || instance(element) !== control.instanceId) { reasons.add('control_element_mismatch'); return incompleteInventory(); }
    const owner = element.closest(itemSelector) || element.parentElement || element;
    const closure = buildClosure(owner), complete = closure.complete && closure.nodeIds.includes(control.instanceId);
    const root = { localId: control.localId, instanceId: control.instanceId, ownerId: instance(owner), closureId: closure.id, complete,
      reasons: [...new Set([...closure.reasons, ...(!closure.nodeIds.includes(control.instanceId) ? ['target_not_captured'] : [])])].sort() };
    if (!reserve(size(root) + 1)) return incompleteInventory();
    result.roots.push(root);
  }
  result.complete = result.roots.every(root => root.complete); result.reasons = [...reasons].sort();
  // Includes inventory/closure metadata in the byte ceiling, not just raw nodes.
  if (size(result) > limits.bytes) { reasons.add('byte_budget'); return incompleteInventory(); }
  return result;
}
