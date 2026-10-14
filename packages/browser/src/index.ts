import { InteractionEngine as CoreEngine, type Persistence, type Predicate, type InteractionScope } from '@interaction/core';
import { PlaywrightAdapter, commandSchema, type Command, type Observation, type SessionOptions, type EngineHooks } from '@interaction/adapter-playwright';
import { explainBrowserDiff } from './diff-details.js';
export * from '@interaction/adapter-playwright';
export * from './diff-details.js';
/** Browser composition only. The caller chooses persistence; there is no implicit disk storage. */
export class BrowserEngine extends CoreEngine<Observation, SessionOptions> {
  constructor(options: { persistence: Persistence; hooks?: EngineHooks }) {
    // Migrate only the browser-specific legacy field; immutable observations stay intact.
    options.persistence.transaction(() => {
      for (const scope of options.persistence.list<InteractionScope & { overlayKeys?: string[] }>('scope')) {
        if (!scope.anchors) options.persistence.put('scope', { ...scope, anchors: scope.overlayKeys || [] });
      }
    });
    super({ persistence: options.persistence, adapter: new PlaywrightAdapter(options.hooks), hooks: options.hooks });
  }
  override diffDetails(sessionId: string, beforeId: string, afterId: string, region?: string) { return explainBrowserDiff(super.diffDetails(sessionId, beforeId, afterId, region)); }
  override attemptDiffDetails(sessionId: string, attemptId: string) { return explainBrowserDiff(super.attemptDiffDetails(sessionId, attemptId)); }
  override eventDiffDetails(sessionId: string, sequence: number) { return explainBrowserDiff(super.eventDiffDetails(sessionId, sequence)); }
  override scopeDiffDetails(sessionId: string, scopeId: string) { return explainBrowserDiff(super.scopeDiffDetails(sessionId, scopeId)); }
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
