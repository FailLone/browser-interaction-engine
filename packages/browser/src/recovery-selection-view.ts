import { EngineError } from '@interaction/core';

const sameDescriptor = (a: PropertyDescriptor | undefined, b: PropertyDescriptor) => !!a
  && a.value === b.value && a.get === b.get && a.set === b.set
  && a.writable === b.writable && a.configurable === b.configurable && a.enumerable === b.enumerable;

/** Capture only SDK-owned composition objects. This does not certify an
 * arbitrary function's closed-over state; eligibility must already establish
 * that these objects were constructed from the known built-in implementation. */
export function recoverySelectionObjectGuard(objects: readonly object[]): () => boolean {
  const saved = objects.map(object => ({ object, prototype: Object.getPrototypeOf(object),
    descriptors: Reflect.ownKeys(object).map(key => [key, Object.getOwnPropertyDescriptor(object, key)!] as const) }));
  return () => saved.every(({ object, prototype, descriptors }) => Object.getPrototypeOf(object) === prototype
    && Reflect.ownKeys(object).length === descriptors.length
    && descriptors.every(([key, descriptor]) => sameDescriptor(Object.getOwnPropertyDescriptor(object, key), descriptor)));
}

/** Module-initialization prototype snapshot. Instance bindings are checked
 * separately because legitimate SDK constructor fields include functions. */
export function recoverySelectionPrototypeGuard(prototypes: readonly object[]) {
  const unchanged = recoverySelectionObjectGuard(prototypes);
  const methodKeys = new Set(prototypes.flatMap(prototype => Reflect.ownKeys(prototype)));
  return { unchanged, unshadowed: (instance: object) => Reflect.ownKeys(instance).every(key => !methodKeys.has(key)) };
}

/** Materials for one cooperative selection. A view is neither a reservation nor
 * execution, replay, coverage or arrival authority. Consumers must check the
 * view after yielding and retain the normal final/dispatch validation. The
 * proof concerns records/readers, not edits to a consumer's own materials;
 * consumers must not mutate the facts they reuse under this proof. */
export interface RecoverySelectionView<Current, Source, Anchor = never> {
  readonly current: Current;
  source(observationId: string): Source;
  readonly anchor?: (observationId: string) => Anchor;
  assertCurrent(): void;
  close(): void;
}

export interface RecoverySelectionViewReaders<Current, Source, Anchor = never> {
  /** Explicit composition proof supplied by the SDK, not inferred from a store
   * cursor. Unknown/custom readers or unversioned external policy return false.
   * It must also reject changes to the participating methods/services. */
  supported(): boolean;
  /** A complete record generation bound to the originating store instance.
   * Undefined means no cross-yield proof (including a transaction-local read). */
  recordRevision(): string | undefined;
  current(): Current;
  source(observationId: string): Source;
  anchor?(observationId: string): Anchor;
}

/** A lifetime boundary, not a generic cache. Only the initial current material
 * is retained here; callers own bounded source/projection caches and dispose
 * them with the view. No transaction, driver or persistent write is introduced.
 * The caller's proof must cover every dependency of these synchronous readers. */
export function createRecoverySelectionView<Current, Source, Anchor = never>(
  readers: RecoverySelectionViewReaders<Current, Source, Anchor>,
): RecoverySelectionView<Current, Source, Anchor> | undefined {
  const supported = readers.supported, recordRevision = readers.recordRevision;
  const currentReader = readers.current, sourceReader = readers.source, anchorReader = readers.anchor;
  const revision = () => {
    try {
      if (!supported()) return;
      const value = recordRevision();
      return typeof value === 'string' && value.length && supported() ? value : undefined;
    } catch { return; }
  };
  const initial = revision();
  if (initial === undefined) return;
  let invalid = false;
  const stale = (): never => {
    invalid = true;
    throw new EngineError('STALE_DECISION', 'Recovery selection materials are no longer current');
  };
  const assertCurrent = () => {
    if (invalid || revision() !== initial) stale();
  };
  const read = <T>(reader: () => T): T => {
    assertCurrent();
    let value: T;
    try { value = reader(); }
    catch (error) {
      // A changed generation supersedes an otherwise ordinary missing/read
      // error. Stable reader failures retain their original identity/semantics.
      assertCurrent();
      throw error;
    }
    assertCurrent();
    return value;
  };
  const current = read(currentReader);
  return Object.freeze({
    current,
    source: (observationId: string) => read(() => sourceReader(observationId)),
    ...(anchorReader ? { anchor: (observationId: string) => read(() => anchorReader(observationId)) } : {}),
    assertCurrent,
    close: () => { invalid = true; },
  });
}
