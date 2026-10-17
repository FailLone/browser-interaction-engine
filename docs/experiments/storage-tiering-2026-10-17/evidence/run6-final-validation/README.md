全量执行记录保持原样：191 文件、2100 项，2098 通过，2 项 UI history 失败；两者 pageerror 均为浏览器访问 node:crypto.createHash。root/core 类型检查随后通过。

该运行开始于125a10c，中途与 UI 纯函数提取重叠，sourceUnchanged=false，恰有4个路径变化。源码前459份与125a10c逐个Git blob匹配，后461份与d103747逐个匹配，核验见 interpretation.json；原source-after的revision字段是runner保存的起始版本，不代表内容仍属于125a10c。不得改称固定最终版本全套全绿。

UI修复没有改任何旧断言，13个既有函数体逐字一致。修复后独立重跑42项专项、整个11项UI历史测试及类型检查全部通过；d103747独立archive的build、发布类型、编译契约、API及Explorer UI实操全部通过，487输入不变。80协议在编辑前完成、459源文件不变，单独归档。没有再次完整重跑本套件，也不把多个重叠测试集合相加成独立总数。

原完整失败日志、source-before/after、verification保留；所有测试仅用自有local fixture，不操作原真实资源。
