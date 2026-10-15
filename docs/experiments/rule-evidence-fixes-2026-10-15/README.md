# 规则证据判断修复验收

在 `codex/exploration-rule-checks` 合入 `codex/region-review-reuse` 的 `9662982`；合并提交 `a4cb05f`。规则修复仅修改 rules 包及其测试/说明。无关 DOM 关系缺口不再拒用完整几何，活动边界外控件本次不检查，单帧检查与身份关联分开，历史异常独立保留。

## 同一批历史证据对比

对旧会话 `91ab1990-13d1-49ae-b561-563865af80dd` 的 34 帧 Capture 按顺序重跑，不操作页面或修改原报告：

- 最后一帧 unknown 从 13 项降到 5 项。
- Settings 弹层的第 100 / 109 / 118 帧 unknown 从每帧 18 项降到 4 项。
- 完整记录在本地 `work/exploration-rule-checks/replayed-rule-fixes.json`。

## 真实遍历

重新构建并重启本地 4173 调试服务；通过调试 UI 新建 4174 原测试页会话 `1429285a-fbb4-4638-80b8-1063c0ea422d`，开启遍历时自动检查，启动 DFS。

32 次动作、34 帧 Capture、34 次自动检测，三个插件全部完成。三处预设缺陷均被记录：Reset interface 的遮盖、Submit test order 的文字硬截断、Settings 中 Done 的控件裁切。最后一帧为 3 warning、5 unknown、40 pass、1 not-applicable，0 插件失败。

最后 5 项由三处历史异常，以及整页大容器不能完整进入视口的两条几何检查组成；不能把它们解释为五个待人工审核的 bug。`lastObservedFinding` 保留具体历史判定、Capture、目标名称和命中/裁切证据；`currentObservation` 记录基线改变后的独立当前判断。现有调试页的“检测依据”可查看这些字段，展示方式未修改。

会话仍以 `known_frontier_exhausted_with_gaps` 结束，已发现控件操作覆盖 18/19，Reset 因预设遮盖受阻。规则不会强制其点击，也不会把未知结果升级为 error。默认规范与 agent 裁决接口尚未执行。

精简结果见 [acceptance.json](acceptance.json)，调试 UI 见 [results.png](results.png)。完整新会话结果在本地 `work/exploration-rule-checks/fresh-rule-fixes.json`；服务保留新旧会话供对比。

## 自动验证

规则、要求接口、插件与自动检测相关的 8 个文件共 133 项测试通过；调试 UI、自动检测 UI 和缺陷页的 4 项端到端测试通过；类型检查、构建及编译后 smoke 通过。新增回归覆盖关系缺口、真实缺失证据、标签关系缺失、身份不确定时的单帧判断、活动弹层范围，以及三类历史异常保留。

合并时已发现页面中部起点的反向滚动测试失败：旧的方向延续逻辑只读相对位移，尚未读规则分支引入的绝对坐标协议。问题交给“完善页面穷尽测试与返回恢复”会话后，由该会话在独立分支 `codex/scroll-traversal-protocol` 提交 `a6ed79a`。本分支在 `1f068e1` 合入该修复，以及区域复用分支后续提交（包含测试布局修正 `334f0a3`）。本线程没有自行修改遍历策略。

合并前完整整合回归（暂不运行已知失败的三个滚动遍历用例）为 91 文件、774 测试：773 通过，唯一失败为行情文字变宽推移按钮的旧测试。合入 `334f0a3` 和 `a6ed79a` 后，页面及内部容器滚动、动作顺序、行情布局、自动规则与通用控件遍历的 **45 项**专项回归全部通过，覆盖此前两类失败。最终版本类型检查、构建和编译后 smoke 通过。没有把分批验证表述成最终提交的一次全量全绿。

### 最终合并版本实测

4173 服务已更新到合并版本，重新创建会话 `15b0b4fc-ecf6-47cd-b82d-6aa5560cfdae` 检查 4174 原测试页：32 动作、34 Capture、34 次自动检测，三个插件全部完成，三处预设缺陷均被检出。最后仍为 3 warning、5 unknown、40 pass、1 not-applicable；停止原因仍为已知操作前沿处理完但存在缺口。

完整结果保存于本地 `work/exploration-rule-checks/final-merged-run.json`，精简结果追加在 `acceptance.json` 的 `finalMergedRun`。前面的 UI 截图对应第一次规则修复实测，未把它当成最终合并会话截图。
