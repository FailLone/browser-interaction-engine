import type {Observation} from '@interaction/browser';
import type {FragmentMapping,TraversalFragment} from './fragment-traversal-core.js';
import type {FragmentAtom,FragmentMaterial} from './fragment-codec.js';

/** Read-only v1 interchange. IDs and directed exceptions survive migration. */
export interface FragmentTraversalLedger {
  policy:string;epoch:number;authority?:string;bounded?:true;
  revokedCandidates:Record<string,string>;
  obligations:Record<string,{scopeKey:string;authority:string;candidateIds:string[]}>;
  fragments:(TraversalFragment&{url:string;source:{sessionId:string;observationId:string;regionId:string};parentRegionId?:string})[];
  mappings:FragmentMapping[];
  events:FragmentEvent[];
  states:FragmentState[];
}
export interface FragmentRoot {storageVersion:2;policy:string;rootKey:string;epoch:number;authority?:string;legacyBounded?:true}
export interface FragmentRecord {
  id:string;lookupKey:string;structure:string;owner:string;revision:string;url:string;
  source:{sessionId:string;observationId:string;regionId:string};parentRegionId?:string;
  /** Original wire representation is solely for exact legacy audit export. */
  legacy?:{ownerEncoded:boolean};
}
export interface CandidateRecord {id:string;fragmentId:string;position:number;path:string;operation:string;guard:string;classId?:string;legacy?:{guardEncoded:boolean}}
export interface FragmentClass {id:string;key:string}
export interface FragmentEvent {id:string;fragmentId:string;candidateId:string;sessionId:string;observationId:string;afterId:string;actionId:string}
export interface FragmentState {id:string;url:string;context:string;candidateIds:string[];source:{sessionId:string;observationId:string};navigation?:Observation['navigation']}
export interface FragmentObligation {id:string;scopeKey:string;authority:string;candidateIds:string[]}
export interface FragmentEdge extends FragmentMapping {id:string}
export interface FragmentRevocation {id:string;reason:string}
export interface FragmentDelta {
  root:FragmentRoot;
  atoms:FragmentAtom[];materials:FragmentMaterial[];fragments:FragmentRecord[];candidates:CandidateRecord[];
  classes:FragmentClass[];events:FragmentEvent[];states:FragmentState[];obligations:FragmentObligation[];
  edges:FragmentEdge[];revocations:FragmentRevocation[];
}
export type FragmentRows={fragments:FragmentRecord;candidates:CandidateRecord;classes:FragmentClass;events:FragmentEvent;states:FragmentState;obligations:FragmentObligation;edges:FragmentEdge;revocations:FragmentRevocation};
export type FragmentRowKind=keyof FragmentRows;
export const fragmentRowKinds:FragmentRowKind[]=['fragments','classes','candidates','edges','events','revocations','states','obligations'];
export const fragmentRoot=(taskId:string,policy:string):FragmentRoot=>({storageVersion:2,policy,rootKey:taskId,epoch:0});
export const emptyFragmentDelta=(root:FragmentRoot):FragmentDelta=>({root,atoms:[],materials:[],fragments:[],candidates:[],classes:[],events:[],states:[],obligations:[],edges:[],revocations:[]});
