import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { identityDecisionCommand, type IdentityReview, type IdentityDecision } from '@interaction/client';

const directory = resolve(process.argv[2] || 'work/component-blind/2026-10-15');
const read = (path: string) => JSON.parse(readFileSync(join(directory, path), 'utf8'));
const protocol = read('protocol.json');
const input = readFileSync(join(directory, 'public/cases.json'));
assert.equal(createHash('sha256').update(input).digest('hex'), protocol.casesSha256);
const cases: { caseId: string; review: IdentityReview }[] = JSON.parse(input.toString());
const answers = read('public/judge-answers.json');
assert.equal(answers.decisions.length, cases.length);
assert.equal(new Set(answers.decisions.map((d: { caseId: string }) => d.caseId)).size, cases.length);
const rows = cases.map(({ caseId, review }) => {
  const answer: IdentityDecision & { caseId: string } = answers.decisions.find((d: { caseId: string }) => d.caseId === caseId);
  assert.ok(answer);
  const allowed = new Set(['target', 'timeline', 'current', ...review.candidates.map(c => c.exhibit.ref)]);
  const rejectedRefs = answer.evidenceRefs.filter(ref => !allowed.has(ref));
  const realImageRefs = rejectedRefs.filter(ref => ref.startsWith('image:') && review.images[ref.slice(6)]);
  let rawCommandStatus = 'accepted';
  try { identityDecisionCommand(review, answer, 'gpt-5.6-sol/blind-experiment'); }
  catch (error) { rawCommandStatus = String(error); }
  // Dry-run normalization only: preserve semantics and keep allowed exhibit refs.
  // Do not execute, resolve identities, or feed back a corrected answer to judge.
  const normalized = { ...answer, evidenceRefs: answer.evidenceRefs.filter(ref => allowed.has(ref)) };
  const command = identityDecisionCommand(review, normalized, 'gpt-5.6-sol/blind-experiment');
  const allSimultaneous = review.candidates.every(c => c.simultaneous);
  const expectedConservativeDecision = allSimultaneous ? 'independent' : 'uncertain';
  return { caseId, candidateCount: review.candidates.length, allSimultaneous, decision: answer.decision,
    expectedConservativeDecision, matchesConservativeContract: answer.decision === expectedConservativeDecision,
    rejectedRefs, allRejectedRefsAreRealImages: rejectedRefs.length === realImageRefs.length,
    rawCommandStatus, normalizedDryRun: command ? 'valid independent resolution command; not executed' : 'uncertain; no command' };
});
const grade = { inputHashVerified: true, cases: rows.length,
  conservativeContractMatches: rows.filter(r => r.matchesConservativeContract).length,
  rawCommandAccepted: rows.filter(r => r.rawCommandStatus === 'accepted').length,
  rawOutputIssue: 'The judge cited real image:<observationId> evidence, but identityDecisionCommand accepts only target/timeline/current/candidate-N refs.',
  normalization: 'Only rejected image refs removed in memory for a dry run; no model retry and no decisions applied.',
  limitations: 'One component observed before and after reload, not ten independent semantic-recognition samples. Semantic recognition is reviewed separately, not automatically scored as historical identity accuracy.', rows };
writeFileSync(join(directory, 'grade.json'), JSON.stringify(grade, null, 2));
console.log(JSON.stringify({ inputHashVerified: grade.inputHashVerified, cases: grade.cases,
  conservativeContractMatches: grade.conservativeContractMatches, rawCommandAccepted: grade.rawCommandAccepted }));
