import Database from 'better-sqlite3';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { type ModelRequest, type Provider, type Providers, safeError } from '@interaction/crawler';

/** One JEV/LLM call as the debug page lists it; input and output are loaded separately. */
export interface ModelCallSummary {
  id: number;
  /** Milliseconds since the run started, like crawl event `at`. */
  at: number;
  ms: number;
  provider: 'jev' | 'llm';
  model: string;
  purpose: string;
  kind: string;
  /** Questions answered in this call (a JEV checklist batches several). */
  items: number;
  /** What was asked about, in a few words. */
  subject: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}
export interface ModelCall extends ModelCallSummary {
  request: Pick<ModelRequest, 'instructions' | 'state' | 'checks' | 'options'>;
  answer?: { value: unknown; probability?: number; confidence?: number; probabilities?: Record<string, number> };
}

/**
 * Records every JEV/LLM call of a crawl, for the debug page: why it was asked, what was sent,
 * what came back, cost and time. Lives in its own file so the crawl store is unchanged. Calls are
 * attributed to runs through async context, so the crawler needs no hook for it.
 */
export class ModelCallLog {
  private readonly db: Database.Database;
  private readonly context = new AsyncLocalStorage<{ runId?: string; started: number }>();
  private readonly pruneTimer?: NodeJS.Timeout;
  /** `retentionDays`: calls older than this are deleted at start and daily after (default 30; 0 keeps all). */
  constructor(
    file: string,
    private readonly options: { retentionDays?: number } = {},
  ) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_calls(id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, at INTEGER NOT NULL, ms INTEGER NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, purpose TEXT NOT NULL, kind TEXT NOT NULL, items INTEGER NOT NULL,
        subject TEXT NOT NULL, cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER, error TEXT, body BLOB NOT NULL,
        recorded_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS model_calls_run ON model_calls(run_id, id);
      CREATE INDEX IF NOT EXISTS model_calls_recorded ON model_calls(recorded_at);`);
    if ((options.retentionDays ?? 30) > 0) {
      this.prune();
      this.pruneTimer = setInterval(() => this.prune(), 86_400_000).unref();
    }
  }

  /** Deletes calls recorded before the retention window; returns how many. */
  prune(now = Date.now()): number {
    const days = this.options.retentionDays ?? 30;
    if (days <= 0) return 0;
    const deleted = this.db
      .prepare('DELETE FROM model_calls WHERE recorded_at < ?')
      .run(now - days * 86_400_000).changes;
    // Give the space back to the file system, not just to SQLite's free list.
    if (deleted) this.db.exec('VACUUM');
    return deleted;
  }

  /** Starts a crawl so that model calls made on its behalf are recorded under its id. */
  track<T extends { id: string }>(start: () => T): T {
    const scope = { started: Date.now() } as { runId?: string; started: number };
    return this.context.run(scope, () => {
      const run = start();
      scope.runId = run.id;
      return run;
    });
  }

  wrap(providers: Providers): Providers {
    return {
      ...(providers.jev ? { jev: this.wrapOne(providers.jev, 'jev') } : {}),
      ...(providers.llm ? { llm: this.wrapOne(providers.llm, 'llm') } : {}),
    };
  }

  private wrapOne(provider: Provider, role: 'jev' | 'llm'): Provider {
    return {
      name: provider.name,
      model: provider.model,
      requestBody: provider.requestBody?.bind(provider),
      decide: async (request, signal) => {
        const scope = this.context.getStore(),
          began = Date.now();
        let answer: Awaited<ReturnType<Provider['decide']>> | undefined, error: unknown;
        try {
          return (answer = await provider.decide(request, signal));
        } catch (e) {
          error = e;
          throw e;
        } finally {
          if (scope?.runId) this.record(scope.runId, scope.started, began, role, provider, request, answer, error);
        }
      },
    };
  }

  private record(
    runId: string,
    started: number,
    began: number,
    role: 'jev' | 'llm',
    provider: Provider,
    request: ModelRequest,
    answer: Awaited<ReturnType<Provider['decide']>> | undefined,
    error: unknown,
  ) {
    const usage = answer?.usage ?? {};
    const body = {
      request: {
        instructions: request.instructions,
        state: request.state,
        checks: request.checks,
        options: request.options,
      },
      ...(answer
        ? {
            answer: {
              value: answer.value,
              probability: answer.probability,
              confidence: answer.confidence,
              probabilities: answer.probabilities,
            },
          }
        : {}),
    };
    try {
      this.db
        .prepare(
          `INSERT INTO model_calls(run_id,at,ms,provider,model,purpose,kind,items,subject,cost_usd,input_tokens,output_tokens,error,body,recorded_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          runId,
          began - started,
          Date.now() - began,
          role,
          answer?.model ?? provider.model,
          purposeOf(request),
          request.kind,
          request.kind === 'checklist' ? Object.keys(request.checks ?? {}).length : 1,
          subjectOf(request).slice(0, 200),
          typeof usage.cost === 'number' ? usage.cost : null,
          usage.input_tokens ?? usage.prompt_tokens ?? null,
          usage.output_tokens ?? usage.completion_tokens ?? null,
          error === undefined ? null : safeError(error),
          deflateSync(JSON.stringify(body)),
          began,
        );
    } catch {
      /* Debug records never break a crawl. */
    }
  }

  calls(runId: string): ModelCallSummary[] {
    return (
      this.db
        .prepare(
          'SELECT id,at,ms,provider,model,purpose,kind,items,subject,cost_usd,input_tokens,output_tokens,error FROM model_calls WHERE run_id=? ORDER BY id',
        )
        .all(runId) as Record<string, unknown>[]
    ).map(decode);
  }

  call(runId: string, id: number): ModelCall | undefined {
    const row = this.db.prepare('SELECT * FROM model_calls WHERE run_id=? AND id=?').get(runId, id) as
      | (Record<string, unknown> & { body: Buffer })
      | undefined;
    return row && { ...decode(row), ...JSON.parse(inflateSync(row.body).toString()) };
  }

  close() {
    clearInterval(this.pruneTimer);
    this.db.close();
  }
}

function decode(row: Record<string, unknown>): ModelCallSummary {
  return {
    id: row.id as number,
    at: row.at as number,
    ms: row.ms as number,
    provider: row.provider as 'jev' | 'llm',
    model: row.model as string,
    purpose: row.purpose as string,
    kind: row.kind as string,
    items: row.items as number,
    subject: row.subject as string,
    ...(row.cost_usd !== null ? { costUsd: row.cost_usd as number } : {}),
    ...(row.input_tokens !== null ? { inputTokens: row.input_tokens as number } : {}),
    ...(row.output_tokens !== null ? { outputTokens: row.output_tokens as number } : {}),
    ...(row.error !== null ? { error: row.error as string } : {}),
  };
}

/** A JEV batch can mix question kinds; its purpose names the first, so list them all. */
function purposeOf(request: ModelRequest) {
  if (request.kind !== 'checklist' || !request.state || typeof request.state !== 'object') return request.purpose;
  const kinds = [
    ...new Set(
      Object.values(request.state as Record<string, { kind?: unknown }>).flatMap(q =>
        typeof q?.kind === 'string' ? [q.kind] : [],
      ),
    ),
  ];
  return kinds.length ? `crawler-${kinds.join('+')}` : request.purpose;
}

/** The names of what a request asks about: controls, actions, list members, input fields. */
function subjectOf(request: ModelRequest): string {
  const name = (q: unknown): string => {
    const v = q as Record<string, any> | undefined;
    if (!v || typeof v !== 'object') return '';
    if (v.control) return v.control.name || v.control.text || v.control.tag || '';
    if (v.action) return v.action;
    if (v.members) return v.members.slice(0, 3).join(' / ');
    if (v.field) return v.field.placeholder || v.field.name || v.field.type || '';
    return '';
  };
  if (request.kind === 'checklist') {
    const state = request.state as Record<string, unknown>;
    const names = Object.keys(request.checks ?? {}).map(k => name(state?.[k]) || request.checks![k].instructions);
    return names.filter(Boolean).join('；');
  }
  return name(request.state);
}
