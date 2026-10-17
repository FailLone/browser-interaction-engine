本轮完成一次同步 audit/outcome 内的 normalizer 复用，未提交。基线为 d103747，当前未提交源码和测试 SHA 见 validation.json，产品差异保留为 product.patch。

旧导出 wrapper 每次仍建立新工厂。runtime 只在 auditRemainingScopes 和 recordOutcome 的同步栈内共享最多 8 个 SourceRecord 及每 action 对象的 key 计算；每次调用仍独立检查可变 item 的原始 proof/source/scope/unknown 守卫，生成新 changes，并保留事件和 index.refresh 顺序。

验证：4 个相关文件 69/69 测试通过，根类型检查通过，diff --check 通过。初次 typecheck 的两个 fixture 字段缺失错误及修复后的日志均保留。实际 runtime outcome 路径与强制旧 wrapper 路径的完整 task/events 相同；两个 item 共享一次成功 receipt 的读取，仍各自经过原完成门。源投影遍历 3→1、attempt list 2→1，冻结输入 JSON、旧 route 债、tried/reentry 均不变。audit 接线验证事件顺序、来源追加及后续调用重新建立缓存。

缓存边界必须区分内外层：factory 8 个 SourceRecord，原 reader 另有 8 Observation 与 8 action 数组，因 LRU/FIFO 次序可能错位。在读取之间的保守上界为 16 个完整 Observation 对象、16 套 action 对象（其中 8 套原数组）、三缓存至多 24 个来源 key；构建中另可能有一个临时读取值。调用者持有的 current/snapshot/source 与 SDK 其他缓存不在此界。原 per-session attempts map 保留本次涉及 session 的完整 ledger，并非 8 条上限；总内存也不具固定字节上限。所有这些只活到同步调用结束，不能跨 await、SDK 修改或 review/identity 修订。本次保留外层缓存与 current 预置，未扩大补丁。

已有 d103 CPU profile 支持重复 scope/条件投影是热点，静态 114×206=23484 次当前 scope 投影可缩为一次 206 项索引。这不是新版本的已测加速。114 个不同候选的 228 次 v2/v3 key 计算、启动 normalization 和先前 +200975B 逻辑任务增量不因此消失。未运行新 benchmark/全套测试，未打开生产数据库或真实 browser/provider；固定真实输入的完整 task/events 差分和有限性能协议由 root 独立负责。
