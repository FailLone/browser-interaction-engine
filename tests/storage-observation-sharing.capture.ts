/** Capture only the repository fixture in a new headless browser and temporary
 * engine database. Never connects to an existing browser or running service. */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixtureServer, testEngine } from './helpers.js';
const output=process.argv[2];if(!output)throw Error('Pass an output JSON path');
const fixture=await fixtureServer();
try {
  const run=await testEngine(fixture.url,{contextRules:[],settleMs:60,observeTimeoutMs:1200});
  try {const observation=run.engine.observation(run.sessionId);writeFileSync(resolve(output),JSON.stringify(observation,null,2)+'\n');console.log(JSON.stringify({output:resolve(output),controls:observation.controls.length,regions:observation.regions.length,bytes:Buffer.byteLength(JSON.stringify(observation))}));}
  finally{await run.close();}
}finally{await fixture.server.close();}
