# 程序优先探索：冻结版本验收

产品代码冻结于 `34c80e3be7e7fc447b94770e457d10f54cf5e2f4`。两次完整本地验收及三次真实 OKX 运行已通过。最终251项回归为206通过、45失败，失败文件与完整测试名称逐项匹配既有基线，没有新增失败。所有约定验收完成。

实现采用“程序先执行已获授权、当前可执行的工作；具体分类或操作歧义再按需问模型”。原始未完成目标、源观察、路径、实际回执和未知覆盖义务均保留。主要机制和边界见 [IMPLEMENTATION.md](IMPLEMENTATION.md)。

## 同一冻结代码的结果

| 运行 | 耗时 | 计数命令 | 实际浏览器执行 | 严格原始子动作链 | JEV / LLM |
| --- | ---: | ---: | ---: | ---: | ---: |
| OKX13，纯程序 | 217.402 秒 | 14 | 13 | 1，通过 | 0 / 0 |
| OKX14，独立纯程序复验 | 220.642 秒 | 14 | 13 | 1，通过 | 0 / 0 |
| OKX15，已配置模型、按需调用 | 220.135 秒 | 14 | 13 | 1，通过 | 0 / 0 |
| 历史13e13e5，Node24/v5匹配对照 | 117.096 秒 | 80 | 28 | 当前严格审计 API 不存在 | 0 / 0 |

三次新版本运行的492个源文件哈希完全相同，源代码差异均为空，调用方范围、240秒/80次总预算、210秒协作停止点、10秒采集窗口及执行策略一致。启动、恢复和失败命令均计数。与本地验收共享的492个文件也逐个相同。见 [冻结比较证明](evidence/frozen-comparison.json)。

完整本地验收 local9 / local10-confirmation 分别耗时51.940 / 49.533秒，各34次计数命令；均覆盖原协议23个独立分支、37/37项有限源义务、两条严格链。真实进程重启后继续15个原始待办，已完成回执保留，剩余和重复完成均为零。498个源文件逐个相同。见 [本地证据](evidence/local-final.json) 与 [包括local7/8的源比较](evidence/local-source-comparisons.json)。

## 严格链和未完成范围

三次实际链均保留原始“闪兑”点击目标：在最初展开时发现但尚未完成，进入现货页后不再可见，实际历史返回，重新执行记录的原菜单入口，通过SDK独立匹配原目标，再实际点击该原始子动作并持久验证完成；独立DOM导航证据匹配目标地址。原待办、源路径绑定、实际入口、原目标到达、不同的后续子动作、持久完成和独立导航七项检查全通过。原入口回执的六项检查也全通过。原始ID、源观察、入口和子动作回执、哈希见 [三次真实完整证据](evidence/okx-final.json)。

本地审计、OKX审计和原始子目标路径绑定审计三个文件均与起始版本a7f25f9逐字相同，见 [审计器完整性](evidence/auditor-integrity.json)。历史失败没有改写为成功；run12只是较早版本上的首次断点通过，最终冻结验收使用run13–15。

这不是整个网站穷尽声明。三次OKX账本分别为6/638、6/676、6/682项已验证，其余632、670、676项保留未完成；未知JavaScript依赖、条件组合、自由输入和业务效果仍未证明。实际执行成功不等于有限源条件完成。任务中的paused/user_paused来自预先声明的210秒停止机制，并非用户要求暂停本次实现工作。

“7天内不再提示”在三次运行中均有实际成功执行，前后捕获的checked值确为false→true。该操作的源条件仍显示source_operation_unassessed，未伪造覆盖证明，也未推断七天持久化、全局存储效果或可逆性。

## 吞吐和成本

| 运行 | 首次实际执行 | 可读目标样本数 | 捕获状态ID数 | 采集次数 / 总耗时 | 目标对应批次 / 总耗时 |
| --- | ---: | ---: | ---: | ---: | ---: |
| OKX13 | 14.308 秒 | 9 | 13 | 25 / 91.236 秒 | 52 / 3.438 秒 |
| OKX14 | 14.220 秒 | 9 | 13 | 25 / 91.824 秒 | 52 / 3.478 秒 |
| OKX15 | 14.114 秒 | 9 | 13 | 25 / 90.709 秒 | 52 / 3.510 秒 |
| 历史匹配对照 | 8.742 秒 | 16 | 23 | 84 / 84.385 秒 | 无当前API / 未测 |

可读样本采用URL、标签、操作、值元组，仅用于解释吞吐，不是SDK身份或有限覆盖。版本间状态归一化不同，状态ID数量也不能直接比较覆盖。采集与对应检查是已测时间段；其余耗时包含调度、持久化、派发、其他匹配及审计，未归因于单一模块。

新版本每次13次实际执行包含7次点击、3次悬停、2次历史恢复、1次勾选。菜单入口点击和悬停各出现3次；重复悬停不计作新的原始点击覆盖。历史版本实际执行28次，其中11次点击、16次滚动、1次勾选；两种同页同语言控件滚动各重复7次。另有51次授权边界拒绝和1次达到预算后的拒绝。80次计数命令包括启动及79次已计数派发；最后一次预算拒绝没有触发浏览器。

旧版原始吞吐更高、首次执行更快。新版本本次证明的是可审计原始子动作续测，尚未显示吞吐优势。历史版本58个产品文件与原提交逐字一致，模块连接指向其自己的源码；只在外部运行包装中加入相同授权边界和计时记录。旧版缺少当前原始源回执API，严格链标为不可评估，不能报成已审计的零条。见 [历史证据](evidence/historical-final.json)。此前368次动作记录使用24小时/10000次配置，不作为此次同预算对照。

## 模型收益

真实OKX按需模型运行已加载JEV和LLM配置，但在预算窗口内没有进入新的具体缺口处理阶段，故请求、模型耗时、可验证新增执行收益都为零。没有调用意味着本次未验证远端可用性，也不能宣称模型提高了覆盖率或速度。

受控提供者的真实浏览器测试另行验证模型路径：一个具体操作缺口在已有动作和实际悬停之后发起1次请求，SDK接受审查后，后续实际点击产生1个条件验证通过的回执。无结论、离线和超时均无点击增益。独立缺口截止测试在约12.011秒取消，仅1次请求；同证据重新采集和任务序列化恢复后不重复发问。纯结构未知不触发模型。所有模型提议仍回到SDK验证，未知义务保留。见 [六个场景和记录](evidence/model-gap-fixture-summary.json)。

## 测试与最终核验

最终相关测试42/42通过：16项真实程序导航、6项具体模型缺口、20项提供者测试；两套TypeScript检查通过。此前同一原始源/原生引用/回执修复的120项相关测试全部通过，之后这些SDK实现未再改变。

最终11个既定回归文件共251项：206通过、45失败。按文件名和完整测试名比较，45项与既有stage2-broad-8基线完全一致；新增失败和修复旧失败均为零。这不是“所有测试通过”。见 [逐项比较](evidence/broad-final-summary.json) 和 [完整回归JSON](evidence/broad-final.json.gz)。

交付前再次核对498个源文件均与冻结时相同，三次实际运行的全部严格链/入口检查及原预算均成立；两次完整本地的23分支、37义务、两链、重启15原待办、零重复/剩余仍全部成立。见 [最终核验](evidence/delivery-verification.json)。

## 失败记录和复现

[15次真实运行记录](evidence/run-history.json)保留每次版本、协议、结果和原始证据哈希。run1/2是程序调度与原入口续测问题；run3被中止，不作为验收；run4–7暴露导航采集和文档方法绑定问题；run8/9暴露返回及原入口优先级问题；run10缺少原始揭示源并有操作对应差异；run11原始点击已执行，但源身份回执不能通过，审计不可用；run12首次断点通过；run13–15为最终冻结验证。详细诊断和修复顺序保存在[检查点](CHECKPOINT.md)。

运行环境为Node24.22.0，命令均从本工作树根目录执行。输出目录必须不存在。模型配置文件使用已有本地文件，报告不包含其内容。

```sh
export PATH=/Users/xietian/.local/share/fnm/node-versions/v24.22.0/installation/bin:$PATH
MODELS_ENV=/Users/xietian/.codex/worktrees/autonomous-exploration/browser-interaction-engine/.env.explorer.local
node --env-file="$MODELS_ENV" scripts/local-loop-acceptance.mjs .data/program-first/repro-local
node --env-file="$MODELS_ENV" scripts/local-loop-acceptance.mjs .data/program-first/repro-local-confirmation
node scripts/finite-okx-acceptance.mjs .data/program-first/repro-okx program-only
node scripts/finite-okx-acceptance.mjs .data/program-first/repro-okx-confirmation program-only
node --env-file="$MODELS_ENV" scripts/finite-okx-acceptance.mjs .data/program-first/repro-okx-model program-model
node docs/experiments/program-first-exploration-2026-10-18/historical/run-legacy.mjs .data/program-first/repro-historical
python3 docs/experiments/program-first-exploration-2026-10-18/summarize-run.py .data/program-first/repro-okx
```

历史命令读取已保存的.data/program-first/legacy-13e13e5原始归档和单独包装程序。所有原始运行目录保留在本工作树.data/program-first中；关闭后才进行只读汇总，需解码观察时使用已关闭数据库的副本。产品冻结之后仅更新文档和派生报告，未改动产品、测试、协议或严格审计器。
