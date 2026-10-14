import type { Command, ActionCandidate, ActionAttempt, BrowserDiffDetails, Checkpoint, EngineEvent, Graph, Observation, Session, SessionOptions } from '@interaction/browser';
export class InteractionClient {
  constructor(public baseUrl = 'http://127.0.0.1:4173') {}
  async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error?.message || response.statusText), result.error || {}); return result as T;
  }
  sessions() { return this.request<Session[]>('/sessions'); }
  createSession(options: Pick<SessionOptions, 'url'> & Partial<SessionOptions>) { return this.request<Session>('/sessions', options); }
  session(id: string) { return this.request<Session>(`/sessions/${id}`); }
  observe(id: string) { return this.command<Observation>(id, { type: 'observe' }); }
  observation(id: string, observationId?: string) { return this.request<Observation>(`/sessions/${id}/observation${observationId ? `?id=${observationId}` : ''}`); }
  actions(id: string) { return this.request<ActionCandidate[]>(`/sessions/${id}/actions`); }
  graph(id: string) { return this.request<Graph>(`/sessions/${id}/graph`); }
  diffDetails(id: string, beforeId: string, afterId: string, region?: string) {
    const query = new URLSearchParams({ before: beforeId, after: afterId }); if (region !== undefined) query.set('region', region);
    return this.request<BrowserDiffDetails>(`/sessions/${encodeURIComponent(id)}/compare/details?${query}`);
  }
  attemptDiffDetails(id: string, attemptId: string) { return this.request<BrowserDiffDetails>(`/sessions/${encodeURIComponent(id)}/attempts/${encodeURIComponent(attemptId)}/diff/details`); }
  eventDiffDetails(id: string, sequence: number) { return this.request<BrowserDiffDetails>(`/sessions/${encodeURIComponent(id)}/events/${sequence}/diff/details`); }
  scopeDiffDetails(id: string, scopeId: string) { return this.request<BrowserDiffDetails>(`/sessions/${encodeURIComponent(id)}/scopes/${encodeURIComponent(scopeId)}/diff/details`); }
  list<T>(id: string, resource: string, options: { offset?: number; limit?: number; status?: string } = {}) { return this.request<{ items: T[]; total: number }>(`/sessions/${id}/${resource}?${new URLSearchParams(Object.entries(options).map(([k, v]) => [k, String(v)]))}`); }
  execute(id: string, actionId: string, requestId: string, value?: Extract<Command, { type: 'execute' }>['value']) { return this.command<ActionAttempt>(id, { type: 'execute', actionId, requestId, value }); }
  checkpoint(id: string, name: string) { return this.command<Checkpoint>(id, { type: 'createCheckpoint', name, predicates: [], acceptable: [] }); }
  command<T = unknown>(id: string, command: Command) { return this.request<T>(`/sessions/${id}/commands`, command); }
  async *events(id: string, after = 0, signal?: AbortSignal): AsyncGenerator<EngineEvent> {
    let cursor = after;
    while (!signal?.aborted) {
      let response: Response;
      try { response = await fetch(`${this.baseUrl}/v1/sessions/${id}/events?after=${cursor}`, { signal }); }
      catch (error) { if (signal?.aborted) return; await new Promise(r => setTimeout(r, 500)); continue; }
      if (!response.ok || !response.body) throw new Error(`Event stream failed: ${response.status}`);
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      try {
        while (!signal?.aborted) {
          const { done, value } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = frame.split('\n').find(line => line.startsWith('data: '));
            if (data) { const event = JSON.parse(data.slice(6)) as EngineEvent; if (event.sequence > cursor) { cursor = event.sequence; yield event; } }
          }
        }
      } catch (error) { if (signal?.aborted) return; }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (!signal?.aborted) await new Promise(r => setTimeout(r, 500));
    }
  }
}
