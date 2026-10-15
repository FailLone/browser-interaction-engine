import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { interactionProjection } from '../../../packages/adapter-playwright/src/exploration.js';
// Usage: pnpm exec tsx --conditions=development PATH_TO_THIS_SCRIPT RUN_DIRECTORY OUTPUT_JSON
const [directory, output] = process.argv.slice(2);
if (!directory || !output) throw new Error('Expected RUN_DIRECTORY OUTPUT_JSON');
const proof=JSON.parse(readFileSync(`${directory}/passive-proof.json`,'utf8'));
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const samples=Array.from({length:4},(_,i)=>JSON.parse(readFileSync(`${directory}/passive-sample-${i}.json`,'utf8')));
const observations=samples.map(s=>s.observation);
const result={...proof,samples:samples.map(({observation:o,session:s})=>({observationId:o.id,at:o.capturedAt,url:o.url,documentId:o.documentId,actionCount:s.actionCount,stable:o.stable,
  textHash:sha(o.text),rawFingerprint:o.fingerprint,interactionHash:sha(interactionProjection(o)),
  moneyFragments:(o.text.match(/[+\-−]?[\p{Sc}]\s*\d[\d,.]*(?:[KMBT])?/gu)||[]).slice(0,16),
  criticalGaps:o.gaps.filter((g:any)=>g.critical),gapCodes:[...new Set(o.gaps.map((g:any)=>g.code))]})),
  comparisons:{texts:new Set(observations.map(o=>o.text)).size,rawStates:new Set(observations.map(o=>o.fingerprint)).size,interactionStates:new Set(observations.map(o=>interactionProjection(o))).size,
    sameActionCount:new Set(samples.map(s=>s.session.actionCount)).size===1,sameDocument:new Set(observations.map(o=>o.documentId)).size===1,sameUrl:new Set(observations.map(o=>o.url)).size===1},
  subsequentActions:['86-action-after-live-samples','87-final-source'].map(name=>{const s=JSON.parse(readFileSync(`${directory}/${name}.json`,'utf8'));return {observationId:s.observation.id,url:s.observation.url,actionCount:s.session.actionCount,criticalGaps:s.observation.gaps.filter((g:any)=>g.critical)};})};
writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result.comparisons));
