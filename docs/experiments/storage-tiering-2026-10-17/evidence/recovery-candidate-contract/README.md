# 严格恢复候选契约：有证据的暂缓，不是到达证明

本补丁只支持一个结论：SDK 可以用当前保存的事实逐项评估已有恢复策略；插件仅暂缓明确 `no_known_path` 的严格检查点来源，保留待测范围和旧债。产品提交为 `c3a7d1a5cf08de45900b28d3aa134fbf9c600768`，开发起点为 `c63fd1c`；检查时尚未提交的产品文件由各 JSON 中的 SHA256 绑定，随后原样提交。

## 契约及接入

`checkpointRecoveryCandidates(sessionId, {observationId, checkpointIds})` 每批最多八项，保持输入顺序，共享本次当前事实读取和图刷新。它检查当前匹配、边界退出、原生来源返回、已有图路线、声明的局部恢复、reset hook、配置的环境重置和入口重放。已有首步重放与 entry permission 判断被提取复用，真实恢复的执行次序和到达验证保持原有语义。

- `tryable` 只代表存在值得实际验证的候选，不能授权执行或授予覆盖。
- `no_known_path` 要求所有受支持策略都明确缺少候选。入口路径不可重放仅否定入口策略，不能否定图路线、退出或局部恢复。
- `unknown` 保留原恢复流程；包括缺失事实、未知执行结果、未能检查的 hook/证据及变化检测失败。

插件在实际将调用严格 `reachCheckpoint` 的位置读取此契约，核对 checkpoint/source/current 引用和全部非授权标志。target arrival 与 observed-source return 不使用此负面筛选。批次耗尽后继续下一批；缓存仅在本次选择内且最多八项。暂缓不增加失败次数，不改写 plan、unknown、旧路线债或完成状态；下次选择重新评估，不建立永久黑名单。

API 是保存事实查询，不是浏览器快照，也不承诺跨连接原子读取。带异步 evidence availability、verify/accept/reset hook 的情况可能保守返回 unknown；因此这项改造不能消除所有无效尝试。

## 有界行为检查点

首次运行在 [checkpoint.json](checkpoint.json) 记录：五文件 74 项，66 通过、8 个新 core 用例失败。原因是实现查询了不受支持的增量记录类型，其 `reset` 被误判为查询中变化。修复只将变化检查限制到既有受支持的 attempt/transition/observation feed，没有扩展存储契约。

[repair-checkpoint.json](repair-checkpoint.json) 记录唯一补跑理由和新输入指纹：新 core 文件 18/18、根/core 类型检查通过。先前已通过的 plugin 17 项、来源可见性 17 项、替代路线 11 项和路线成本 11 项未重跑；后两组包含嵌套恢复、A/B 路线隔离及 unknown 不换路。不得把这些记录改称一次固定版本全套通过，也没有重跑原 80 次协议。

## 唯一冻结事实查询

[frozen-query.json](frozen-query.json) 只查询第十一窗最终保存的 current `582d5629…` 与实际失败的 checkpoint `d43e6f7d…`。八种策略均为 `no_known_path`，blockers 为空，所有到达、执行和覆盖标记为 false。它支持该最终事实下的候选筛除，**不是原派发前状态的反事实回放，也不是新恢复成功证据**。

查询 SQL 变化数、记录写入和 driver 调用均为零。BrowserEngine 初始化在临时副本中有一次生命周期 put 调用，关闭后副本数据库字节与原件完全一致；不将构造阶段说成零调用。原 v4 数据库仅按文件复制及核对哈希，从未打开；临时副本已经按所有权清理。没有复制不可变 blob，也没有重新审计四个 receipt。第十一窗的原始结果只引用 [原报告](../real-okx-11/README.md)。

## 结论边界与下一检查点

本轮没有耗时对照或存储基准，不宣称恢复提速、成功率提高或占用下降。候选筛选与实际验证分离借鉴了 Crawljax 的候选 reset 路径及执行后重新检查状态的做法，未复制其代码或采用其 URL 重置策略；参考 [Crawler.java](https://raw.githubusercontent.com/crawljax/crawljax/master/core/src/main/java/com/crawljax/core/Crawler.java)。

后续只在隔离发布接口检查通过后启动一个独立真实接续窗口，验证来源暂缓确实生效，并分别核对实际到达和到达后的有效覆盖。第 3 项真实到达与接续门目前仍未通过。原测试浏览器、服务、任务库和其他工作区未用于本轮验证。
