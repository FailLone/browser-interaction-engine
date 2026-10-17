# Run6 selector 条件缺口：只读诊断

结论：**现有 portable 合约的拒绝正确，但采集层确有可复现的信息丢失；另有仅限同文档的窄样本方向。** 不能删除 hidden selector、去掉 hypothesis/instance 门禁，或把同名、同链接、同 DOM 节点当成跨文档业务身份。本轮没有改产品或测试。

事实来自已鉴真的 run6 原始提取对象和冻结 evidence 文件；没有打开数据库、构造 SDK、启动浏览器或访问 provider/network。纯函数复算使用 `125a10ca6dbc78f8dd859a0e7a2917f83d67b55b` 时的源码，相关文件前后 SHA 一致，逐文件摘要在 [JSON](selector-condition-diagnosis.json)。本报告不是运行时或性能基准。

| 真实观察 | actions | selector | unavailable branch / target | 实际阻断 |
|---|---:|---:|---:|---|
| 返回页 c11abe9e | 206 | 26 | 206 / 206 | 2 个 pending hypothesis；另有 1 组重复绑定 |
| Trade 后 f23494e8 | 214 | 28 | 214 / 214 | 3 个 instance-only selector |
| 后续 7d2b74b2 | 214 | 28 | 214 / 214 | 同上 |
| 最终 fd34f210 | 214 | 28 | 214 / 214 | 同上 |

四帧均 stable、无 critical gap、context={}；没有 selector 状态缺失/unstable，也没有超过 32 个上限。表中 later frames 不是 26 selectors：Trade 展开后新增两个。独立的内存负对照证明：只移除 c11 两个 hypothesis 仍 206/206 unavailable（重复 binding）；只人为区分 binding 而保留 hypothesis 也仍全拒绝。这些改动只用于定位原因，未写入任何来源或用于授权。

## 最小可复现条件与采集调用链

任意目标旁边有一个 `expanded=false` 且 hypothesis 未解决的隐藏 selector，`browserBranchConditions` 即返回 undefined；即便假设逻辑身份已解决，两个相同 portable binding 的 selector 仍独立足以失败。非局部依赖使这一失败传播到所有目标，是当前契约的明确行为。

真实 c11 的两个 `i[role=button][aria-expanded=false]` 均叫 `Open sub-menu`，实例尾号 1315、1321。它们各自的 li 直接子链接分别为 `/flash-earn?from-page=trade`、`/agent-tradekit`。4,402,773 B 的原 details 经过 148 个块和总 SHA 校验；两条 li、直接 anchor、selector、子 panel 均存在且无局部 node gap。整体 details 有截断，因此不声称完整页面 DOM 已恢复。

具体链路：

1. `browser.ts:106–117 recordScopes` 把任何 computed `visibility:hidden` 后代都当作独立内容区。菜单祖先隐藏时，li 和直接 anchor 也都是 hidden；两行的所有直接子元素均被这个条件排除。
2. `recordLinks` 排除上述区内的链接；`recordDescription` 同时删去这些子树。两条原本不同的记录链接/描述消失，`itemKey` 为空，`scopedControlKey` 返回 undefined。
3. `identity-context.ts scopeFor` 对 li 后代主动不补祖先 scope，避免绕开 record 绑定；`structural-lists.ts` 又只发现 visible 成员，所以没有另一条合格记录证据补上。
4. core identity 的同名 semantic signature 碰撞形成 pending hypothesis。`branch-conditions.ts:35,105` 对 unresolved / duplicate binding 拒绝。

Trade 打开后的真实帧提供交叉验证：同一批 DOM 实例获得不同 `record-links` scoped key，但采集器仍故意设 `identityScope='instance'`。此时新增 `Open Spot sub-menu` 也属于 instance-only，共三个。**修正隐藏记录采集本身不会把 portable 条件变成可用，更不能删除 instance-only 限制来追求通过率。**

最窄采集修复方向是把「整条记录/祖先隐藏」与「独立嵌套内容面板」分开，保留有明确结构归属的原始记录绑定证据；不要把 computed hidden 等同于独立作用域。由于仅 computed style 不能完整证明 CSS 隐藏来源，不能简单删除 hidden 过滤或将任意邻近链接移入身份。新证据应包含其 owner/slot、直接链接属性与唯一性、嵌套 panel 排除依据；缺证仍拒绝。当前原始记录不补写。

## document-bound 分层：可行方向与必要边界

SDK 当前把不同用途绑在同一个 portable selector 条件上：`controlCase(...,false)` 和 `controlCase(...,true)` 都调用 `browserBranchConditions`；core `correspondenceReader` 和 `reconcileCoverage` 采用 `adapter.correspondenceCase → controlCase(...,true)`；target arrival/repetition 又使用 `browserTargetConditions`。只改变 false 分支不会解决插件的实际 correspondence；悄悄放宽 true 分支则会扩展 portable/回放合约。

文档标识生命周期支持显式区分：`collectDOM` 在页面 window 中保存随机 `documentId` 和 Element WeakMap，节点实例为 `documentId:counter`；Observation 的 instanceScope 就是该 documentId。普通重采集/SPA 同节点保留，替换节点产生新实例，新文档或浏览器重启产生新文档身份。driver start 另建 browserSessionId。BFCache 若保留原页面对象，可以保留文档身份；因此「同 ID」只能是比较的必要条件，仍须重新比较 URL、context、规则和全部依赖，不代表业务状态未变。

建议后续另设版本化 `document-bound` 样本，保持 portable 路径原样：

- 键显式绑定 session、browser session、documentId/instanceScope；所有 selector 与目标必须有唯一实例，完整 selector 集相等。不能只比较当前可见项或只比较交集。
- 保留完整 state、规则、已知 context、目标/selector 语义、reviewAttributes、form/record/owner/slot/handler 绑定、结构关系和捕获缺口；同 DOM 换业务绑定必须失败。仅 `instanceId + 现有 shape()` 不足：shape 并不包含全部 reviewAttributes，c11 两个 selector 自身也不带父记录链接。上述新原始证据或另有可审计 owner-binding 比较仍是必要条件。
- unresolved **逻辑身份**不能被清除；若未来允许它作为非目标 selector 的当前物理实例状态，必须明确这是文档局部采样，绝非身份解疑。目标 dispatch、unknown/executing receipt 和原完成门继续独立阻断。最保守第一版可以仅接受已无 hypothesis 的 instance-only selectors。
- 最小消费范围应为真实 succeeded receipt 的同文档 coverage 查询，在原 source/target ownership、实际结果、唯一目标、完整 action value/basis/risk/context 比较后使用。保留原 target-arrival/repetition/recovery API，禁止 fallback 到这一新样本；跨文档/跨 session 一律不匹配。
- 不直接替换 v2/v3 调度键、原 source、attempt/round.tried/route debt；采用显式新 policy 与 evidence 范围，避免仅换编码释放重试预算。先让一个只读对应入口使用它，再决定是否扩展 queue/reconcileCoverage，成本比全局改 branch 默认小。

真实候选 `f23494e8 → 7d2b74b2`、`7d2b74b2 → fd34f210`：同 session/browser/document/rule/context，28 个 selector 全部唯一，当前已捕获的 semantic 字段及 state 相同，标记为 **potential**。尚未证明完整 owner 业务绑定或 operation 等价。`c11 → f234` 必须拒绝：Trade expanded 改变、selector 26→28、多个 selector 语义投影也改变。同文档分层不能关闭旧运行/旧文档来源，也不会自动修复 strict target conditions 或把 unkeyed successes 变为可回放进展。

最小验证应覆盖：同文档稳定帧 + 真实成功 receipt；hidden 非局部模式改变；增删/重复 selector；unknown context/缺状态/critical gap；同 DOM 的 data-record、href、父记录/handler A→B；同 URL 新文档与重启；同文档 URL/context 改变；unknown/executing receipt；portable arrival/repetition 始终仍拒绝。需要新增契约与这些验证后才能实施，本诊断不授予任何覆盖、身份、执行、恢复或 retry release。

复核脚本：[提取与冻结证据验证](selector-condition-diagnosis.py)、[现有纯函数复算与负对照](selector-condition-diagnosis.ts)。前者复用 `plan-growth-extraction.json` 指向的私有提取；若文件过期，先按既有 `plan-growth-extract.py` 重建原始只读材料。没有修改现有报告或原始材料。
