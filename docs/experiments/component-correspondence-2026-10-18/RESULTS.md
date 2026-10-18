# 组件对应与有预算兜底：结果和边界

本次已实现可被 SDK 和真实执行消费的程序组件对应、JEV/LLM 有限兜底、持久缓存和预算保护。真实本地不同 child 的模型闭环通过；真实 OKX 的严格原 child 链尚未通过，不能称已解决真实站点探索问题。完整失败证据保留，没有改原审计器、删除未知义务或把 mapping 计数计作完成。

独立工作区 `/Users/xietian/.codex/worktrees/component-correspondence/browser-interaction-engine`，分支 `codex/component-correspondence`，基线 `82ba9c7f6e725656fd5b1133f19a5fdf5af0d5f6`，包含之前 ID/IDREF 与共享存储集成。产品初次冻结 `5766331`；验证补充 `f773a45`；候选查询成本修复及新验证冻结 `f89134d`。没有修改原 checkout、旧 dev 工作区或既有证据，没有创建 goal、自动化、其他 agent 或向其他 chat 发消息。

## 实现和收费边界

完整宿主片段、相对路径和有条件 ID/IDREF 绑定先做程序判断。唯一当前目标、业务记录、href/参数、引用拓扑、相关模式、操作和上下文仍是硬条件。明确冲突、不完整、首次发现、已有程序答案和无决策价值的材料不送模型；每个操作名最多4个当前候选。没有全历史两两模型比较。

独立 `component-correspondence` 疑问只问“同一个逻辑组件，而非仅同类型/模板”。原生 noul 原始值和概率保留，决策带暂定≤0.1为no、≥0.9为yes、中间未决；概率不等于经验准确率。仅仍可推进原待办的未决最多升级一次 LLM，明确否定及服务错误不升级。每份材料≤16KB、完整请求状态≤34KB、输出≤256tokens；不足不截断。

yes 记录直接材料对和条件哈希，SDK重新检查。模型不授予当前派发、不分发普通 coverage、不形成传递身份关系。调度实际选择原待办时保留精确派发前绑定；原待办只有得到条件核验通过的实际回执，并经历史 SDK 对应查询指向该回执后才能完成。新 child 仍是新工作。

共享存储 schema7 保留肯定、否定、未决、失败和调用预留；导出/导入与压缩整理不补充预算。相同并发问题合并。通道每240秒最多4JEV/1LLM/12秒等待，任务生命周期8JEV/2LLM且受原任务预算限制。预留先于 HTTP；崩溃预留按已消耗处理。通道耗尽后，独立程序动作仍执行。实际验证另有跨所有进程的8JEV/2LLM总池，保存在唯一 `paid-ledger.json`，不得清空。

源码逐项对照见 `SOURCE-MAP.md`。本次借鉴相对局部对应，没有照搬 ElementResolver first-match/OR、FRAGGEN 间接访问传播、完整 VIPS 或视觉判据。

## 模型与实际执行证据

|真实收费试验|原始回答|实际结果|
|---|---|---|
|早期 More 正例|JEV0.90 → yes|原 More 待办得到真实回执；这还不是不同 child 链。|
|未带组件键的 Alpha 子项|JEV0.89 → 未决；唯一LLM输出被截断|原 Alpha 未完成。LLM256tokens全部用于 reasoning；失败保留，该材料对没有重问。后续请求关闭可选 reasoning，单元测试通过，尚无新的收费 LLM 成功证据。|
|文本中的业务身份 A-100→B-200 反例|JEV0.66，原始 boolean=true，但决策为未决|未授予对应，原待办未完成；该反例仅配置JEV。没有把它写成 confident no。|
|带稳定 `data-component-key` 的新 Alpha 正例|JEV0.90 → yes，LLM0|先实际打开 More，再执行不同的原 Alpha 子项。原 scope 和条件键保留；原待办 verified，回执 `79d3315a-19fb-4ff3-a7c9-524a0b9ad39c`。|

最后一个例子是**新的实质材料对**，不是重试失败的旧 Alpha 对。证据 `plugin-real-proof-1792332196309.json` 包含完整请求材料、决策、SDK对应记录、原待办、预派发绑定和实际回执。派发前独立 source 为 `cdf2f848-d48a-4bcd-ab59-74661e7f2783/e91bdd56-8bf9-4919-974e-1afd21e8f1e3`，当前执行 session 为 `35d446fa-b563-4d35-accd-2ef1c09b8f68`。本例是受控浏览器夹具：先用真实SDK打开父项并采集子项，再用这份真实来源初始化待办交给新插件执行；并非从自然全站探索中自动发现的完整链。它不能代替 OKX 的独立严格链审计。

同一 Alpha 夹具、相同3动作/25秒预算的程序对照 `plugin-offline-proof-1792332275309.json` 没有配置模型：当前新 Alpha 可执行，原 Alpha 保持 unresolved。增强版同样执行2动作，原 Alpha完成1次；模型开销1JEV、4552输入/20输出tokens，插件耗时1702→2835ms。**没有新增分支、没有减少实际重复 dispatch**；可证明的收益是这一个原待办被正确关联并真实完成。端口与采集ID不同，业务夹具和预算相同。程序对照使用同产品关闭 provider，不是将其冒称历史82ba二进制。

累计5个HTTP/5个判断：4JEV+1LLM，20853输入tokens、336输出tokens、42507请求bytes、图像0、自动客户端重试0、传输错误0、应用输出失败1。provider耗时7623ms、通道计费等待7654ms、实际收费试验缓存命中事件2。剩余总池4JEV+1LLM。模型为配置 `typesafe/jev-1.13`、实际 `typesafe/jev-1.13-20260917`，LLM `deepseek/deepseek-v4.1-flash`。原始 `usage.cost` 保留，未配置可独立核算的单价/币种，**最终金额未知**。这些少量正反例不足以声称统计准确率。

## 冻结验证

初次冻结的原251测试两次均207通过、44既有失败，失败名完全一致；全部11个原测试文件及原验收/审计脚本逐字节未改。原完整本地验收通过：30.730秒、30命令、41/41有限义务、1条独立严格原 child 链、15原 pending 跨两个真实进程续测。这里复放旧成功运行的3JEV/2LLM答案，实际新增收费0；不是新的模型准确率验证。

最终成本修复冻结 `f89134d` 的原251再次207通过/44同名既有失败；双typecheck通过。完整本地重放再次通过：30.710秒、30命令、41/41有限义务、1条严格链、15个原pending经进程91284→91289续测，新增收费0。两次完整本地运行使用相同记录答案，不能当作两次独立模型准确率检验。局部验证110个不同测试通过：15浏览器、12预算/缓存、20provider、63调度/来源完成/共享存储；最新相关47项和双typecheck在 `f89134d` 上通过。覆盖完整ID/IDREF改名、绝对路径搬移、重复同名record、业务目的地/参数/模式/引用缺失、局部新child、yes/no/未决、单次升级、无证据不重问、冷进程、并发去重、导入导出和耗尽后程序继续执行。模拟provider与实际收费结果已分开。

## 同预算真实 OKX

原入口、公共导航范围、独立审计、240秒/80全部命令、210秒协作停止、10秒capture限制均保留。导航和失败也计数；没有登录、交易或外部写入。

|运行|冻结|耗时|全部命令|有效分支|严格原child链|模型|判定|
|---|---|---:|---:|---:|---:|---|---|
|程序基线 `okx-control-1`|82ba9c7|225.419秒|16|5|0|0/0|未通过|
|增强首轮 `okx-enhanced-1`|f773a45（产品5766331）|217.233秒|15|5|0|0/0|未通过|
|成本修复 `okx-enhanced-final`|f89134d|218.478秒|15|6|0|0/0|未通过|

首轮36个新增组件对应证明命中0个实际派发目标、0个被绑定原待办，因此收益为0。额外 SDK target 查询72→141次、累计5.487→16.562秒；嵌套计时不能相加当总耗时，实时站点波动也不能当程序加速。没有因为总轮耗时较短就声称性能改善。

已修复候选筛选顺序：先用完整材料排除确定/冲突/不可用对，仅对真实未决再查旧SDK答案。同一增强轨迹16帧离线重放，额外SDK查询115→0，机会逐帧完全一致（仍为0），筛选耗时20.184→10.729秒。这里是闭库副本上的最终pending账本，未重建每个瞬态调度状态，不是额外真实分支。据此进行了一轮最终实测：目标查询降为98次/13.157秒，仍高于基线72次/5.487秒；实际15命令的动作序列与增强首轮相同。43个组件证明命中0个实际派发目标、绑定原待办0个、模型调用0。额外的第6个审计分支是同一既有 USDT 动作的 reveal 记录，不能从动态站点单次差异归因为匹配收益。没有减少重复dispatch或新增原待办完成，没有证明实际探索改善。严格链仍为0，因此不再盲目重复确认。

## 明确未通过与剩余阻塞

首个支持操作的条件回执缺口为 `dispatch_witness_missing`，两版本一致。原 `broad-okx-worker.ts:10–23` 包装 `BrowserAdapter.prototype.execute/readDOM`，而 `browser.ts:1109/1123` 明确对非默认实现拒绝授予派发见证。本地对照 `dispatch-instrumentation-2.json` 复现：同一record内的原生点击两边均成功打开；无包装的条件回执 verified，有包装的为未验证。没有因此删除原保护或修改原审计器。

首个被拒绝的严格重入目标是旧“加载中”hover义务；加载→就绪和后面的 Crypto 模式变化是真条件差异。模型不能覆盖这些差异。缺少可信的派发见证采集路径，以及对真实相关模式恢复后原child的实际重入证据，仍是阻塞。仅修复包装兼容也不能推断其它模式/待办问题会自动消失。当前同名候选、完整guard与16KB片段边界也可能漏掉动态名称或大型组件；本轮未证明可安全放行这些机会，未扩大模型权限。

在出现可验证的新机制之前，无行为预期的同轨迹重跑不能充作冻结确认；未得到严格成功的运行不得标“确认通过”。整体任务及真实探索改善仍未满足。

## 证据与复跑

最后运行期间仅更新文档；`packages/`和`tests/`与f89134d完全一致。原44失败名、原11测试、所有原scripts均未变。旧原始fragment-audit的指定SHA256再次核验一致。

原始记录在工作区 `.data/component-correspondence/`；压缩归档在本目录 `evidence/`，`manifest.json` 为每份原始文件及归档记录SHA256。失败日志一并保留。数据库只在独立副本打开，未用构造器打开旧库。

Node24.22.0，锁定依赖。常规验证不收费：

```sh
pnpm typecheck
pnpm exec vitest run tests/component-correspondence-browser.test.ts tests/component-correspondence-budget.test.ts tests/explorer-plugin-providers.test.ts
node --import tsx --conditions=development docs/experiments/component-correspondence-2026-10-18/check-dispatch-instrumentation.ts OUTPUT.json
node --import tsx --conditions=development docs/experiments/component-correspondence-2026-10-18/check-opportunity-cost.ts CLOSED_RUN PRIVATE_ENGINE_COPY OUTPUT.json
```

原251文件名在 `original-test-files.json`，与原冻结失败列表逐名比较。完整本地重放必须用新的 `COMPONENT_REPLAY_STATE` 路径和 `NODE_OPTIONS=--import=<本目录绝对路径>/replay-local-provider.mjs`，再运行未改的 `scripts/local-loop-acceptance.mjs NEW_OUTPUT`。重放无provider网络fallback，跨进程游标持久化，检查题目及控件语义，只替换夹具本地URL。

不要重新跑已经花费且失败的同材料对。任何获准的新收费验证必须仍使用原绝对 `COMPONENT_PAID_LEDGER` 和 `paid-budget.mjs` preload，不能通过新输出目录、新进程或新round重置。环境沿用已配置文件，文档和归档没有密钥。真实OKX命令为 `scripts/broad-okx-acceptance.mjs NEW_OUTPUT program-model`；只有明确新缺口和可证伪预期才运行。
