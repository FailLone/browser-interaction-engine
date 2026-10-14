import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { IdentityDecision, IdentityReview } from '@interaction/client';
const directory = resolve(process.argv[2] || JSON.parse(readFileSync('work/identity-blind/latest.json', 'utf8')).directory);
const read = (path: string) => JSON.parse(readFileSync(join(directory, path), 'utf8'));
const oracle = read('oracle.json') as (IdentityDecision & { caseId: string; scenario: string })[];
const cases = read('public/cases.json') as { caseId: string; review: IdentityReview }[];
const answers = read('public/judge-answers.json') as (IdentityDecision & { caseId: string })[];
const frozen = read('frozen.json');
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
if (hash(oracle) !== frozen.oracleSha256 || hash(cases) !== frozen.casesSha256) throw new Error('Frozen inputs changed');
if (answers.length !== cases.length || new Set(answers.map(a => a.caseId)).size !== cases.length || answers.some(a => !cases.some(c => c.caseId === a.caseId))) throw new Error('Missing, duplicate or unknown cases');
const rows = oracle.map(expected => {
  const answer = answers.find(a => a.caseId === expected.caseId)!;
  const review = cases.find(c => c.caseId === expected.caseId)!.review;
  const refs = new Set(['target', 'current', 'timeline', ...review.candidates.map(c => c.exhibit.ref)]);
  const validEvidence = !!answer.reason?.trim() && answer.evidenceRefs?.includes('target') && answer.evidenceRefs.every(ref => refs.has(ref)) && (answer.decision !== 'uncertain' || answer.missingEvidence?.some(s => s.trim()));
  const exact = expected.decision === answer.decision && (expected.decision !== 'same' || expected.candidateId === answer.candidateId);
  return { caseId: expected.caseId, scenario: expected.scenario, expected: expected.decision, actual: answer.decision, exact, validEvidence: !!validEvidence, unsafeMerge: answer.decision === 'same' && !exact };
});
const report = { model: read('protocol.json').model, reasoningEffort: read('protocol.json').reasoningEffort, frozenAt: frozen.frozenAt, gradedAt: new Date().toISOString(), oracleSha256: frozen.oracleSha256, total: rows.length, exact: rows.filter(r => r.exact).length, validEvidence: rows.filter(r => r.validEvidence).length, unsafeMerges: rows.filter(r => r.unsafeMerge).length,
  perClass: Object.fromEntries(['same', 'independent', 'uncertain'].map(decision => [decision, { total: rows.filter(r => r.expected === decision).length, correct: rows.filter(r => r.expected === decision && r.exact).length }])),
  accepted: rows.every(r => r.exact && r.validEvidence), rows,
  limitations: read('protocol.json').limitations, note: 'Evidence-reference validation is structural. Parent reviewer separately inspected reasons against source facts; this score does not prove general semantic reliability.' };
writeFileSync(join(directory, 'grade.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
