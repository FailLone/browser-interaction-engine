import { SqliteStore } from '@interaction/storage-sqlite';
import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { InteractionEngine, type ActionAttempt, type FrontierItem } from '@interaction/browser';
it('does not repeat a real submission after the process is killed before recording its result', async () => {
  let commits = 0; let ready: { sessionId: string; actionId: string } | undefined;
  const server = createServer((request, response) => {
    if (request.url === '/commit') { commits++; response.end('ok'); return; }
    response.setHeader('Content-Type', 'text/html'); response.end(`<form onsubmit="event.preventDefault(); fetch('/commit', {method:'POST'})"><button id="commit">Commit</button></form>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const directory = mkdtempSync(join(tmpdir(), 'engine-crash-'));
  const child = fork(resolve('tests/fixtures/crash-child.ts'), [`http://127.0.0.1:${(server.address() as any).port}`, directory], { execArgv: ['--import', 'tsx', '--conditions=development'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let engine: InteractionEngine | undefined; let logs = ''; child.stderr!.on('data', chunk => logs += chunk);
  try {
    await new Promise<void>((resolve, reject) => {
      child.on('message', (message: any) => { if (message.phase === 'ready') ready = message; if (message.phase === 'after-dispatch') resolve(); });
      child.once('exit', code => reject(new Error(`Child exited early ${code}: ${logs}`)));
      child.once('error', reject);
    });
    expect(commits).toBe(1);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    engine = new InteractionEngine({ persistence: new SqliteStore(directory) });
    expect(engine.session(ready!.sessionId).status).toBe('paused');
    const attempts = engine.list<ActionAttempt>(ready!.sessionId, 'attempt'); expect(attempts).toHaveLength(1); expect(attempts[0].status).toBe('unknown');
    expect(engine.list<FrontierItem>(ready!.sessionId, 'frontier').some(f => f.status === 'unknown')).toBe(true);
    const retried = await engine.execute(ready!.sessionId, ready!.actionId, 'durable-commit');
    expect(retried.id).toBe(attempts[0].id); expect(retried.status).toBe('unknown'); expect(commits).toBe(1);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); await engine?.close(); await new Promise<void>(r => server.close(() => r())); rmSync(directory, { recursive: true, force: true }); }
});
