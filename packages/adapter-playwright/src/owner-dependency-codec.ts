import type { CompactOwnerDependencies, OwnerDependencies, OwnerDependencyNode, OwnerDependencyReference,
  OwnerDependencyClosure, OwnerDependencyRoot, OwnerDependencyNativeRoot } from './types.js';

type Failure = 'byte_budget' | 'raw_byte_budget' | 'invalid_graph' | 'node_budget' | 'reference_budget';
type Summary = Pick<OwnerDependencies, 'inventoryComplete' | 'complete' | 'reasons'>;
export interface OwnerDependencyBuilder {
  addNode(value: OwnerDependencyNode): boolean;
  replaceNode(index: number, value: OwnerDependencyNode): boolean;
  addReference(value: OwnerDependencyReference): number | undefined;
  addClosure(value: OwnerDependencyClosure): boolean;
  replaceRoot(index: number, value: OwnerDependencyRoot): boolean;
  replaceNativeRoot(index: number, value: OwnerDependencyNativeRoot): boolean;
  finish(summary: Summary): CompactOwnerDependencies | undefined;
  stats(): { wireBytes: number; expandedBytes: number; reservedBytes: number; failure?: Failure };
}
export interface OwnerDependencyCodec {
  createBuilder(initial: OwnerDependencies): OwnerDependencyBuilder | undefined;
  encode(raw: OwnerDependencies): CompactOwnerDependencies | undefined;
  decode(snapshot: unknown): OwnerDependencies | undefined;
}

/** Self-contained so the adapter can inject this factory into one DOM evaluation.
 * No gzip, global memo, logical identity inference, or authorization is involved. */
export function createOwnerDependencyCodec(): OwnerDependencyCodec {
  const MAX = { bytes: 131072, expanded: 1048576, nodes: 512, references: 64, depth: 16,
    ids: 8192, roots: 1500, nativeRoots: 512, closures: 2012, members: 65536, statusReserve: 1024 };
  const own = (o: object, k: string) => Object.hasOwn(o, k);
  const bad = (): never => { throw new Error('invalid_graph'); };
  const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'
    && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
  const object = (v: unknown, allowed: string[], required = allowed): Record<string, any> => {
    if (!plain(v) || Object.getOwnPropertySymbols(v).length) return bad();
    for (const key of Object.getOwnPropertyNames(v)) {
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (!allowed.includes(key) || !descriptor?.enumerable || !('value' in descriptor)) return bad();
    }
    if (required.some(key => !own(v, key))) return bad();
    return v;
  };
  const list = (v: unknown, maximum: number): any[] => {
    if (!Array.isArray(v) || v.length > maximum || Object.getOwnPropertyNames(v).length !== v.length + 1 || Object.getOwnPropertySymbols(v).length) return bad();
    for (let i = 0; i < v.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(v, String(i));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return bad();
    }
    return v;
  };
  const tuple = (v: unknown, width: number) => { const a = list(v, width); if (a.length !== width) return bad(); return a; };
  const text = (v: unknown, empty = true): string => {
    if (typeof v !== 'string' || v.length > MAX.expanded || !empty && !v) return bad(); return v;
  };
  const bool = (v: unknown): boolean => typeof v === 'boolean' ? v : bad();
  const integer = (v: unknown, max: number, min = 0): number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max ? v as number : bad();
  const strings = (v: unknown, max = MAX.members, empty = true) => list(v, max).map(item => text(item, empty));
  const reasons = (v: unknown) => strings(v, 64);
  const limits = (v: unknown) => {
    const o = object(v, ['nodes', 'references', 'bytes', 'depth']);
    return { nodes: integer(o.nodes, MAX.nodes, 1), references: integer(o.references, MAX.references, 1),
      bytes: integer(o.bytes, MAX.bytes, 1), depth: integer(o.depth, MAX.depth, 1) };
  };
  // Exact JSON UTF-8 size without allocating an expanded JSON string. Work and
  // recursion are bounded even for repeated dictionary references or cycles.
  const size = (value: unknown, ceiling = MAX.expanded): number => {
    let count = 0, steps = 0; const active = new Set<object>();
    const charge = (n: number) => { count += n; if (count > ceiling) throw new Error('raw_byte_budget'); };
    const quote = (s: string) => {
      if (s.length > ceiling) throw new Error('raw_byte_budget'); charge(2);
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)) charge(2);
        else if (c < 32) charge(6);
        else if (c < 128) charge(1);
        else if (c < 2048) charge(2);
        else if (c >= 0xd800 && c <= 0xdbff) {
          const next = s.charCodeAt(i + 1);
          if (next >= 0xdc00 && next <= 0xdfff) { charge(4); i++; } else charge(6);
        } else charge(c >= 0xdc00 && c <= 0xdfff ? 6 : 3);
      }
    };
    const walk = (v: any, depth: number) => {
      if (++steps > MAX.members || depth > 16) return bad();
      if (v === null) return charge(4);
      if (typeof v === 'string') return quote(v);
      if (typeof v === 'boolean') return charge(v ? 4 : 5);
      if (typeof v === 'number') { if (!Number.isFinite(v)) return bad(); return charge(String(Object.is(v, -0) ? 0 : v).length); }
      if (!v || typeof v !== 'object' || active.has(v)) return bad();
      active.add(v); charge(2);
      if (Array.isArray(v)) {
        const a = list(v, MAX.members);
        for (let i = 0; i < a.length; i++) { if (i) charge(1); walk(a[i], depth + 1); }
      } else {
        if (!plain(v) || Object.getOwnPropertySymbols(v).length) return bad(); let count = 0;
        for (const key of Object.getOwnPropertyNames(v)) {
          const d = Object.getOwnPropertyDescriptor(v, key); if (!d?.enumerable || !('value' in d)) return bad();
          if (d.value === undefined) continue;
          if (count++) charge(1); quote(key); charge(1); walk(d.value, depth + 1);
        }
      }
      active.delete(v);
    };
    walk(value, 0); return count;
  };
  const stringMap = (v: unknown) => {
    if (!plain(v)) return bad(); const out: Record<string, string> = Object.create(null);
    size(v);
    for (const key in v) { if (typeof v[key] !== 'string') return bad(); out[key] = text(v[key]); }
    return out;
  };
  const optionalMap = (v: unknown, keys: string[], stringKeys: string[]) => {
    if (v === undefined) return null;
    const o = object(v, keys, []), out: Record<string, string | boolean> = {};
    for (const key of keys) if (o[key] !== undefined) out[key] = stringKeys.includes(key) ? text(o[key]) : bool(o[key]);
    return out;
  };
  const header = (v: unknown, compact: boolean) => {
    const names = ['version', 'documentId', 'baseURI', 'inventoryComplete', 'complete', 'reasons', 'limits', 'selectorIds', 'nativeInputIds',
      'nodes', 'roots', 'nativeRoots', 'closures', 'references', 'ancestry', ...(compact ? ['semanticVersion', 'ids'] : [])];
    const o = object(v, names, names.filter(k => k !== 'ancestry'));
    if (o.version !== (compact ? 'browser-owner-dependencies-v3' : 'browser-owner-dependencies-v2') || compact && o.semanticVersion !== 2
      || o.ancestry !== undefined && o.ancestry !== 'node-bounded-v1') return bad();
    return { version: 'browser-owner-dependencies-v2' as const, documentId: text(o.documentId, false), baseURI: text(o.baseURI),
      inventoryComplete: bool(o.inventoryComplete), complete: bool(o.complete), reasons: reasons(o.reasons), limits: limits(o.limits),
      ...(o.ancestry !== undefined ? { ancestry: o.ancestry as 'node-bounded-v1' } : {}) };
  };
  const summary = (v: unknown): Summary => {
    const o = object(v, ['inventoryComplete', 'complete', 'reasons']);
    return { inventoryComplete: bool(o.inventoryComplete), complete: bool(o.complete), reasons: reasons(o.reasons) };
  };
  const rawNode = (v: unknown, id: (value: string, empty?: boolean) => number): CompactOwnerDependencies['nodes'][number] => {
    const o = object(v, ['id', 'parentId', 'tag', 'attributes', 'childrenComplete', 'children', 'live', 'resolved', 'associations', 'complete', 'reasons'],
      ['id', 'parentId', 'tag', 'attributes', 'childrenComplete', 'complete', 'reasons']);
    const children = o.children === undefined ? null : list(o.children, MAX.nodes * 2).map(child => {
      if (!plain(child) || Object.keys(child).length !== 1) return bad();
      if (own(child, 'nodeId')) return id(text(object(child, ['nodeId']).nodeId, false));
      return text(object(child, ['text']).text);
    });
    let associations: [number | null, number[] | null] | null = null;
    if (o.associations !== undefined) {
      const a = object(o.associations, ['formId', 'labelIds'], []);
      associations = [a.formId === undefined ? null : id(text(a.formId), true), a.labelIds === undefined ? null : strings(a.labelIds, MAX.references, false).map(value => id(value))];
    }
    return [id(text(o.id, false)), id(text(o.parentId), true), text(o.tag, false), stringMap(o.attributes), bool(o.childrenComplete), children,
      optionalMap(o.live, ['value', 'checked', 'indeterminate', 'selected', 'disabled', 'readOnly', 'multiple'], ['value']),
      optionalMap(o.resolved, ['href', 'src', 'action', 'formAction'], ['href', 'src', 'action', 'formAction']), associations, bool(o.complete), reasons(o.reasons)];
  };
  const rawRoot = (v: unknown, id: (value: string) => number, native: boolean): number[] | any[] => {
    const keys = [...(native ? [] : ['localId']), 'instanceId', 'ownerId', 'closureId', 'complete', 'reasons'], o = object(v, keys);
    return [...keys.filter(k => k !== 'complete' && k !== 'reasons').map(k => id(text(o[k], false))), bool(o.complete), reasons(o.reasons)];
  };
  const rawReference = (v: unknown, id: (value: string) => number): CompactOwnerDependencies['references'][number] => {
    const o = object(v, ['sourceId', 'attribute', 'token', 'status', 'targetIds', 'lookup'], ['sourceId', 'attribute', 'token', 'status', 'targetIds']);
    const status = ['unique', 'missing', 'ambiguous'].indexOf(o.status); if (status < 0) return bad();
    const row: CompactOwnerDependencies['references'][number] = [id(text(o.sourceId, false)), text(o.attribute, false), text(o.token), status as 0 | 1 | 2,
      strings(o.targetIds, 2, false).map(value => id(value))];
    if (o.lookup !== undefined) {
      const lookup = object(o.lookup, ['scope', 'documentId', 'matches']); if (lookup.scope !== 'document-light-dom') return bad();
      row.push([id(text(lookup.documentId, false)), integer(lookup.matches, 2)]);
    }
    return row;
  };
  const rawClosure = (v: unknown, id: (value: string) => number, refCount: number): CompactOwnerDependencies['closures'][number] => {
    const o = object(v, ['id', 'subtreeId', 'nodeIds', 'referenceIds', 'subtreeIds', 'complete', 'reasons']);
    return [id(text(o.id, false)), id(text(o.subtreeId, false)), strings(o.nodeIds, MAX.nodes, false).map(value => id(value)),
      list(o.referenceIds, MAX.references).map(value => integer(value, refCount - 1)), strings(o.subtreeIds, MAX.nodes + MAX.references + 1, false).map(value => id(value)),
      bool(o.complete), reasons(o.reasons)];
  };

  const createBuilder = (initial: OwnerDependencies): OwnerDependencyBuilder | undefined => {
    try {
      const h = header(initial, false); size(initial);
      if (list(initial.nodes, 0).length || list(initial.references, 0).length || list(initial.closures, 0).length) return;
      const selectors = strings(initial.selectorIds, MAX.roots, false), natives = strings(initial.nativeInputIds, h.limits.nodes, false);
      const ids: string[] = [], idsByValue = new Map<string, number>();
      const intern = (value: string, empty = false) => {
        if (empty && value === '') return -1;
        text(value, false); const prior = idsByValue.get(value); if (prior !== undefined) return prior;
        if (ids.length >= MAX.ids) return bad(); const index = ids.length; ids.push(value); idsByValue.set(value, index); return index;
      };
      const graph: CompactOwnerDependencies = { ...h, version: 'browser-owner-dependencies-v3', semanticVersion: 2, ids,
        selectorIds: selectors.map(value => intern(value)), nativeInputIds: natives.map(value => intern(value)),
        nodes: [], roots: [], nativeRoots: [], closures: [], references: [] };
      const roots = list(initial.roots, MAX.roots), nativeRoots = list(initial.nativeRoots, h.limits.nodes);
      graph.roots = roots.map(root => rawRoot(root, intern, false) as CompactOwnerDependencies['roots'][number]);
      graph.nativeRoots = nativeRoots.map(root => rawRoot(root, intern, true) as CompactOwnerDependencies['nativeRoots'][number]);
      if (new Set(roots.map(root => root.localId)).size !== roots.length || new Set(nativeRoots.map(root => root.instanceId)).size !== nativeRoots.length
        || new Set(selectors).size !== selectors.length || new Set(natives).size !== natives.length) return;
      let wireBytes = size(graph), expandedBytes = size(initial), failure: Failure | undefined;
      if (wireBytes + MAX.statusReserve > h.limits.bytes || expandedBytes + MAX.statusReserve > MAX.expanded) return;
      const rowSizes: Record<string, number[]> = { nodes: [], references: [], closures: [], roots: roots.map(root => size(root)), nativeRoots: nativeRoots.map(root => size(root)) };
      const seenNodes = new Set<string>(), seenClosures = new Set<string>();
      const transact = (table: 'nodes' | 'references' | 'closures' | 'roots' | 'nativeRoots', value: any, replace?: number): boolean => {
        try {
          const rows = graph[table] as any[], maximum = table === 'nodes' ? h.limits.nodes : table === 'references' ? h.limits.references
            : table === 'roots' ? MAX.roots : table === 'nativeRoots' ? h.limits.nodes : MAX.closures;
          if (replace === undefined && rows.length >= maximum) { failure = table === 'nodes' ? 'node_budget' : table === 'references' ? 'reference_budget' : 'invalid_graph'; return false; }
          if (replace !== undefined) integer(replace, rows.length - 1);
          const rawBytes = size(value), added: string[] = [], staged = new Map<string, number>();
          const id = (value: string, empty = false) => {
            if (empty && value === '') return -1; text(value, false);
            const old = idsByValue.get(value) ?? staged.get(value); if (old !== undefined) return old;
            if (ids.length + added.length >= MAX.ids) return bad();
            const next = ids.length + added.length; staged.set(value, next); added.push(value); return next;
          };
          const row = table === 'nodes' ? rawNode(value, id) : table === 'references' ? rawReference(value, id)
            : table === 'closures' ? rawClosure(value, id, graph.references.length) : rawRoot(value, id, table === 'nativeRoots');
          if (table === 'nodes' || table === 'closures') {
            const seen = table === 'nodes' ? seenNodes : seenClosures;
            if (replace === undefined ? seen.has(value.id) : rows[replace][0] !== id(value.id)) return bad();
          } else if (replace !== undefined && rows[replace][0] !== row[0]) return bad();
          const dictionaryBytes = added.reduce((total, value, index) => total + size(value) + (ids.length + index ? 1 : 0), 0);
          const wireDelta = size(row) - (replace === undefined ? -(rows.length ? 1 : 0) : size(rows[replace]));
          const rawDelta = rawBytes - (replace === undefined ? -(rows.length ? 1 : 0) : rowSizes[table][replace]);
          if (wireBytes + dictionaryBytes + wireDelta + MAX.statusReserve > h.limits.bytes) { failure = 'byte_budget'; return false; }
          if (expandedBytes + rawDelta + MAX.statusReserve > MAX.expanded) { failure = 'raw_byte_budget'; return false; }
          for (const value of added) { idsByValue.set(value, ids.length); ids.push(value); }
          if (replace === undefined) { rows.push(row); rowSizes[table].push(rawBytes); }
          else { rows[replace] = row; rowSizes[table][replace] = rawBytes; }
          if (table === 'nodes') seenNodes.add(value.id); if (table === 'closures') seenClosures.add(value.id);
          wireBytes += dictionaryBytes + wireDelta; expandedBytes += rawDelta; failure = undefined; return true;
        } catch (error) { failure = error instanceof Error && error.message === 'raw_byte_budget' ? 'raw_byte_budget' : 'invalid_graph'; return false; }
      };
      return {
        addNode: value => transact('nodes', value), replaceNode: (index, value) => transact('nodes', value, index),
        addReference: value => { const index = graph.references.length; return transact('references', value) ? index : undefined; },
        addClosure: value => transact('closures', value), replaceRoot: (index, value) => transact('roots', value, index),
        replaceNativeRoot: (index, value) => transact('nativeRoots', value, index),
        finish: value => {
          try {
            const next = summary(value), before = { inventoryComplete: graph.inventoryComplete, complete: graph.complete, reasons: graph.reasons };
            const delta = size(next) - size(before);
            if (wireBytes + delta > h.limits.bytes) { failure = 'byte_budget'; return; }
            if (expandedBytes + delta > MAX.expanded) { failure = 'raw_byte_budget'; return; }
            const output = { ...graph, ...next };
            if (size(output, h.limits.bytes) !== wireBytes + delta) return bad();
            return JSON.parse(JSON.stringify(output)) as CompactOwnerDependencies;
          } catch (error) { failure = error instanceof Error && error.message === 'raw_byte_budget' ? 'raw_byte_budget' : 'invalid_graph'; return; }
        },
        stats: () => ({ wireBytes, expandedBytes, reservedBytes: MAX.statusReserve, ...(failure ? { failure } : {}) }),
      };
    } catch { return; }
  };

  const decode = (snapshot: unknown): OwnerDependencies | undefined => {
    try {
      const h = header(snapshot, true), g = snapshot as CompactOwnerDependencies;
      size(g, h.limits.bytes);
      const ids = strings(g.ids, MAX.ids, false); if (new Set(ids).size !== ids.length) return;
      const id = (index: unknown, empty = false) => empty && index === -1 ? '' : ids[integer(index, ids.length - 1)];
      const idList = (v: unknown, max: number) => list(v, max).map(value => id(value));
      const raw: OwnerDependencies = { ...h, selectorIds: idList(g.selectorIds, MAX.roots), nativeInputIds: idList(g.nativeInputIds, h.limits.nodes),
        nodes: [], roots: [], nativeRoots: [], closures: [], references: [] };
      let expanded = size(raw); const rawAdd = (table: 'nodes' | 'roots' | 'nativeRoots' | 'closures' | 'references', value: any) => {
        const rows = raw[table] as any[]; expanded += size(value, MAX.expanded - expanded) + (rows.length ? 1 : 0);
        if (expanded > MAX.expanded) return bad(); rows.push(value);
      };
      for (const value of list(g.nodes, h.limits.nodes)) {
        const row = tuple(value, 11), association = row[8] === null ? undefined : tuple(row[8], 2);
        const live = row[6] === null ? undefined : optionalMap(row[6], ['value', 'checked', 'indeterminate', 'selected', 'disabled', 'readOnly', 'multiple'], ['value']);
        const resolved = row[7] === null ? undefined : optionalMap(row[7], ['href', 'src', 'action', 'formAction'], ['href', 'src', 'action', 'formAction']);
        rawAdd('nodes', { id: id(row[0]), parentId: id(row[1], true), tag: text(row[2], false), attributes: stringMap(row[3]), childrenComplete: bool(row[4]),
          ...(row[5] === null ? {} : { children: list(row[5], h.limits.nodes * 2).map(child => typeof child === 'string' ? { text: child } : { nodeId: id(child) }) }),
          ...(live !== undefined ? { live } : {}), ...(resolved !== undefined ? { resolved } : {}),
          ...(association ? { associations: { ...(association[0] === null ? {} : { formId: id(association[0], true) }),
            ...(association[1] === null ? {} : { labelIds: idList(association[1], h.limits.references) }) } } : {}),
          complete: bool(row[9]), reasons: reasons(row[10]) });
      }
      for (const value of list(g.roots, MAX.roots)) {
        const row = tuple(value, 6); rawAdd('roots', { localId: id(row[0]), instanceId: id(row[1]), ownerId: id(row[2]), closureId: id(row[3]), complete: bool(row[4]), reasons: reasons(row[5]) });
      }
      for (const value of list(g.nativeRoots, h.limits.nodes)) {
        const row = tuple(value, 5); rawAdd('nativeRoots', { instanceId: id(row[0]), ownerId: id(row[1]), closureId: id(row[2]), complete: bool(row[3]), reasons: reasons(row[4]) });
      }
      for (const value of list(g.references, h.limits.references)) {
        const row = list(value, 6); if (row.length !== 5 && row.length !== 6) return bad();
        const lookup = row.length === 6 ? tuple(row[5], 2) : undefined;
        rawAdd('references', { sourceId: id(row[0]), attribute: text(row[1], false), token: text(row[2]), status: ['unique', 'missing', 'ambiguous'][integer(row[3], 2)],
          targetIds: idList(row[4], 2), ...(lookup ? { lookup: { scope: 'document-light-dom', documentId: id(lookup[0]), matches: integer(lookup[1], 2) } } : {}) });
      }
      for (const value of list(g.closures, MAX.closures)) {
        const row = tuple(value, 7); rawAdd('closures', { id: id(row[0]), subtreeId: id(row[1]), nodeIds: idList(row[2], h.limits.nodes),
          referenceIds: list(row[3], h.limits.references).map(value => integer(value, raw.references.length - 1)), subtreeIds: idList(row[4], MAX.nodes + MAX.references + 1),
          complete: bool(row[5]), reasons: reasons(row[6]) });
      }
      if (new Set(raw.nodes.map(node => node.id)).size !== raw.nodes.length || new Set(raw.roots.map(root => root.localId)).size !== raw.roots.length
        || new Set(raw.nativeRoots!.map(root => root.instanceId)).size !== raw.nativeRoots!.length || new Set(raw.closures.map(closure => closure.id)).size !== raw.closures.length
        || new Set(raw.selectorIds).size !== raw.selectorIds.length || new Set(raw.nativeInputIds).size !== raw.nativeInputIds!.length) return;
      if (size(raw) !== expanded) return bad();
      return raw;
    } catch { return; }
  };
  const encode = (raw: OwnerDependencies): CompactOwnerDependencies | undefined => {
    try {
      header(raw, false); size(raw);
      list(raw.nodes, raw.limits.nodes); list(raw.references, raw.limits.references); list(raw.closures, MAX.closures);
      const builder = createBuilder({ ...raw, nodes: [], references: [], closures: [] }); if (!builder) return;
      for (const node of raw.nodes) if (!builder.addNode(node)) return;
      for (const reference of raw.references) if (builder.addReference(reference) === undefined) return;
      for (const closure of raw.closures) if (!builder.addClosure(closure)) return;
      return builder.finish({ inventoryComplete: raw.inventoryComplete, complete: raw.complete, reasons: raw.reasons });
    } catch { return; }
  };
  return { createBuilder, encode, decode };
}
