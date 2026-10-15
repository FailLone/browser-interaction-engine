# OKX 复合控件与引擎探测验收

2026-10-15，页面 `https://www.okx.com/zh-hans/convert/btc-to-usd`，分支 `fix/identity-disambiguation`，观察规则 `observable-v5`。可重复脚本为 [validate-components-okx.ts](../../../scripts/validate-components-okx.ts)：

```sh
pnpm exec tsx --conditions=development scripts/validate-components-okx.ts work/components-okx/fresh-run
```

本次 14 次动作均经引擎 execute/probe 执行，产生 15 次观察；没有用外部 Playwright 点击、填写或移动鼠标替代引擎，没有点击评分按钮。结果投影见 [audit.json](audit.json)，原始大块数据在本地 `work/components-okx/2026-10-15-verified/`，其校验值保存在 audit 中。

## 选择器流程

引擎从“定位子面板 + 列表语义 + 同级标题”的通用关系发现 BTC 入口，并标记为 tentative。打开后，搜索框和内部列表处于同一边界；填写 ETH 成功，父页面仍受阻。

再次点击入口和 Escape 均执行成功，但没有使该站点的面板关闭。引擎保留边界，未把动作成功当作退出成功。随后搜索 BTC、选择原币种；站点导航并重新出现地区提示。验证旧列表已消失，关闭新提示后，父页面金额填写 2 成功。完整过程全部由引擎执行，不能将此结果写成“再次点击入口即可关闭”，也没有证明无选择取消的路径。

## 五星评分

程序只产生一个 tentative `choice-group`，其中五个未命名按钮各自保留 localId、identityId、点击动作和身份假设，观察成员没有虚构 value。依次对这五个当前实例发出显式 hover：

| 探测成员 | 已保存 DOM 中实心星数量 |
| --- | --- |
| 第一个 | 1 |
| 第二个 | 2 |
| 第三个 | 3 |
| 第四个 | 4 |
| 第五个 | 5 |

这里的数量来自审计脚本解释所保存图标 class，站点规则不进入引擎。各次证据见 [probe-evidence.json](probe-evidence.json)，含 observationId、节点属性、截图引用和区域。外部程序据此提交 [description.json](description.json)：rating、成员值 1～5、`source: behavior-audit`，引用五次实际观察。该解释单独保存，不覆盖分组事实、不合并按钮身份，也不推断点击提交的服务器效果。

初始观察 296 个控件、当前 pending 5；关闭提示后通常为 287 个控件、pending 5。选币导航后短暂出现 pending 6，关闭新提示后恢复 5。评分探测结束仍为 5；没有以清空 pending 为目标制造身份确定性。此轮验证了当前实例的组关系和悬停含义，没有再次进行模型盲测，也未声称跨刷新按钮对应已解决。

## 回归边界

本地测试覆盖 API/SDK 同构、实际图片引用、过期身份判断和重绑定、分组不合并身份、显式值、当前观察解释、非法成员/引用、历史证据释放、hover/focus 的前后记录与预算/幂等、重建目标拒绝、弹层边界，以及跨刷新等价状态不使用组件实例 ID。调试界面通过公共只读接口展示组和局部截图，查询不新增动作或观察。

能力范围和调用契约见 [复合控件与探测](../../COMPONENTS-AND-PROBES.md)。Canvas、iframe/Shadow DOM、未枚举监听器、通用视觉语义和任意自定义组件仍有覆盖缺口；这次没有遍历登录、交易、全部币种或全站导航。

验证记录：完整回归 37 个文件、200 项通过；最后补充 SDK 排队输入快照及探测规则覆盖后，相关 12 项定向回归通过（当前项目共 201 项测试）。`pnpm typecheck`、`pnpm build` 通过。构建产物冒烟另行覆盖组件 HTTP 查询、外部描述、hover 前后证据与重复 requestId。
