# 候选选择阶段收尾

产品固定为 `d11b4f32c19620fd9581eb3d5cd5486811af50f0`。本轮只关闭发布与合并检查点：不重跑已通过的行为组、240 秒基线或真实网页实验。

## 发布检查

使用该提交的独立 Git 归档，仓库内包始终解析到归档内部，第三方依赖只借用已安装内容。没有在现有工作区清理、重建或安装运行产物。复用旧发布 runner 的归档和依赖链接流程，移除旧 receipt 输入；本次输入及脚本哈希在 [reference.json](reference.json)。

以下三项各执行一次，全部通过，见 [validation.json](validation.json)：

1. 完整发布构建，包括 SDK/core、插件、UI 和 test-site。
2. 现有公开 exploration snapshot 声明消费检查。
3. 编译后公开模块及新增契约检查：`recoverySelectionView`、`recoveryAnchorMaterial`、`recoveryReviewMaterial`、`checkpointRecoveryCandidates`、`recordRevision`，以及插件可选接口与非授权类型边界。默认解析走发布的 `dist`，不启用 development 条件；未创建 engine/store/driver。

源码清单在构建前后相同，构建产物哈希单独保存。临时归档已按 ownership 标记清理，借用依赖未删除；见 [cleanup.json](cleanup.json)。这些记录只证明发布产物可构建、接口可被消费，不证明真实恢复或性能。

行为正确性复用产品对应的 [137 项定向测试及类型检查](../strict-checkpoint-fallback/README.md)。前序选择周期、轻量材料和误排除修复的证据仍在原位置，本轮不复制输入或重复计算。

## 合并与边界

main 从 `7c0273d` 快进到产品 `d11b4f3`，包含 autonomous-exploration `4857ad5`；没有冲突处理或覆盖工作区文件。合并前后 main 干净，主工作区和 autonomous 工作区的 HEAD/未提交状态不变，详见 [main-merge.json](main-merge.json)。随后仅归档本报告和状态文档，不改变受测产品代码。未推送远端，未重启服务或替换运行中的构建产物。

第 1 项严格检查点候选修复，以及该批优化的开发、离线发布检查和本地合并已收尾。原有未跟踪实验文件保留。

**第 3 项整体真实验收仍未关闭**：还缺一个有界真实窗口，验证当前版本能实际到达待测状态、继续产生新覆盖，并同时记录各阶段成本和实际处理量。它须单独遵守浏览器、任务库的使用边界；本次没有操作任何浏览器、服务或原任务数据库，不把候选存在、队列结束或构建通过改记成恢复成功或穷尽。
