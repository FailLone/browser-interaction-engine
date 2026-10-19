import type { ModelRequest, Provider } from './providers.js';

/** Per-provider totals for one crawl. Cost is the provider-reported `usage.cost` (USD). */
export interface ProviderMeter {
  calls: number; failures: number; judgments: number;
  inputTokens: number; outputTokens: number; costUsd: number;
  /** Calls whose response carried no cost; their spend is unknown, not zero. */
  unpricedCalls: number;
  elapsedMs: number;
  byPurpose: Record<string, { calls: number; costUsd: number }>;
}

const emptyMeter = (): ProviderMeter => ({ calls: 0, failures: 0, judgments: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedCalls: 0, elapsedMs: 0, byPurpose: {} });

/** Wraps a provider so every real HTTP decision is counted with its tokens, time and cost. */
export function metered(provider: Provider, meter: ProviderMeter = emptyMeter()): Provider & { meter: ProviderMeter } {
  return {
    name: provider.name, model: provider.model, requestBody: provider.requestBody?.bind(provider), meter,
    async decide(request: ModelRequest, signal: AbortSignal) {
      const started = Date.now();
      meter.calls++;
      const purpose = meter.byPurpose[request.purpose] ??= { calls: 0, costUsd: 0 };
      purpose.calls++;
      meter.judgments += request.kind === 'checklist' ? Object.keys(request.checks || {}).length : 1;
      try {
        const answer = await provider.decide(request, signal);
        const usage = answer.usage || {};
        meter.inputTokens += usage.input_tokens ?? usage.prompt_tokens ?? 0;
        meter.outputTokens += usage.output_tokens ?? usage.completion_tokens ?? 0;
        if (typeof usage.cost === 'number') { meter.costUsd += usage.cost; purpose.costUsd += usage.cost; }
        else meter.unpricedCalls++;
        return answer;
      } catch (error) { meter.failures++; throw error; }
      finally { meter.elapsedMs += Date.now() - started; }
    },
  };
}
