import type { InteractionClient } from '@interaction/client';
import type { Intervention, InterventionMaterial, InterventionResponseInput } from '@interaction/browser';

/** A caller-owned human/LLM integration point. No model calls belong in the engine. */
export interface InterventionReviewer {
  decide(item: Intervention, material: InterventionMaterial): Promise<InterventionResponseInput['command'] | undefined>;
}

/** One bounded review pass, outside engine hooks and outside the command queue.
 * Returning undefined leaves a request unresolved. Conditions changing while a
 * slow reviewer works produces a rejected record, not a silently patched answer.
 * Consumers can persist their event cursor and repeat on interventions.updated. */
export async function reviewInterventions(client: InteractionClient, sessionId: string, reviewer: InterventionReviewer, maxResponses = 50) {
  if (!Number.isInteger(maxResponses) || maxResponses < 1 || maxResponses > 1000) throw new Error('Choose a finite review budget between 1 and 1000');
  const visited = new Set<string>();
  const responses: Awaited<ReturnType<InteractionClient['respondToIntervention']>>['response'][] = [];
  let material = await client.interventionMaterial(sessionId);
  for (let n = 0; n < maxResponses; n++) {
    const item = material.items.find(i => material.readyIds.includes(i.id) && !visited.has(i.id));
    if (!item) break;
    visited.add(item.id);
    const command = await reviewer.decide(item, material);
    if (!command) continue;
    const result = await client.respondToIntervention(sessionId, { requestId: crypto.randomUUID(), interventionId: item.id, conditionKey: item.conditionKey, command });
    responses.push(result.response); material = result.material;
    if (result.response.status !== 'applied') return { responses, material, continuation: undefined };
  }
  // Fresh continuation never answers remaining requests or resets the budget.
  const current = await client.interventionMaterial(sessionId);
  const result = await client.continueExploration(sessionId, { requestId: crypto.randomUUID(), observationId: current.observationId,
    source: 'external-intervention-example', evidence: ['Review pass finished; verify current scene and continue independently approved work'] });
  return { responses, material: result.material, continuation: result.continuation };
}
