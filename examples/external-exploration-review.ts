import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InteractionClient } from '@interaction/client';
import type { ExplorationGroupResolution, ExplorationReviewMaterial, RegionReviewInput, RegionReviewMaterial } from '@interaction/browser';

export interface ExplorationReviewer {
  partition(material: RegionReviewMaterial): Promise<RegionReviewInput | undefined>;
  decide(material: ExplorationReviewMaterial): Promise<ExplorationGroupResolution[] | undefined>;
}

/** Run outside engine hooks. A slow reviewer holds no engine command queue. */
export async function reviewExploration(client: InteractionClient, sessionId: string, reviewer: ExplorationReviewer) {
  // Pause settles an in-flight action before obtaining the review materials.
  await client.command(sessionId, { type: 'pause' });
  const regions = await client.regionReviewMaterial(sessionId);
  if (regions.enabled && (regions.unassignedControlIds.length || regions.unassignedPageTraversal)) {
    const review = await reviewer.partition(regions);
    if (review) await client.reviewRegions(sessionId, review);
  }
  // Partitioning generates new scopes. Never decide scopes from the old material.
  const material = await client.explorationReviewMaterial(sessionId);
  if (material.groups.some(g => !g.decisions.length || g.decisions.at(-1)?.invalidation || g.decisions.at(-1)?.decision.mode === 'defer')) {
    const decisions = await reviewer.decide(material);
    if (decisions?.length) await client.decideExplorationGroups(sessionId, decisions);
  }
  // Only scoped scheduling approval changes; all operation checks still apply.
  // Unassigned, unanswered and deferred work remains pending while allowed work runs.
  await client.command(sessionId, { type: 'explore' });
}

// Run against an existing server:
// pnpm exec tsx --conditions=development examples/external-exploration-review.ts URL
// Or attach: ... examples/external-exploration-review.ts --session SESSION_ID
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [target, existingSession] = process.argv.slice(2);
  if (!target || target === '--session' && !existingSession) throw new Error('Supply URL or --session SESSION_ID');
  const client = new InteractionClient(process.env.INTERACTION_URL || 'http://127.0.0.1:4173');
  const sid = target === '--session' ? existingSession : (await client.createSession({
    url: target, headless: true, regionExploration: 'review', pageExploration: 'review', listExploration: 'review',
  })).id;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const abort = new AbortController();
  const notifications = (async () => {
    for await (const event of client.events(sid, 0, abort.signal)) {
      if (['region.review_requested', 'region.review_invalidated', 'exploration.review_requested', 'exploration.paused', 'exploration.finished'].includes(event.type)) {
        console.log(`\n#${event.sequence} ${event.type}: ${JSON.stringify(event.data)}`);
      }
    }
  })().catch(error => console.error('Event subscription:', error));
  async function ask<T>(stage: string, material: unknown): Promise<T | undefined> {
    console.log(`\n${stage}\n${JSON.stringify(material, null, 2)}`);
    const path = (await terminal.question('Decision JSON file (blank leaves pending): ')).trim();
    return path ? JSON.parse(await readFile(resolve(path), 'utf8')) as T : undefined;
  }
  console.log(`Session ${sid}. Decisions are supplied by the caller, not inferred by this example.`);
  try {
    while ((await terminal.question('Enter to review current materials; q to detach: ')).trim() !== 'q') {
      try {
        await reviewExploration(client, sid, {
          partition: material => ask<RegionReviewInput>('1. Confirm exploration regions', material),
          decide: material => ask<ExplorationGroupResolution[]>('2. Choose all / sample / defer / skip', material),
        });
      } catch (error) {
        // A stale decision is never rewritten to a new version. The next cycle
        // asks the caller again using fresh evidence; the failed cycle stays paused.
        console.error('Decision not applied or exploration not resumed:', error);
      }
    }
    await client.command(sid, { type: 'pause' });
    const report = await client.report(sid);
    console.log(JSON.stringify({ explorationAudit: report.explorationAudit, controlCoverage: report.controlCoverage.counts }, null, 2));
  } finally {
    abort.abort(); terminal.close(); await notifications;
  }
}
