import type { DomEvidence, DomNodeEvidence, EvidenceOptions } from './evidence-types.js';
import type { Region } from './types.js';

/** Runs in the same evaluation as the control observation. Never executes page markup. */
export function collectEvidence(limits: EvidenceOptions, regions: Region[]): DomEvidence {
  const tracker = (window as any).__interactionEvidenceTracker;
  const id = (node: Node): string => {
    if (!tracker.ids.has(node)) tracker.ids.set(node, `${tracker.documentId}:${++tracker.counter}`);
    return tracker.ids.get(node);
  };
  const result: DomEvidence = {
    documentId: tracker.documentId, capturedAt: new Date().toISOString(), nodes: [], html: '', htmlTruncated: false, nodesTruncated: false, gaps: [], regionRoots: {},
    page: { url: location.href, title: document.title, baseURI: document.baseURI, language: document.documentElement?.lang || '', characterSet: document.characterSet, readyState: document.readyState, doctype: document.doctype ? new XMLSerializer().serializeToString(document.doctype) : '', activeNodeId: document.activeElement ? id(document.activeElement) : undefined, metadata: [] },
  };
  if (!document.documentElement) { result.gaps.push({ code: 'DOM_ROOT_UNAVAILABLE', message: 'No document element for detailed evidence' }); return result; }
  result.rootId = id(document.documentElement);
  for (const region of regions) { const el = document.querySelector(region.selector); if (el) result.regionRoots[region.key] = id(el); }
  const html = `${result.page.doctype}\n${document.documentElement.outerHTML}`;
  result.html = html.slice(0, limits.maxHtmlLength); result.htmlTruncated = html.length > limits.maxHtmlLength;
  if (result.htmlTruncated) result.gaps.push({ code: 'HTML_TRUNCATED', message: `HTML exceeds ${limits.maxHtmlLength} characters` });
  const stack: { node: Node; parentId?: string }[] = [{ node: document.documentElement }];
  const byId = new Map<string, DomNodeEvidence>();
  let characters = 0; let sizeLimited = false;
  const essential = ['display', 'visibility', 'opacity', 'position', 'z-index', 'pointer-events', 'overflow', 'overflow-x', 'overflow-y', 'color', 'background-color', 'font-size', 'font-weight', 'cursor', 'transform', 'direction', 'white-space'];
  while (stack.length && result.nodes.length < limits.maxNodes) {
    const { node, parentId } = stack.pop()!;
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE) continue;
    const record: DomNodeEvidence = { id: id(node), parentId, children: [], nodeType: node.nodeType === Node.TEXT_NODE ? 'text' : 'element', gaps: [] };
    const trim = (value: string, max: number, field: string) => {
      if (value.length > max) record.gaps.push({ code: 'FIELD_TRUNCATED', message: `${field} exceeds ${max} characters`, reference: record.id });
      return value.slice(0, max);
    };
    if (node.nodeType === Node.TEXT_NODE) record.text = trim(node.textContent || '', limits.maxTextLength, 'text');
    else {
      const el = node as HTMLElement;
      record.tag = el.tagName.toLowerCase(); record.attributes = {};
      for (const attr of el.attributes) record.attributes[attr.name] = trim(attr.value, limits.maxAttributeLength, `attribute:${attr.name}`);
      const r = el.getBoundingClientRect(); record.rect = { x: r.x, y: r.y, width: r.width, height: r.height };
      const style = getComputedStyle(el); record.styles = {};
      for (const key of limits.styles === 'all' ? Array.from(style) : limits.styles === 'essential' ? essential : []) record.styles[key] = trim(style.getPropertyValue(key), limits.maxAttributeLength, `style:${key}`);
      record.properties = {};
      for (const key of ['value', 'checked', 'indeterminate', 'selected', 'selectedIndex', 'disabled', 'readOnly', 'required', 'type', 'tabIndex', 'contentEditable', 'href', 'action', 'method', 'target', 'validationMessage']) {
        const value = (el as any)[key];
        if (typeof value === 'string') record.properties[key] = trim(value, limits.maxTextLength, `property:${key}`);
        else if (typeof value === 'boolean' || typeof value === 'number') record.properties[key] = value;
      }
      if ((el as HTMLInputElement).validity) {
        const validity = (el as HTMLInputElement).validity;
        record.properties.validity = Object.fromEntries(['valid', 'valueMissing', 'typeMismatch', 'patternMismatch', 'tooLong', 'tooShort', 'rangeUnderflow', 'rangeOverflow', 'stepMismatch', 'badInput', 'customError'].map(key => [key, (validity as any)[key]]));
      }
      record.relations = {};
      for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-details', 'aria-errormessage', 'for', 'list', 'popovertarget']) {
        const targets = (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean);
        if (targets.length) record.relations[attr] = targets.flatMap(target => {
          const element = document.getElementById(target);
          if (!element) { record.gaps.push({ code: 'UNRESOLVED_DOM_RELATION', message: `${attr} references missing #${target}` }); return []; }
          return [id(element)];
        });
      }
      const input = el as HTMLInputElement;
      if (input.labels?.length) record.relations.labels = Array.from(input.labels).map(id);
      if (input.form) record.relations.form = [id(input.form)];
      if (el.shadowRoot) record.gaps.push({ code: 'SHADOW_CONTENT_NOT_CAPTURED', message: 'Shadow root contents are not part of this DOM tree' });
      if (el.tagName === 'IFRAME') record.gaps.push({ code: 'FRAME_CONTENT_NOT_CAPTURED', message: 'Frame metadata is available; child document is not captured' });
    }
    const parent = parentId ? byId.get(parentId) : undefined;
    characters += JSON.stringify(record).length + (parent ? JSON.stringify(record.id).length + (parent.children.length ? 1 : 0) : 0);
    if (characters > limits.maxDomCharacters) { sizeLimited = true; break; }
    if (record.tag === 'meta') result.page.metadata.push(record.attributes!);
    result.nodes.push(record); byId.set(record.id, record);
    if (parentId) byId.get(parentId)?.children.push(record.id);
    for (let child = node.lastChild; child; child = child.previousSibling) stack.push({ node: child, parentId: record.id });
  }
  result.nodesTruncated = stack.length > 0 || sizeLimited;
  if (result.nodesTruncated) result.gaps.push({ code: 'DOM_TREE_TRUNCATED', message: `DOM exceeded its node (${limits.maxNodes}) or character (${limits.maxDomCharacters}) budget; missing children and relationship targets may be outside the captured range` });
  return result;
}
