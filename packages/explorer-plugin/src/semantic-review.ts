import { z } from 'zod';
import type { Decision } from './types.js';

/** Evidence is captured by the host. The model can reference it, never replace it. */
export interface SemanticReview {
  key:string; purpose:string; instructions:string; parent:Decision;
  options:Record<string,unknown>; evidence:Record<string,unknown>;
  requiredEvidence:Record<string,string[]>; operation?:boolean;
}
export const semanticAnswerSchema=z.object({
  choice:z.string().min(1).max(200), evidenceRefs:z.array(z.string().min(1)).max(20), reason:z.string().min(1).max(2000),
  interfaceOnly:z.boolean().nullable(), externalWrite:z.boolean().nullable(),
}).strict();
export type SemanticAnswer=z.infer<typeof semanticAnswerSchema>;

export function semanticRejection(request:SemanticReview,answer:SemanticAnswer):string|undefined {
  if(!Object.hasOwn(request.options,answer.choice))return 'semantic_choice_not_offered';
  if(answer.evidenceRefs.some(ref=>!Object.hasOwn(request.evidence,ref)))return 'semantic_evidence_unknown';
  if(answer.choice==='uncertain')return 'semantic_still_uncertain';
  const required=request.requiredEvidence[answer.choice];
  if(!required?.length||required.some(ref=>!answer.evidenceRefs.includes(ref)))return 'semantic_evidence_missing';
  if(request.operation&&(answer.interfaceOnly!==true||answer.externalWrite!==false))return 'semantic_effect_unresolved';
}
