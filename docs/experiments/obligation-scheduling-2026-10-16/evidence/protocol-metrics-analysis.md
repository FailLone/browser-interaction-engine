阶段1恢复与调度基线指标核对

分析范围：阶段1 `db3cbeaf045dde8528cc159c2fb10e81de0d3ed8` → `290456d63831477638b6aa7de3bee4a15e4c675c`，以及调度阶段的 `290456d` 原协议基线。这里没有调度最终修复版的协议结果。

阶段1：每版30次＝20个正向到达案例＋10个应拒绝案例。两版均为正例20/20，负例正确拒绝10/10，错误到达声明0。正例均有独立DOM/Playwright readiness及实际受保护输入事件；另20个直接浏览器测量输入不计SDK覆盖。

| 场景（每版n=5） | db3 median/max ms | 290 median/max ms | 结果 |
|---|---:|---:|---|
| nested_static | 571.24/612.97 | 510.83/542.71 | 5/5 到达＋实际SDK分支 |
| modal_reentry_changed_quote | 716.88/724.74 | 714.38/724.92 | 5/5 到达＋实际SDK分支 |
| ready_target_ticking_quote | 188.09/205.84 | 188.61/205.74 | 5/5 到达＋实际SDK分支 |
| nested_changed_quote | 971.18/1057.73 | 862.68/1002.24 | 5/5 到达＋实际SDK分支 |
| local_inverse_diverges | 384.43/402.33 | 389.12/389.71 | 5/5 正确拒绝；不计恢复成功 |
| unknown_outcome_injected | 0.79/0.88 | 0.78/0.92 | 5/5 正确拒绝；不计恢复成功 |

正例合计API耗时 median：657.11 → 627.67 ms；max：1057.73 → 1002.24 ms。两版各40次恢复动作尝试，其中35次用于正例，5次属于有意拒绝的局部逆操作案例；各10次入口重开、10次恢复期间文档请求、0次environment-reset动作。其中需要执行恢复动作的三类正例合计15次，median为716.88 → 714.37 ms。成功率没有提升；小样本时延变化只能作描述，不能外推整体性能提升。

恢复脚本未启动探索插件/模型，因此JEV/LLM调用均为0；没有任务清单，pending增长未测。其unknown案例只在同一session注入：两版各5/5保留原unknown并阻断受保护派发，**没有测跨重启**。

调度基线条件协议（25次＝5场景×5）：

| 场景 | 实际分支/试次 | 整体清单/待测行变化 | 100 ticks额外增长 |
|---|---|---|---|
| public-form-cycle | form:A, form:B；完整预期5/5 | 首个快照已完成，前值未测；结束5/0 | 不适用 |
| shared-id-rebuild | shared:B；完整预期0/5 | 1/1 → 6/4 | 不适用 |
| price-known | price:run；完整预期5/5 | 1/1 → 5/3 | 清单0、待测0 |
| price-unknown | price:run；完整预期5/5 | 1/1 → 7/5 | 清单0、待测0 |
| nonlocal-dependency | nonlocal:A, nonlocal:B；完整预期5/5 | 1/1 → 8/4 | 不适用 |

合计35/40个声明叶分支实际发生；shared-id-rebuild的A在5次中均未执行，不能写25/25分支覆盖完成。其余4场景均5/5触发全部声明分支。全部25次：错误覆盖记录0、重复叶点击0、恢复动作0、JEV/LLM请求0。known/unknown价格每次100 ticks均为state=1、retry key=1、实际click=1，价格阶段清单/待测额外增长均0。非局部A/B两分支各次均实际执行；它未证明任意隐式JavaScript依赖被覆盖。

调度基线接续协议（15次）：

| 场景（n=5） | 实际叶分支 | 重启前→后 清单/待测行 | 恢复API调用 | JEV/LLM总数 | trial median/max ms |
|---|---|---|---|---|---:|
| cold_nested_restart | 15/15 | 11/5 → 11/0 | 0（实际0） | 40/0 | 3672/3813 |
| failed_recovery_restart | 10/10 | 6/4 → 6/2 | 5（实际0） | 10/0 | 1202/1228 |
| unknown_recovery_restart | 5/10 | 6/4 → 6/4 | 5（实际5） | 5/0 | 814/823 |

cold_nested_restart：5/5真正关闭并重建host/plugin，三叶全执行；重启后新增叶总计10，必要重入15、无理由重入0。恢复API调用0，因此没有可报告的恢复API成功率或耗时。

failed_recovery_restart：5/5触发不可用故障，插件重建而host未关闭；随后建立新session。实际A/B叶均发生，但最终仍budget_exhausted、保留2个待测账务行/试次；不能按队列状态宣称完成。5次恢复API调用全部是注入的无派发UNVERIFIED，耗时记录均0 ms（四舍五入的本地stub），不能算真实恢复速度。

unknown_recovery_restart：5/5确实先执行真实SDK恢复，再把一个临时持久记录改为unknown；5/5关闭并重建host/plugin，重启后仍blocked，原unknown保留。重启后新会话0、attempt0、恢复调用0、模型请求0；observe调用次数未由此脚本记录。原始SDK返回正状态5次发生在unknown注入前，不能算5次安全恢复成功。真实恢复调用耗时median/max＝313/325 ms；其后安全阻断导致Branch B刻意不执行，属于正确拒绝。

全部接续协议：命名待测来源行40个，丢失0、错误结清0、重复叶执行0、同条件无进展重试0、错误completed声明0；必要重入15、无理由重入0；JEV stub请求55、LLM请求0。这些重入分类依赖固定fixture入口与叶名称，不是任意网页因果必要性的证明。

输入身份协议（10次）：2个命名场景各5次，40/40对应判断符合预期，其中30个拒绝、10个接受；30/30受保护fill成功，HTTP输入事件A/B/C各10次。它测试SDK对应关系及外部DOM重建，不是自主调度；没有恢复API、任务清单或耗时采样，相关指标未测。

可报告的测量边界：

- 本文只包含阶段1恢复对照和调度290基线，不包含最终调度修复版协议结果。
- 恢复成功分母为每版20个正例；10个有意构造的负例应单列安全拒绝。
- 恢复协议的unknown只测同会话阻断；接续协议才测5次有实际注入的host冷重启，但未记录observe调用数。
- 接续协议的recoveryHostSuccesses来自unknown注入前的SDK原始返回；不能据此宣称安全恢复完成。
- price-unknown表示模式条件证据不确定，不是执行结果unknown，也没有测重启。
- 条件协议仅public-form-cycle走完整公开运行流程，且首个清单快照在完成之后；其余4种情形通过private step和外部事件测机制。
- 接续协议使用确定性模型替身；JEV/LLM统计是请求次数，未测真实模型质量、token开销或网络延迟。
- 必要重入按照固定入口标签和仍未执行的声明叶分支分类，不构成任意页面的因果必要性证明。
- 阶段1durationMs只包围恢复API，不含后续DOM oracle与受保护目标派发；每场景5样本且顺序运行，不能据此证明普遍提速。
- 清单/待测行是账务数量，不等于独立未测UI分支；100 ticks不增长、命名叶范围未丢失，都不能证明网页穷尽。
- 未测CPU/内存/数据库字节、观察/前沿/缓存构建次数、稳定的高分位时延、任意隐式JS依赖、实时OKX覆盖及长期失效范围累积。

证据与一致性：四脚本当前字节哈希均与记录一致；db3导出200个产品文件无差异，290调度导出200个产品文件全部匹配；阶段1 fixed前后产品哈希一致。完整分组、计数定义和哈希在同名JSON中。

原始调度基线：[conditions](/tmp/bie-stability-scheduler-evidence/conditions-scheduler-base.json)、[continuation](/tmp/bie-stability-scheduler-evidence/continuation-scheduler-base.json)、[input identity](/tmp/bie-stability-scheduler-evidence/input-identity-scheduler-base.json)。阶段1十份原始文件路径及SHA256均列入同名JSON的sourceArtifacts。
