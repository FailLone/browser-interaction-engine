import { SqliteStore } from '@interaction/storage-sqlite';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { InteractionEngine, type ActionCandidate, type ActionAttempt, type FrontierItem, type IdentityHypothesis, type InteractionScope, type Observation } from '@interaction/browser';

const fixture = await createServer({ root: resolve('apps/test-site'), logLevel: 'error', server: { port: 0, strictPort: false } });
await fixture.listen();
const url = `http://127.0.0.1:${(fixture.httpServer!.address() as any).port}`;
const directory = resolve('.data', `report-${Date.now()}`); const engine = new InteractionEngine({ persistence: new SqliteStore(directory) });
mkdirSync(resolve('docs/run-evidence'), { recursive: true });
try {
  const session = await engine.createSession({ url, headless: true, maxActions: 10, settleMs: 150, contextRules: [{ key: 'pair', selector: '#pair' }], exclude: [{ name: 'Submit test order' }, { name: 'Background refresh' }] });
  const sid = session.id;
  async function act(label: string, kind: ActionCandidate['kind'] = 'click', value?: string) {
    const candidate = engine.actions(sid).find(a => a.label === label && a.kind === kind && !a.excluded);
    if (!candidate) throw new Error(`Candidate unavailable: ${label}`);
    const result = await engine.execute(sid, candidate.id, crypto.randomUUID(), value);
    if (result.status !== 'succeeded') throw new Error(`Action failed: ${label}: ${result.reason}`);
  }
  await act('Order type'); await act('Market'); await act('Amount', 'fill', '2');
  const market = await engine.createCheckpoint(sid, 'Market / amount=2');
  await act('Amount', 'fill', '3'); const recovery = await engine.reachCheckpoint(sid, market.id);
  if (recovery.status !== 'REACHED_VERIFIED') throw new Error(`Checkpoint was not verified: ${recovery.reason}`);
  await act('Duplicate controls');
  await engine.explore(sid); await engine.waitForIdle();
  const report = engine.report(sid); const graph = engine.graph(sid); const attempts = engine.list<ActionAttempt>(sid, 'attempt');
  const frontier = engine.list<FrontierItem>(sid, 'frontier'); const hypotheses = engine.list<IdentityHypothesis>(sid, 'hypothesis');
  const scopes = engine.list<InteractionScope>(sid, 'scope'); const observations = engine.list<Observation>(sid, 'observation');
  const evidence = observations.filter(o => o.screenshot).map(o => {
    copyFileSync(join(directory, 'evidence', o.screenshot!), resolve('docs/run-evidence', o.screenshot!));
    return { observationId: o.id, file: `run-evidence/${o.screenshot}` };
  });
  const output = { generatedAt: new Date().toISOString(), ...report, graph, attempts, frontier, hypotheses, scopes, checkpointResult: recovery, evidence };
  writeFileSync(resolve('docs/run-report.json'), JSON.stringify(output, null, 2));
  const lines = [
    '# V0.1 实际运行报告', '',
    `生成时间：${output.generatedAt}。运行于 Node ${process.version}，本地 React 测试站 + Chromium；无外部网站或模型服务。`, '',
    '此文件由 `pnpm report` 生成，所有计数来自持久化记录。', '',
    `- 会话：\`${sid}\``,
    `- 已发现：${graph.states.length} 个状态、${graph.visits.length} 次访问、${graph.transitions.length} 条迁移、${frontier.length} 项待办记录。`,
    `- 执行：${JSON.stringify(report.attempts)}；动作预算 ${report.session.actionCount}/${report.session.options.maxActions}。`,
    `- 待办分布：${JSON.stringify(report.frontier)}。`,
    `- 结果未知动作：${attempts.filter(a => a.status === 'unknown').length}。身份待裁决：${hypotheses.filter(h => h.status === 'pending').length}。`,
    `- 结束原因：\`${report.session.stopReason || report.session.status}\`。`,
    `- 检查点结果：\`${recovery.status}\`，${recovery.attemptIds.length} 次恢复动作。`,
    `- 已保存 ${evidence.length} 张截图；采集缺口 ${report.gaps.length} 条。`, '',
    '## 实际动作', '', '| # | 目的 | 操作 | 结果 | 变化数 |', '| --- | --- | --- | --- | --- |',
    ...attempts.map((a, i) => `| ${i + 1} | ${a.purpose} | ${a.action.kind} · ${a.action.label} ${a.action.value ?? ''} | ${a.status} | ${a.diff?.changes.length ?? '未知'} |`), '',
    '## 受阻、未知与未完成范围', '',
    ...Object.entries(frontier.filter(f => f.status !== 'executed').reduce<Record<string, number>>((m, f) => { const k = `${f.status}: ${f.reason || '待选择'}`; m[k] = (m[k] || 0) + 1; return m; }, {})).map(([reason, count]) => `- ${reason}：${count} 项。`), '',
    '这不是全站覆盖率。未发现的事件处理器、未声明的业务事实、未覆盖的控件组合和浏览器能力仍属于未知范围。', '',
    '## 流程累计影响', '',
    ...scopes.map(s => `- ${s.name}：${s.status}，${s.attemptIds.length} 次操作，${s.diff?.changes.length ?? 0} 项累计差异，父区域 \`${s.region}\`。`), '',
    '## 证据', '',
    ...evidence.map(e => `- [${e.observationId}](${e.file})`), '',
    '机器可读结果：[run-report.json](run-report.json)。报告包含动作、图、待办、歧义、范围和恢复结果。原 SQLite 数据保存在 `.data/report-*/`，报告与复制的 PNG 可独立阅读。', '',
  ];
  writeFileSync(resolve('docs/run-report.md'), lines.join('\n'));
  console.log(JSON.stringify({ report: 'docs/run-report.md', states: graph.states.length, attempts: report.attempts, frontier: report.frontier, recovery: recovery.status }, null, 2));
} finally { await engine.close(); await fixture.close(); }
