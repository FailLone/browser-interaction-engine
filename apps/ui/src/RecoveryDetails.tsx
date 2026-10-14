import React from 'react';
import type { RecoveryDiagnostics } from '@interaction/core';

const strategies: Record<string, string> = { verify_current: '验证当前位置', boundary_exit: '查找并验证弹层退出', recorded_path: '查找已记录的返回路径', declared_local_restore: '查找已声明的可逆操作', reset_hook: '调用环境重置', configured_environment_reset: '执行已配置的环境重置', entry_replay: '重开入口并重放' };
export function RecoveryDetails({ diagnostics }: { diagnostics?: RecoveryDiagnostics }) {
  if (!diagnostics) return null;
  return <details className="recovery-details"><summary>恢复依据与阻塞来源</summary>
    <p>检查过的恢复方式：{diagnostics.strategies.map(s => strategies[s] || s).join(' → ')}</p>
    {diagnostics.dirtyActions.length > 0 && <><p>以下操作使业务状态需要重新确认：</p><ul>{diagnostics.dirtyActions.map(a => <li key={a.attemptId}>{a.label} · {a.risk === 'submission' ? '提交操作' : '副作用未知'} · {a.attemptId.slice(0, 8)}</li>)}</ul></>}
    <p>{diagnostics.resetAvailable ? '已配置环境重置；是否恢复成功以验证结果为准。' : '未配置环境重置。可提供业务重置 hook；仅文档内保存状态的测试环境可显式启用重新加载重置。'}</p>
  </details>;
}
