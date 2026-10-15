# 转换表、页脚与顶部导航的真实往返验收

2026-10-15，固定源码 `10fb0c1`，会话 `58ee7f53-813f-4604-85db-048967f83ef8`。本轮继续扩大 [OKX BTC/USD 页面](https://www.okx.com/convert/btc-to-usd)的检查范围，未修改产品代码。三个有限导航样本均由引擎 DFS 执行，目的页只关闭必要提示并原生返回，没有深入目的页业务控件。整页仍未穷尽。

## 独立上层决定与实际结果

所有现场操作均通过通用 workbench 和引擎；`gpt-5.6-sol / low` 独立读取当前材料，分批选择区域、用途和样本，再核对执行结果。没有直接操作浏览器替代引擎，也没有复制旧会话批准。

| A 上的入口 | 上层选择 | 实际到达的 B | B 上实际操作 | 返回结果 |
| --- | --- | --- | --- | --- |
| 转换表 More about USD to BTC | 四条上下文链接中选一条 | `/convert/usd-to-btc` | 原生 Close、history 返回 | BTC/USD 新文档，提示关闭后可继续审阅 |
| 页脚 About us | 54 条目录链接中选一条，同时通过相似列表与区域两个门控 | `/about` | 原生 Close、history 返回 | BTC/USD 新文档，随后重新审阅顶部范围 |
| 顶部 Markets | 以 Main menu 为锚，只显式绑定 Markets 控件 | `/markets/prices` | 原生 Close、history 返回 | BTC/USD 新文档，未继续新业务动作 |

最初划分转换表、Trade 入口和页脚三个范围，未划分控件从 205 降至 146。上层随后暂缓 Trade，将本轮重点留给未测的转换表和页脚；没有重复展开已在先前会话验证过的 Trade/Spot。顶部导航后来选择直接链接 Markets，并仅绑定该控件，没有批准其余 23 个 header 成员。

三条链接都先经过带来源的用途审阅，再读取新的组版本和成员键提交 sample。workbench 对链接的 `navigation_requires_review` 排除没有被绕开；旧的同名 excluded 成员键没有选入。About us 的区域门控和相似列表门控同时批准了同一个当前样本，其余页脚链接未执行。

## 页面策略与返回验证

默认 `pageExploration: review` 在 B 尚无决定时就允许必要退出和返回，无需等外部先提交 skip。三个 B 的 skip 均在实际返回后，针对持久页面组及其当前 revision 提交，分别保留 411、183、420 个未测试成员；这些成员数是历史动作材料，不是已覆盖控件数。

每次 history 都绑定同一浏览器会话中实际观察过的 GET 历史条目，前后 URL 验证通过，留存了 `exploration.page_returned` 事件和 `stateRestored: false`。没有猜测 URL 导航、服务器重置、历史检查点恢复或目的页深度操作。

返回 A 时实际重新加载了文档。旧区域和全部五条用途审阅均失效；随后基于新 A 的材料重新划分页脚、重新审阅 About us，再重新划分并审阅 Markets。返回不会自动复活旧批准，也不证明滚动位置、金额、服务器状态或完整 UI 已恢复。

全程 14 次动作：初始 Close 一次、三个导航样本、三个 B Close、三次 history、三个返回后的 A Close，以及一次 Escape。全部派发状态为 `succeeded`，但 Escape 后边界仍在，不能算关闭成功；后续原生 Close 才验证边界消失。第二、第三次往返没有重复这次无效 Escape。

Markets 目的页标题为 `Cryptocurrency Prices, Market Cap & Charts | OKX`；关闭提示后的观察仍有 `stable: false` 和动态内容缺口。因此仅确认到达、必要退出和返回，不断言行情页面稳定、行情内容正确或业务流程通过。

## 证据与验证

- [可复核摘录](okx-acceptance.json)包含 24 次观察、14 次实际动作、区域与样本决定、原生历史依据、页面返回事件、审阅失效记录、11 批上层决定及最终独立核验。
- [核查脚本](verify-okx.py)校验每条链接的 DFS 来源、单样本和重叠门控、B 操作范围、GET 返回依据、重新加载后的批准失效、Escape 未关闭事实与剩余缺口。也可检查原始文件哈希。
- 原始目录为忽略目录 `work/exhaustion-goal/run-12`，会话已关闭；起止源码版本和 216 个源码/测试/配置文件哈希一致。
- 本轮只新增实测证据和文档，未重跑产品全量回归。冻结源码继承上一轮的 582 项测试、typecheck、build、smoke:built 通过记录，见[上一轮验证](../scope-traversal-2026-10-15/README.md)。

```sh
python3 docs/experiments/navigation-samples-2026-10-15/verify-okx.py
python3 docs/experiments/navigation-samples-2026-10-15/verify-okx.py --raw-root work/exhaustion-goal/run-12
```

最终 `completionAudit` 仍为 `blocked / exhaustive: false`。当前 A 有 205 个控件未划分、页面滚动未归属，另有 15 个 pending 相似列表组，结构扫描、Canvas 和事件监听发现缺口继续保留。205 是最后一次新文档的当前待审数量，不能与此前 146 相减解释为历史覆盖丢失。最后一次探索暂停原因保留为 `PAGE_DECISION_REQUIRED`；随后已将三个目的页组全部设为 skip，并未再次启动探索，该旧原因不代表仍有未决 page 组。

本轮未发现阻止这三个获批样本往返的新程序缺陷。下一步重点是普通区域/分支的条件复用与必要证据验证，以及返回后重新审阅的成本；同时继续扩大尚未审阅的范围。不能为减少审阅次数直接沿用旧文档的 localId、动作键或批准。
