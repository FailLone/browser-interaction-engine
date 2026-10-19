/** Types of the page capture the crawler reads. */
export type ID = string;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ActionKind = string;
export interface Gap { code: string; message: string; reference?: string; selector?: string; critical?: boolean }
/** Evidence supporting an operation, independent of its availability or observed effect. */
export interface ActionEvidence { source: string; rule: string; facts: Record<string, Json> }
export interface ActionBasis { status: 'supported' | 'tentative'; evidence: ActionEvidence[] }
export interface ComponentMember { localId: ID; role: string; name?: string; value?: Json; selected?: boolean }
export interface InteractionComponent { id: ID; kind: string; name: string; parentId?: ID; members: ComponentMember[]; basis: ActionBasis }
export interface Rect { x: number; y: number; width: number; height: number }
export interface Region { key: string; instanceId?: string; label: string; role: string; selector: string; parentKey?: string; rect: Rect; text: string }
export interface Overlay { key: string; name: string; kind: 'modal' | 'dialog' | 'popover' | 'menu' | 'listbox'; selector: string; parentKey?: string; parentRegion: string; evidence: string[]; controlIds: string[]; exitControlIds: string[] }
export interface BrowserComponent extends InteractionComponent { rootNodeId: string; rect: Rect }
export interface ScrollContainer {
  nodeId: string; selector: string; name: string; root: boolean; boundaryKey?: string;
  left: number; top: number; maxLeft: number; maxTop: number; width: number; height: number;
}
export interface Control {
  /** Structural header/navigation containment, not a page label or logical identity. */
  landmark?:'banner'|'navigation';
  /** Current document ancestry for dependency checks, never portable identity. */
  domAncestry?:{documentId:string;instanceIds:string[];complete:boolean};
  /** Actual native HTML readOnly property. Missing in legacy observations;
   * aria-readonly alone never proves a noneditable native output. */
  nativeReadOnly?: boolean;
  localId: ID; instanceId: ID;
  identityContext?: { scope?: string; binding?: string; evidence: string[] };
  tag: string; role: string; name: string; label: string; stableKey?: string;
  region: string; regionInstanceId?: string; form: string; selector: string; rect: Rect;
  /** Comparison-only projection. Original names/text and all snapshots remain intact. */
  liveContent?: { name: string; text: string; evidence: ActionEvidence[] };
  /** Native form ownership, including fields associated through the form attribute. */
  formOwner?: { key: string; instanceId: string; action: string; method: string; target: string; isolated: boolean };
  /** Capture can be complete for independent operations while this target remains unsettled. */
  readiness?: { status: 'unstable'; reason: string };
  value: string; displayedText: string; checked: boolean | null; selected: string[];
  visible: boolean; enabled: boolean; editable: boolean; readOnly?: boolean;
  pressed?: boolean | 'mixed' | null;
  expanded: boolean | null; controls: string | null;
  constraints: { type: string; required: boolean; min?: string; max?: string; step?: string; pattern?: string; minLength?: number; maxLength?: number; valid: boolean };
  options: { value: string; label: string; disabled: boolean }[];
  actions: ActionKind[]; discovery: string[];
  /** Native element scroll viewport; document scrolling is recorded separately. */
  scroll?: { x: number; y: number; maxX: number; maxY: number; width: number; height: number };
  /** Keyed by action kind. Optional only for observations written by older adapters. */
  actionBasis?: Record<ActionKind, ActionBasis>;
  interactionHints?: ActionEvidence[];
  /** Observed semantic list owner. Similarity is a scheduling hint, not shared business behavior. */
  list?: { instanceId: string; role: string; label: string; selector: string };
  /** Dispatch-related DOM facts used to bound an external purpose judgment. */
  purposeBinding?: { attributes: Record<string, string>; runtimeEvents?: ActionEvidence[]; form?: { instanceId: string; action: string; method: string; target: string } };
  /** Exact control-review binding, independent of list-purpose similarity. */
  reviewBinding?: { parentInstanceId: string; attributes: Record<string, string>; runtimeEvents?: ActionEvidence[]; form?: { instanceId: string; action: string; method: string; target: string } };
  /** Conservative structural evidence for explicitly reusing a purpose in a new document. */
  reviewReuseBinding?: { ancestors: { tag: string; selector: string; attributes: Record<string, string>; label: string }[] };
  /** Bounded subtree evidence for classifying weak candidates; truncation prevents negative classification. */
  classificationBinding?: { nodes: { instanceId: string; parentInstanceId: string; tag: string; attributes: Record<string, string> }[]; text: string; truncated: boolean;
    /** Captured IDREF targets. Missing targets are explicit facts, not omitted evidence. */
    references?: {id:string;missing?:true;ambiguous?:true;targetInstanceId?:string;target?:{nodes:{instanceId:string;parentInstanceId:string;tag:string;attributes:Record<string,string>}[];text:string;truncated:boolean}}[] };
  structuralItem?: { ownerInstanceId:string; template:string; slot:string; rowInstanceId:string; recordKey?:string; recordEvidence?:ActionEvidence[] };
  /** Page-declared binding attributes, separate from generated identity metadata. */
  reviewAttributes?: Record<string, string>;
  actionable: { visible: boolean; enabled: boolean; editable: boolean; hitTarget: boolean | null; clickPoint?: { x: number; y: number }; occludedBy?: string; outsideScrollableArea?: boolean; unknown: string[] };
}
export interface StructuralListCandidate {
  ownerInstanceId:string; ownerSelector:string; label:string; template:string; binding:Json;
  members:{localId:string;rowInstanceId:string;slot:string;recordKey?:string;recordEvidence?:ActionEvidence[]}[];
  traversalLocalIds:string[]; evidence:ActionEvidence[];
}
export interface DiscoveryOmission {
  kind: 'template_nodes' | 'template_depth' | 'row_window' | 'collections';
  ownerId: string; ownerSelector: string; rowId?: string; rowSelector?: string;
  limit: number; observed: number;
}
export * from './evidence-types.js';
