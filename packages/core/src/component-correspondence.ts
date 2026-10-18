import type {ExplorationTargetReference} from './types.js';

/** Pair-local external evidence. A relation is neither an identity union nor a
 * receipt. The adapter must recompute all material and operation conditions. */
export interface ComponentCorrespondenceMaterial {
  policy:string;
  status:'same'|'uncertain'|'conflict'|'unavailable';
  reason:string;
  sourceMaterial?:string; targetMaterial?:string;
  conditionKey?:string;
  evidence:string[];
}
export interface ComponentCorrespondenceInput {
  observationId:string; actionId:string; source:ExplorationTargetReference;
}
export interface ExternalComponentCorrespondence {
  id:string; sessionId:string; policy:string;
  source:ExplorationTargetReference;
  sourceMaterialKey:string; targetMaterialKey:string; conditionKey:string;
  evidence:string[];
}
