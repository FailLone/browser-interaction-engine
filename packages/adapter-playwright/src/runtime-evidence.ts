import type { Page, Request } from 'playwright';
import type { ConsoleEvidence, NetworkEvidence, RuntimeEvidence } from './evidence-types.js';
import { id, now } from './util.js';

/** Bounded metadata only; no handles, response bodies, cookies or credential headers. */
export class RuntimeRecorder {
  private since = now();
  private requests = new WeakMap<Request, NetworkEvidence>();
  private network: NetworkEvidence[] = [];
  private messages: ConsoleEvidence[] = [];
  private errors: RuntimeEvidence['errors'] = [];
  private dropped = { network: 0, console: 0, errors: 0 };
  private truncatedFields = 0;
  constructor(private limit: number, private textLimit: number) {}
  attach(page: Page) {
    const trim = (s: string) => { if (s.length > this.textLimit) this.truncatedFields++; return s.slice(0, this.textLimit); };
    const append = <T>(list: T[], value: T, kind: keyof RuntimeEvidence['dropped']) => {
      list.push(value); if (list.length > this.limit) { list.shift(); this.dropped[kind]++; }
    };
    page.on('request', request => {
      const row: NetworkEvidence = { id: id(), url: trim(request.url()), method: request.method(), resourceType: request.resourceType(), startedAt: now(), redirectedFrom: request.redirectedFrom() ? this.requests.get(request.redirectedFrom()!)?.id : undefined };
      this.requests.set(request, row); append(this.network, row, 'network');
    });
    page.on('response', response => {
      const row = this.requests.get(response.request());
      if (row) Object.assign(row, { status: response.status(), statusText: response.statusText(), contentType: response.headers()['content-type'] });
    });
    page.on('requestfinished', request => { const row = this.requests.get(request); if (row) row.finishedAt = now(); });
    page.on('requestfailed', request => { const row = this.requests.get(request); if (row) Object.assign(row, { finishedAt: now(), failure: trim(request.failure()?.errorText || 'Unknown request failure') }); });
    page.on('console', message => append(this.messages, { at: now(), type: message.type(), text: trim(message.text()), location: message.location() }, 'console'));
    page.on('pageerror', error => append(this.errors, { at: now(), message: trim(error.message), stack: error.stack && trim(error.stack) }, 'errors'));
  }
  snapshot(page: Page): RuntimeEvidence {
    return structuredClone({ since: this.since, capturedAt: now(), network: this.network, console: this.messages, errors: this.errors, dropped: this.dropped, truncatedFields: this.truncatedFields,
      frames: page.frames().map(f => ({ url: f.url(), name: f.name(), main: f === page.mainFrame(), parentUrl: f.parentFrame()?.url() })),
    });
  }
}
