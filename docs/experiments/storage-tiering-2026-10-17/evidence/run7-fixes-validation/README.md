# 第七窗第二组修复：最终验证边界

产品固定于 `e06f057ecc1fd43feaa8cfa42d14c65e9750a08e`，分支 `codex/exploration-layered-refactor`。包含 `855a3a4` 组合来源读取/热写去重、`875ce50` 显式读取隔离契约、`e06f057` 审阅来源可见性门。此次仍在独立 worktree，没有合并 main、启动真实第八窗或操作用户正在测试的浏览器、原任务库。

## 验证结果

| 验证 | 结果 | 原始记录 |
| --- | --- | --- |
| 最终调度相关 8 文件 | 124/124 通过 | runtime-related.log、runtime-related-command.json |
| SDK 来源组合读取及内置存储隔离、共享观察、存储契约 | 3 文件，63/63 通过 | isolation-63.log |
| 任务库写成本、delta/packed/normalized 兼容 | 4 文件，47/47 通过 | ../task-store-hot-write/store-tests-47.log |
| 新审阅来源专项 | 未加门时 12 失败/3 通过；修复后 15/15 通过 | ../real-okx-7/recovery-diagnosis/ 中两版日志；也包含在本轮 124 项内 |
| 根及 core TypeScript | 均通过 | types.log、core-types.log；初始新 fixture 可选字段错误另保留于 types-initial-test-errors.log |
| 原 80 次端到端协议 | 80/80 原行为投影与基线一致；348/348 完整性通过 | ../run7-fixes-protocols/ |

重叠组不相加作为独立测试总数。最终 124 项涵盖旧失败条件不新增预算、跨会话 unknown 不创建新会话或派发、scope/source 归属、页面来源与严格 checkpoint 契约、审阅恢复、来源优先级和新隐藏/后台门禁。467 个源码文件运行前后哈希相同，HEAD 始终 e06；本轮没有重跑全部套件，也没有执行隔离构建。源码完整清单见 source-before/source-after，命令结果与受保护工作区核对见 validation.json。

原 80 次协议保留自己的原脚本、oracle 和完整原始输出；包括实际嵌套菜单恢复、A/B 输入、100 tick 无增长、反例物理到达但结果 unknown 仍拒绝、unknown 跨重启五次保留。该协议投影排除了随机 ID 等字段，不能称原始所有记录逐字一致；也不能用它证明真实 OKX 已恢复或穷尽。

## 性能与实际选择的证据分开

- [最终来源读取对照](../real-okx-7/source-material-isolation/README.md)：固定 106a→875，六个串行新进程。相同完整输入/选择/任务/事件 JSON 下，候选计算中位 35.896→25.305 秒（−29.51%）。诊断进程 maxRSS 中位 −1.34%，包含 retained 材料及输出序列化，不等于生产堆。保留[初版](../real-okx-7/source-material/README.md)仅快 2.15%、RSS +6.51% 的成本。
- [隐藏来源行为对照](../real-okx-7/review-source-counterfactual/README.md)：复用 875 完整基线，追加一个 e06 只读进程。两条隐藏候选被拒，最终没有可验证替代路线；全部 803 条计划、轮次和 6 个旧路线债完整保留。13 条新增/变更 defer 各有独立来源依据；这是工作量发生变化的行为对照，不参与上述性能比值，没有派发真实恢复。
- [热写对照](../task-store-hot-write/report.md)：六对完整输入/结果/audit 相等。run7 unchanged-round/active-item CAS 分别 −13.50%/−15.78%；历史 changed-round CAS +12.67%，写事务体增加约 0.52–0.75 ms。没有更改完整读取实现或持久化布局，两版 DB/WAL/SHM 和逻辑任务字节相同。压缩与完整读取进一步优化仍在后续计划。

各性能试验只使用完整私有副本或自己派生的夹具；只读选择器没有构造会初始化数据库的 SDK/store。诊断私有副本产生空 WAL/32 KiB SHM 的读取副作用和首个断言失败如实保留；其原有 4,511 文件与冻结来源不变。原启动记录 okx-launch-7.json/.log 为本轮开始时已有的未跟踪文件，未加入本次提交。

根线程独立校验了任务热写 52 个产物、12 份完整语义映射、两组来源读取各 6 份映射及 archive worker 字节；分别解压核对 SHA 与原始字节数。另校验原协议 39 份、诊断 15 份产物，见 independent-evidence-verification.json 和 validation.json。最初根线程诊断 manifest 检查误把其两个仓库相对路径当成目录相对路径，随后按原 manifest 明示路径核对，所有哈希一致，未改写原证据。

原工作区仍为 `6e111284`、main 仍 `069b65b`、autonomous 仍 `4857ad5`，均无未提交差异；autonomous 是当前 main 的祖先。本次新补丁尚未合并。剩余真实覆盖缺口是隐藏/非局部 selector 的 owner/IDREF/记录绑定证据不足：不能以同 DOM 实例、删除隐藏依赖或替换来源结清旧范围。候选提速和避免无用恢复已获受控证据，真实端到端恢复成功率与穷尽尚未证明。

## 最后扩展接口复核：1f7cb65

上述冻结验证完成后，根线程复核出一个合法子类反例：覆写 protected `observationActions` 返回缓存对象时，三个 public 方法均未覆写，底层 store 的 detached 声明却不能替该自定义组合结果担保。三项新增反例在 e06 原产品全部失败（原 31 项仍通过）；`1f7cb65b50d84343c92e85b199840e3834585a5f` 将 helper 函数身份纳入读取前后检查。保留子类投影并复制其返回值，覆盖缓存结果、读取中 override→base、base→override；内置实现继续走原快路径。

修后来源材料专项 **34/34**、根/core 类型检查均通过，原始先失败/后通过日志和三文件哈希见 helper-override/。此补丁只修改 helper 隔离判定、专项和 Browser README；没有重跑上述 80 协议、124 调度项或性能对照，不能把它们的原 revision 改标为 1f7。现有默认读次数/完整结果测试继续通过，恢复选择和路由算法未改。最终证据提交包含本补充，完整目标仍保持未完成。
