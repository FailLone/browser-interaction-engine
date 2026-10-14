import { InteractionEngine as CoreEngine, type Persistence, type Predicate, type InteractionScope } from '@interaction/core';
import { PlaywrightAdapter, commandSchema, type Command, type Observation, type SessionOptions, type EngineHooks } from '@interaction/adapter-playwright';
import { BrowserEvidenceQueries, type DomQuery, type ArtifactKind } from './evidence.js';
export * from '@interaction/adapter-playwright';
export * from './evidence.js';
/** Browser composition only. The caller chooses persistence; there is no implicit disk storage. */
export class BrowserEngine extends CoreEngine<Observation, SessionOptions> {
  private readonly evidenceQueries = new BrowserEvidenceQueries(this);
  observationDetails(sessionId: string, observationId: string) { return this.evidenceQueries.details(sessionId, observationId); }
  controlDetails(sessionId: string, observationId: string, controlId: string) { return this.evidenceQueries.control(sessionId, observationId, controlId); }
  regionDetails(sessionId: string, observationId: string, key: string) { return this.evidenceQueries.region(sessionId, observationId, key); }
  dom(sessionId: string, observationId: string, query: DomQuery = {}) { return this.evidenceQueries.dom(sessionId, observationId, query); }
  eventContext(sessionId: string, sequence: number) { return this.evidenceQueries.eventContext(sessionId, sequence); }
  evidenceArtifact(sessionId: string, observationId: string, kind: ArtifactKind) { return this.evidenceQueries.artifact(sessionId, observationId, kind); }
  constructor(options: { persistence: Persistence; hooks?: EngineHooks }) {
    // Migrate only the browser-specific legacy field; immutable observations stay intact.
    options.persistence.transaction(() => {
      for (const scope of options.persistence.list<InteractionScope & { overlayKeys?: string[] }>('scope')) {
        if (!scope.anchors) options.persistence.put('scope', { ...scope, anchors: scope.overlayKeys || [] });
      }
    });
    super({ persistence: options.persistence, adapter: new PlaywrightAdapter(options.hooks), hooks: options.hooks });
  }
  async command(sessionId: string, input: unknown) {
    const command: Command = commandSchema.parse(input);
    switch (command.type) {
      case 'observe': return this.observe(sessionId);
      case 'inspect': return this.inspect(sessionId, command.region);
      case 'execute': return this.execute(sessionId, command.actionId, command.requestId, command.value);
      case 'explore': case 'resume': return this.explore(sessionId);
      case 'pause': return this.pause(sessionId);
      case 'stop': return this.stop(sessionId);
      case 'resolveIdentity': return this.resolveIdentity(sessionId, command.hypothesisId, command.identityId, command.source, command.evidence);
      case 'openScope': return this.openScope(sessionId, command.name, command.region);
      case 'closeScope': return this.closeScope(sessionId, command.scopeId);
      case 'createCheckpoint': return this.createCheckpoint(sessionId, command.name, command.predicates as Predicate[], command.acceptable as Predicate[]);
      case 'reachCheckpoint': return this.reachCheckpoint(sessionId, command.checkpointId);
    }
  }
}
export { BrowserEngine as InteractionEngine };
