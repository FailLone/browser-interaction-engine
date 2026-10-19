# 浏览器交互遍历

输入一个网址，像真实用户一样把当前页面的交互状态遍历出来：弹窗、菜单、popover、提示、输入、hover 等。同类控件只抽样几个，价格等实时数据不算新状态，跳转会被拦截并记录，不会离开页面。程序判断不了的问题（控件是否值得点、动作效果、输入框类型）交给可选的模型插件：先问 JEV，必要时用 LLM。

UI 检查（文字截断、遮挡、裁切、图片、文字与背景同色等）以**插件**形式在每个新状态上运行；遍历器核心不依赖它们。

## 启动

需要 Node.js 24 和 pnpm 10。

```sh
pnpm install --frozen-lockfile
pnpm browser:install
pnpm demo
```

| 地址 | 用途 |
| --- | --- |
| http://127.0.0.1:5173 | 遍历界面：发起、停止、续跑，查看动作、状态截图和插件结果 |
| http://127.0.0.1:4174 | 本地测试站（含规则夹具页，如 `/rule-defects.html`） |
| http://127.0.0.1:4173/v1/health | HTTP API |

只启动 API：`pnpm dev`。命令行直接跑一次遍历：

```sh
pnpm crawl OUT_DIR URL [DURATION_MS]
```

## 模型插件

复制 [.env.explorer.example](.env.explorer.example) 到一个被 git 忽略的文件，填好密钥后加载进环境再启动。没有配置时遍历照常运行，只是不调用模型。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/crawl-plugins` | 服务端提供的插件名（`rules`、`checks`） |
| `POST` | `/v1/crawls` | 开始一次遍历：`{ url, durationMs?, models?, plugins?, resumeFrom?, followNavigation?, allowedPaths? }` |
| `GET` | `/v1/crawls` | 运行列表 |
| `GET` | `/v1/crawls/:id` | 运行状态与汇总 |
| `GET` | `/v1/crawls/:id/events?after=&limit=` | 事件：状态、动作、跳转、模型判断、插件结果 |
| `GET` | `/v1/crawls/:id/screenshot?state=` | 状态截图 |
| `POST` | `/v1/crawls/:id/stop` | 停止 |

`resumeFrom` 续跑同一网址的上一次运行，已测过的控件类和模型判断不会重复。

## 开发

```sh
pnpm typecheck
pnpm test
pnpm lint
pnpm format
pnpm build
```

结构与插件契约见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，设计过程见 [docs/SAMPLED-CRAWLER-PLAN.md](docs/SAMPLED-CRAWLER-PLAN.md)，实测记录见 [docs/experiments/sampled-crawler](docs/experiments/sampled-crawler/README.md)。
