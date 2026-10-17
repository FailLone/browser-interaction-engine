import type { Control, OwnerDependencies, OwnerDependencySnapshot, OwnerDependencyLimits, OwnerDependencyNode, OwnerDependencyReference, OwnerDependencyClosure } from './types.js';
import type { createOwnerDependencyCodec } from './owner-dependency-codec.js';

export function collectOwnerDependencies(controls: Control[], elements: Element[], instance: (el: Element) => string, documentId: string,
  limits?: OwnerDependencyLimits): OwnerDependencies;
export function collectOwnerDependencies(controls: Control[], elements: Element[], instance: (el: Element) => string, documentId: string,
  limits: OwnerDependencyLimits | undefined, codecFactory: typeof createOwnerDependencyCodec): OwnerDependencySnapshot;

/** Runs within one collectDOM evaluation. Bounded observable evidence only;
 * neither a business dependency discovery algorithm nor an identity grant. */
export function collectOwnerDependencies(controls: Control[], elements: Element[], instance: (el: Element) => string, documentId: string,
  limits: OwnerDependencyLimits = { nodes: 512, references: 64, bytes: 131072, depth: 16 }, codecFactory?: typeof createOwnerDependencyCodec): OwnerDependencySnapshot {
  const result: OwnerDependencies = { version: 'browser-owner-dependencies-v2', documentId, baseURI: document.baseURI,
    selectorIds: controls.filter(c => c.checked != null || c.pressed != null || c.expanded != null || c.tag === 'select'
      || ['checkbox', 'radio', 'switch', 'tab', 'option', 'treeitem'].includes(c.role)).map(c => c.localId),
    inventoryComplete: true, nativeInputIds: [], nativeRoots: [], roots: [], closures: [], nodes: [], references: [], limits: { ...limits }, complete: false, reasons: [] };
  const reasons = new Set<string>(), encoder = new TextEncoder();
  const size = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
  const codec = codecFactory?.(), rawLimit = codec ? 1048576 : limits.bytes;
  let builder: ReturnType<ReturnType<typeof createOwnerDependencyCodec>['createBuilder']>;
  // Inventory is reserved in full before payload. The remaining fixed allowance
  // covers the bounded global reason set; payload entries are charged once.
  let bytes = 0, budgetFailure = 'byte_budget';
  const reserve = (additional: number, commit?: () => boolean) => {
    if (bytes + additional > rawLimit) { budgetFailure = codec ? 'raw_byte_budget' : 'byte_budget'; reasons.add(budgetFailure); return false; }
    if (commit && !commit()) { budgetFailure = builder?.stats().failure || 'byte_budget'; reasons.add(budgetFailure); return false; }
    bytes += additional; return true;
  };
  const incompleteInventory = () => {
    result.inventoryComplete = false; result.complete = false; result.reasons = [...reasons];
    // Never preserve a partial graph as a seemingly complete root inventory.
    result.roots = []; result.nativeRoots = []; result.closures = []; result.nodes = []; result.references = [];
    if (size(result) > limits.bytes) { result.selectorIds = []; result.nativeInputIds = []; result.baseURI = ''; }
    // Failure evidence is small and carries no complete inventory grant. A
    // compact codec rejection must never be repaired by a successful raw graph.
    return codec?.encode(result) || result;
  };
  const itemSelector = '[data-row-key],[data-item-key],li,tr,[role=row],[role=listitem],[role=treeitem],[role=option]';
  const ownerOf = (element: Element) => element.closest(itemSelector) || element.parentElement || element;
  const retainedElements = new Set<Element>(), localIds = new Set<string>(), instanceIds = new Set<string>();
  for (let index = 0; index < controls.length; index++) {
    const control = controls[index], element = elements[index];
    if (!element || !control.localId || !control.instanceId || instance(element) !== control.instanceId
      || retainedElements.has(element) || localIds.has(control.localId) || instanceIds.has(control.instanceId)) {
      reasons.add('control_element_mismatch'); return incompleteInventory();
    }
    retainedElements.add(element); localIds.add(control.localId); instanceIds.add(control.instanceId);
  }
  if (elements.length !== controls.length) { reasons.add('control_element_mismatch'); return incompleteInventory(); }
  // Native fields can affect operations outside their local DOM owner. Retain
  // omitted fields as bounded dependencies, without inventing controls/actions.
  const nativeOnly: Element[] = [];
  for (const input of document.querySelectorAll('input,select,textarea')) {
    if (result.nativeInputIds!.length >= limits.nodes) { reasons.add('native_input_budget'); return incompleteInventory(); }
    const inputId = instance(input);
    result.nativeInputIds!.push(inputId);
    if (!retainedElements.has(input)) nativeOnly.push(input);
  }
  // A failed root has a real, pre-paid inventory entry. Optional payload cannot
  // consume the space needed to report later roots or invalidate earlier ones.
  const nativeEntries = nativeOnly.map((element, index) => {
    const owner = ownerOf(element), ownerId = instance(owner);
    const root = { instanceId: instance(element), ownerId, closureId: ownerId, complete: false, reasons: ['byte_budget'] };
    result.nativeRoots!.push(root); return { element, owner, root, index };
  });
  const entries = controls.map((control, index) => {
    const element = elements[index], owner = ownerOf(element), ownerId = instance(owner);
    const root = { localId: control.localId, instanceId: control.instanceId, ownerId, closureId: ownerId, complete: false, reasons: ['byte_budget'] };
    result.roots.push(root); return { control, element, owner, root, index };
  });
  bytes = size(result) + 1024;
  if (bytes > rawLimit) { reasons.add(codec ? 'raw_byte_budget' : 'byte_budget'); return incompleteInventory(); }
  if (codec) {
    builder = codec.createBuilder(result);
    if (!builder) { reasons.add('byte_budget'); return incompleteInventory(); }
  }
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
      if (characters > rawLimit) { fail(local, codec ? 'raw_byte_budget' : 'byte_budget'); break; }
      attributes[attribute.name] = attribute.value;
    }
    const live: NonNullable<OwnerDependencyNode['live']> = {}, resolved: NonNullable<OwnerDependencyNode['resolved']> = {};
    const value = (text: string) => { if (text.length > rawLimit) { fail(local, codec ? 'raw_byte_budget' : 'byte_budget'); return undefined; } return text; };
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
    if (!reserve(size(node) + 1, builder && (() => builder!.addNode(node)))) {
      nodes.set(el, undefined); nodeFailures.set(el, [budgetFailure]); return;
    }
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
        if (characters > rawLimit) { fail(local, codec ? 'raw_byte_budget' : 'byte_budget'); break; }
        children.push({ text: child.textContent || '' });
      } else if (child.nodeType !== Node.COMMENT_NODE) fail(local, 'unsupported_child_node');
    }
    const updated = { ...node, children, childrenComplete: !local.size };
    if (reserve(Math.max(0, size(updated) - size(node)), builder && (() => builder!.replaceNode(nodeIndices.get(node.id)!, updated)))) Object.assign(node, updated);
    else { fail(local, budgetFailure); elements.length = 0; }
    const entry = { children: elements, reasons: [...local] }; expanded.set(el, entry); return entry;
  };
  const readReferences = (el: Element, node: OwnerDependencyNode) => {
    if (references.has(el)) return references.get(el)!;
    const local = new Set<string>(), indices: number[] = [], targets: Element[] = [];
    const add = (attribute: string, token: string, matches: Element[], lookup?: OwnerDependencyReference['lookup']) => {
      if (result.references.length >= limits.references) { fail(local, 'reference_budget'); return; }
      const status = matches.length === 1 ? 'unique' : matches.length ? 'ambiguous' : 'missing';
      // At most two matches are required to prove ambiguity; no first-match
      // inference or traversal into an arbitrarily chosen duplicate target.
      const ref: OwnerDependencyReference = { sourceId: node.id, attribute, token, status, targetIds: matches.slice(0, 2).map(instance), ...(lookup ? { lookup } : {}) };
      if (!reserve(size(ref) + 1, builder && (() => builder!.addReference(ref) !== undefined))) { fail(local, budgetFailure); return; }
      indices.push(result.references.length); result.references.push(ref);
      if (status === 'unique') targets.push(matches[0]);
      else if (status !== 'missing' || lookup?.matches !== 0) fail(local, status === 'missing' ? 'missing_idref' : 'ambiguous_idref');
    };
    for (const [attribute, raw] of Object.entries(node.attributes)) if (idrefAttributes.has(attribute)) {
      for (const token of new Set(raw.trim().split(/\s+/).filter(Boolean))) {
        // CSS.escape replaces NUL rather than representing that exact ID. Do
        // not turn an inexact query or an exception into a negative lookup.
        if (codec && token.includes('\0')) { fail(local, 'unsupported_idref_token'); continue; }
        try {
          if (!idTargets.has(token)) { const found = document.querySelectorAll(`#${CSS.escape(token)}`); idTargets.set(token, found.length > 1 ? [found[0], found[1]] : found.length ? [found[0]] : []); }
        } catch (error) {
          if (!codec) throw error;
          fail(local, 'idref_lookup_failed'); continue;
        }
        const matches = idTargets.get(token)!;
        const lookup: OwnerDependencyReference['lookup'] = codec && el.getRootNode() === document && !el.shadowRoot
          ? { scope: 'document-light-dom', documentId, matches: Math.min(2, matches.length) as 0 | 1 | 2 } : undefined;
        add(attribute, token, matches, lookup);
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
    if (reserve(size(closure) + 1, builder && (() => builder!.addClosure(closure)))) result.closures.push(closure);
    else { closure.complete = false; closure.reasons = [...new Set([...closure.reasons, budgetFailure])]; }
    // Cache failed owners too: unchanged remaining capacity cannot complete a
    // repeated request. An unretained closure is never a complete root grant.
    closures.set(owner, closure); return closure;
  };
  const selectorIds = new Set(result.selectorIds);
  const required = (control: Control) => selectorIds.has(control.localId) || ['input', 'select', 'textarea'].includes(control.tag) || control.editable;
  const order = entries.sort((a, b) => Number(required(b.control)) - Number(required(a.control)));
  const finishRoot = (root: OwnerDependencies['roots'][number] | NonNullable<OwnerDependencies['nativeRoots']>[number], closure: OwnerDependencyClosure, index: number, native: boolean) => {
    const captured = closure.nodeIds.includes(root.instanceId);
    const next = { ...root, complete: closure.complete && captured,
      reasons: [...new Set([...closure.reasons, ...(!captured ? ['target_not_captured'] : [])])].sort() };
    // If even extra diagnostic detail cannot fit, retain the already reserved
    // explicit byte-budget failure rather than discard the complete inventory.
    if (reserve(Math.max(0, size(next) - size(root)), builder && (() => native
      ? builder!.replaceNativeRoot(index, next) : builder!.replaceRoot(index, next as OwnerDependencies['roots'][number])))) Object.assign(root, next);
  };
  // Required nonlocal fields are collected before unrelated control owners can
  // consume the shared budget. Every closure still uses the same hard limits.
  for (const { owner, root, index } of nativeEntries) finishRoot(root, buildClosure(owner), index, true);
  for (const { owner, root, index } of order) finishRoot(root, buildClosure(owner), index, false);
  result.complete = [...result.roots, ...result.nativeRoots!].every(root => root.complete); result.reasons = [...reasons].sort();
  // Defensive invariant check, not the ordinary payload-exhaustion path. Shared
  // complete subtrees are cached; later ancestor-only expansion cannot alter
  // their attributes/native values/references or required closure membership.
  if (size(result) > rawLimit) { reasons.add(codec ? 'raw_byte_budget' : 'byte_budget'); return incompleteInventory(); }
  if (builder) {
    const compact = builder.finish({ inventoryComplete: result.inventoryComplete, complete: result.complete, reasons: result.reasons });
    if (compact) return compact;
    reasons.add(builder.stats().failure || 'byte_budget'); return incompleteInventory();
  }
  return result;
}
