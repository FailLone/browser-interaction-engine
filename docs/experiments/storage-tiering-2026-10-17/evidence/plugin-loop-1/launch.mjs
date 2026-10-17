import { readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../../../../..');
const node = '/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin/node';
if (process.argv.length !== 3 || process.argv[2] !== '--run') throw Error('Explicit --run required');
const prep = JSON.parse(readFileSync(join(here, 'preparation.json'), 'utf8'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const revision = git('rev-parse', 'HEAD');
if (revision !== prep.productCommit) throw Error('Preparation revision mismatch');
execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', 'packages', 'scripts', 'pnpm-lock.yaml'], { cwd: root, stdio: 'ignore' });
if (git('ls-files', '--others', '--exclude-standard', '--', 'packages', 'scripts')) throw Error('Untracked implementation files');
const saved = parseEnv(readFileSync('/Users/xietian/.codex/worktrees/autonomous-exploration/browser-interaction-engine/.env.explorer.local', 'utf8'));
const names = ['EXPLORER_JEV_PROVIDER', 'EXPLORER_JEV_API_KEY', 'EXPLORER_JEV_ENDPOINT', 'EXPLORER_JEV_MODEL', 'EXPLORER_LLM_PROVIDER', 'EXPLORER_LLM_API_KEY', 'EXPLORER_LLM_ENDPOINT', 'EXPLORER_LLM_MODEL', 'EXPLORER_LLM_UPSTREAM_PROVIDER', 'EXPLORER_LLM_MAX_OUTPUT_TOKENS', 'EXPLORER_LLM_REASONING_EFFORT', 'EXPLORER_MODEL_TIMEOUT_MS', 'EXPLORER_NOUL_LOW', 'EXPLORER_NOUL_HIGH', 'EXPLORER_OPERATION_NOUL_LOW', 'EXPLORER_OPERATION_NOUL_HIGH', 'EXPLORER_CHOICE_THRESHOLD', 'EXPLORER_CLASSIFICATION_THRESHOLD', 'EXPLORER_IDENTITY_THRESHOLD', 'EXPLORER_EVIDENCE_THRESHOLD', 'EXPLORER_PLANNING_THRESHOLD'];
const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
env.PATH = dirname(node) + ':/usr/bin:/bin:/usr/sbin:/sbin';
for (const key of names) if (saved[key] !== undefined) env[key] = saved[key];
const args = ['--conditions=development', '--import', 'tsx', 'scripts/okx-plugin-loop-acceptance.ts', '--run', prep.destination];
const log = openSync(join(here, 'launch.log'), 'wx', 0o600);
const record = { startedAt: new Date().toISOString(), sourceRevision: revision, directory: prep.destination, limitMs: 240000, cleanupGraceMs: 2000, args,
  runnerSha256: createHash('sha256').update(readFileSync(join(root, 'scripts/okx-plugin-loop-acceptance.ts'))).digest('hex'),
  providerConfiguration: 'Existing EXPLORER provider whitelist only; values not recorded. No database or service configuration inherited.',
  processOwnership: 'New isolated process group; only this child and its descendants may be terminated.', timedOut: false };
writeFileSync(join(here, 'launch.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const persist = () => writeFileSync(join(here, 'launch.json'), JSON.stringify(record, null, 2) + '\n');
const began = performance.now(), child = spawn(node, args, { cwd: root, env, detached: true, stdio: ['ignore', log, log] });
record.pid = child.pid; persist();
let killTimer;
const killOwnedGroup = signal => { if (child.pid) try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') { record.terminationError = error.code; persist(); } } };
const timer = setTimeout(() => {
  record.timedOut = true; record.deadlineAt = new Date().toISOString(); persist();
  killOwnedGroup('SIGTERM');
  killTimer = setTimeout(() => { killOwnedGroup('SIGKILL'); record.cleanupDeadlineAt = new Date().toISOString(); persist(); }, 2000);
}, 240000);
child.on('error', error => { record.launchError = error.code || error.name; persist(); });
child.on('close', (exitCode, signal) => {
  clearTimeout(timer); if (!record.timedOut) clearTimeout(killTimer);
  record.finishedAt = new Date().toISOString(); record.elapsedMs = performance.now() - began; record.exitCode = exitCode; record.signal = signal; persist(); closeSync(log);
  console.log(JSON.stringify({ finished: true, exitCode, signal, timedOut: record.timedOut, elapsedMs: record.elapsedMs }));
  process.exitCode = record.timedOut ? 124 : exitCode ?? 1;
});
console.log(JSON.stringify({ started: true, pid: child.pid, directory: prep.destination, revision, limitMs: 240000 }));
