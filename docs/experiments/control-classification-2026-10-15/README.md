# OKX 当前候选分类验收

本阶段在新 `run-05` 会话加载 https://www.okx.com/convert/btc-to-usd，由用户指定的 `gpt-5.6-sol / low` 独立判断。工作台源码在启动、测试及真实执行期间固定，67 个运行源码文件摘要随 [acceptance.json](acceptance.json) 保留。实际浏览器操作仍全部经过引擎，没有直接 DOM 点击或状态修改。

上游先审阅地区提示中当前可见的 Close。引擎执行成功，后观察验证弹层消失、URL 仍为入口 A。没有操作“7 天不再提示”、钱包链接或其他背景控件。前后画面为 [modal.png](modal.png) 和 [entry-classified.png](entry-classified.png)。

随后[上游分类](upstream-classification-decision-02.json)提交 5 项判断，并通过现场校验和提交后的重新观察，全部仍 active：

| 候选 | 上层分类 | 实际结果 |
| --- | --- | --- |
| Home 面包屑外层 div | container | 只解释包装节点；内部 Home 链接保留独立支持能力、导航审阅要求和未执行状态 |
| Calculator 面包屑外层 div | container | 同上，内部 /convert 链接保留 |
| 4.7 评分 | probe_required | pointer 和截图不足以区分显示与入口，未自动探测 |
| 聊天浮标 | interaction | 保留上层对用途的解释，未产生动作或打开聊天 |
| 页脚候选 | unresolved | 子树材料截断且事件用途未知，禁止负向分类，继续未决 |

没有候选被强行归为 display。未知候选从 35 降到 33，containers 从 0 增为 2；支持控件仍为 203，执行覆盖仍为 1，实际动作仍只有一次 Close。两个包装节点原本没有动作，**此次分类没有退役它们的动作**。报告中的两条退役记录来自此前已关闭弹层的 Close click / Escape 退出意图，理由都是 boundary_already_exited。

[最终独立复核](upstream-verification-03.json)未发现问题。原分类源观察在关闭会话后的 SQLite 中逐项比较仍相同，新增后观察有独立 ID。运行源码摘要保持一致，数据库摘要、分类记录、选定节点及子链接、唯一实际尝试、覆盖统计和完整动作审计均保存在验收 JSON；运行 `python3 verify.py` 可复核主要断言。

整页仍为 blocked / exhaustive:false：159 条动作等待范围决定、15 条待执行、28 条阻塞；观察限制未被分类清除。这个实验验证当前候选解释与材料保留，不证明整页发现完整、所有候选已分类或服务器状态正确。下一步继续补结构扫描缺口定位及有界补采；主动探测和其他开放 roadmap 项保持未完成。

本阶段新增 24 项分类回归，完整 62 个测试文件 / 436 项全部通过，见 [full-tests.log](full-tests.log)。typecheck、build、smoke:built 均通过；[构建验证](build-smoke.json)保留产物实测结果，[调试页截图](dashboard.png)验证分类统计与执行覆盖分开呈现。
