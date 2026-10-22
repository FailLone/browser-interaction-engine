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
CRAWL_VIEWPORT=desktop-edge pnpm crawl OUT_DIR URL   # 视口，见下文
```

## 视口

| 取值 | 尺寸 |
| --- | --- |
| `desktop`（默认） | 1280×800，常见的小笔记本 |
| `desktop-edge` | 页面仍按桌面布局的最窄宽度：读取页面 CSS（含跨域样式表）和脚本 `matchMedia` 里的宽度断点，取 900–1440 之间最小的一个（没有时取 768–900 里最大的），按该宽度重新加载页面；一个都没有时用 1024×768，并在结果里注明 |
| `mobile` | iPhone 15：393×852 屏幕、触摸、移动端 UA、3 倍像素比 |
| `{ width, height, mobile? }` / `WIDTHxHEIGHT[@mobile]` | 自定义尺寸；`mobile` 同时开启触摸、移动端 UA 和 3 倍像素比 |

实际使用的视口（含探测到的断点）记录在第一条 `viewport` 事件和汇总的 `viewport` 字段里。续跑沿用被续跑那次的视口。

## 会话：登录态与 A/B 实验

很多页面要登录后才能用，或者要进入某个实验分组才能看到要测的版本。遍历器只提供通用的会话接口 `SessionProvider`（见 `packages/crawler/src/session.ts`）：

- 每次运行在独立的浏览器 context 里恢复它给出的状态：cookie、localStorage、IndexedDB、设备信息（UA、语言、触摸等），按域名生效的请求头，以及钉住的 cookie。
- 打开页面后、以及运行中每隔一段时间调用它的 `check`；校验失败时以 `session_invalid` 停止，不会在登录页或错误的分组上继续检查。
- 结束时（包括失败）必定调用 `release`。
- 一次运行可以组合多个会话，例如 `[登录, 实验]`。两个会话设置同一个请求头、同一个设备字段（值不同），或都主动设置同一个 cookie 时直接报错，不会悄悄覆盖。唯一的例外：登录快照里恢复出来的同名 cookie / localStorage（通常是站点自己的分桶 cookie）会让位给实验主动设置的值。

会话从哪来、怎么选账号、什么算"已登录"或"已进入分组"，由提供者决定。项目自带两种提供者。

### 登录账号（`@interaction/auth`）

`@interaction/auth` 分两层：通用的账号底座 `Auth`，和决定具体做法的适配器 `AuthAdapter`（见 `packages/auth/src/adapter.ts`）。每个 `Auth` 用一个适配器。

`Auth` 负责与账号来源无关的部分：

1. **加密保存**：适配器给出的会话快照（cookie、localStorage、IndexedDB、设备信息）先校验格式，再用本项目密钥（AES-256-GCM）加密入库。格式不对的不入库。
2. **启用**：导入后先是 `pending`，适配器的 `verify` 通过才变 `active`，并保存验证记录和刷新后的快照。验证时 `Auth` 提供全新的 context（带或不带登录态），用完关闭。
3. **选账号**：按标签（`labels`，由适配器定义，如 `{ site, entity }`）、权限、域名（取自页面）、语言、设备（取自视口）和剩余有效期筛选已启用账号。
4. **占用锁**：同一任务（`task`）的多次运行可以共用一个账号检查多个页面，各自独立 context；其他任务要等全部释放（或锁过期）。
5. **巡检**：打开页面后、以及每隔 `recheckMs` 调用适配器的 `check`；失败即阻止继续检查，适配器返回 `invalidate: true` 时账号退出轮换，需要重新验证。正常结束时保存站点刷新过的存储，但去掉同一次运行里其他会话（如实验分桶 cookie）写入的键。

适配器负责与具体来源和站点有关的部分：

| 方法 | 作用 |
| --- | --- |
| `acquire(input)` | 把一次导入（文件、账号密码、令牌服务……）变成账号：唯一 `key`、`labels`、`permissions`、`domains` 和快照 |
| `verify(account, verifier)` | 证明会话可用；`verifier.open({ withSession })` 打开新页面 |
| `check(page, account)` | 运行中确认页面仍在该账号下 |

```ts
import { AccountStore, Auth, authSessionFactory, type AuthAdapter } from '@interaction/auth';

const adapter: AuthAdapter<{ user: string }> = {
  id: 'my-login',
  acquire: async ({ user }) => ({ key: user, labels: { tenant: 'acme' }, domains: ['.example.com'], snapshot: await loginAndCapture(user) }),
  verify: async (account, verifier) => {
    const page = await verifier.open();
    await page.goto('https://www.example.com/account');
    return { ok: !page.url().includes('/login') };
  },
  check: async page => (page.url().includes('/login') ? { ok: false, reason: 'login_route', invalidate: true } : { ok: true }),
};
const auth = new Auth({ store: new AccountStore('.data/accounts.sqlite'), vaultKey: process.env.SESSION_VAULT_KEY!, adapter });
await auth.import({ user: 'alice' }, { permissions: ['trade'], labels: { environment: 'staging' } });

// 服务端：按名字提供，运行请求里带 { session: { provider: 'login', options: { select: { labels: { tenant: 'acme' } } } } }
new CrawlManager(store, providers, plugins, { login: authSessionFactory(auth) });
// 或直接：new SampledCrawler({ url, session: auth.provider({ select: { labels: { tenant: 'acme' } }, task }) })
```

#### 参考适配器：preset 文件 + 登录心跳（`PresetAdapter`）

对应"从导出工具（如 playwright-auth）导入登录快照、站点有登录心跳接口"的接法，可直接使用，也可作为写适配器的范例：

- **导入**：用导出方的密钥解密 `preset.enc`（格式可替换：`decode`，默认 `sealedJsonPreset`）。`global-eid14` → 标签 `site: global`、`market: global`、`entity: eid14`（`global-hk-eid14` 带市场），命名规则可替换（`parseName`）。站点必须在 `sites` 里，市场和实体必须属于该站点，已有账号的映射不能被改。
- **验证**：打开站点交易页，心跳必须返回 `code: 0`，且没有落在登录路由或其他域名上；不带登录态时同一心跳必须被**明确拒绝**（非 0 的 `code` 或 401/403）。网络失败、非 JSON、缺 `code` 都不算通过也不算拒绝。
- **巡检**：心跳、域名、登录路由、页面语言（`<html lang>`）任一不符即失败；心跳被拒或落到登录页时作废账号。

```ts
import { AccountStore, Auth, PresetAdapter } from '@interaction/auth';

const auth = new Auth({
  store: new AccountStore('.data/accounts.sqlite'),
  vaultKey: process.env.SESSION_VAULT_KEY!,   // 本项目密钥
  adapter: new PresetAdapter({
    presetKey: process.env.PRESET_KEY!,       // 导出方密钥，只用于读 preset
    sites: [{
      site: 'global',
      entities: ['eid14'],
      domains: ['.example.com'],
      environment: 'staging',
      tradeUrl: 'https://www.example.com/trade',
      heartbeat: { url: '/api/user/heartbeat' },  // 可加 headers(page)、classify(response)
      loginRoute: /\/login/,
    }],
  }),
});
await auth.import({ file: 'presets/global-eid14.enc' }, { permissions: ['trade'] });
```

### A/B 实验（`experimentSession`，在 `@interaction/crawler` 里）

把实验分组表示成浏览器状态：

| 选项 | 作用 |
| --- | --- |
| `name`、`variant` | 实验名和分组，记入事件和汇总 |
| `domains` | 生效的域名（`.example.com` 含子域名）；cookie、请求头、localStorage 都只作用于这些域名 |
| `cookies` | 分桶 cookie，如 `{ exp_checkout: 'B' }` |
| `pin` | 默认 `true`：钉住 cookie。服务端 `Set-Cookie` 改回去会立即恢复，页面脚本写 `document.cookie` / `cookieStore` 会被忽略，发出的请求上也强制带指定值。设为 `false` 时只在开始时写入一次，站点重新分桶会被 `check` 发现并停止运行 |
| `headers` | 实验请求头，如 `{ 'x-ab-variant': 'B' }`，只发给 `domains`，第三方脚本、CDN、埋点收不到 |
| `localStorage` | 每个文档加载前写入（只在 `domains` 上） |
| `check(page)` | 证明页面确实是该分组（如读某个 DOM 标记）；默认读回 cookie 和 localStorage 的值 |

```ts
import { experimentSession, SampledCrawler } from '@interaction/crawler';

const variantB = experimentSession({
  name: 'checkout',
  variant: 'B',
  domains: ['.example.com'],
  cookies: { exp_checkout: 'B' },
  headers: { 'x-ab-variant': 'B' },
});
// 登录后看 B 组
new SampledCrawler({ url, session: [auth.provider({ select: { labels: { entity: 'eid14' } } }), variantB] });
```

服务端默认以 `experiment` 的名字提供它（选项即上表，不含 `check`），HTTP 请求里可以组合：

```json
{
  "url": "https://www.example.com/checkout",
  "session": [
    { "provider": "preset", "options": { "select": { "entity": "eid14" } } },
    { "provider": "experiment", "options": { "name": "checkout", "variant": "B", "domains": [".example.com"], "cookies": { "exp_checkout": "B" } } }
  ]
}
```

**续跑**：实验会改变页面内容，所以续跑必须用同样的实验分组（不传 `session` 时沿用原来的会话；传了不同分组会被拒绝），以免把 A 组测过的控件当成 B 组已测。登录账号可以不同。

只靠 query 参数（如 `?variant=B`）分组的实验不需要会话，直接把参数放进网址即可；按用户 ID 在服务端分桶的实验，选一个落在目标分组的账号即可。

## 模型插件

复制 [.env.explorer.example](.env.explorer.example) 到一个被 git 忽略的文件，填好密钥后加载进环境再启动。没有配置时遍历照常运行，只是不调用模型。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/crawl-plugins` | 服务端提供的插件名：`rules`、`sentinel` |
| `GET` | `/v1/crawl-sessions` | 服务端提供的会话提供者名（默认有 `experiment`；登录提供者由宿主注册） |
| `POST` | `/v1/crawls` | 开始一次遍历：`{ url, durationMs?, viewport?, models?, plugins?, session?（一个或多个 `{ provider, options }`）, resumeFrom?, followNavigation?, allowedPaths? }` |
| `GET` | `/v1/crawls` | 运行列表 |
| `GET` | `/v1/crawls/:id` | 运行状态与汇总 |
| `GET` | `/v1/crawls/:id/events?after=&limit=` | 事件：状态、动作、跳转、模型判断、插件结果 |
| `GET` | `/v1/crawls/:id/screenshot?state=` | 状态截图 |
| `POST` | `/v1/crawls/:id/stop` | 停止 |

`resumeFrom` 续跑同一网址的上一次运行，已测过的控件类和模型判断不会重复。

`sentinel` 提供来自 UI Sentinel 规则库的 19 项语义检查与体验审查；另 4 项复用 `rules` 的已有测量。宿主需用 `collect` 绑定当前对象并提供产品语义或观察证据，默认服务未配置该采集器时明确返回 unknown。接入示例、逐项范围与开发步骤见 [UI Sentinel 插件](docs/SENTINEL-PLUGINS.md)。

## 开发

```sh
pnpm typecheck
pnpm test
pnpm lint
pnpm format
pnpm build
```

结构与插件契约见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，设计过程见 [docs/SAMPLED-CRAWLER-PLAN.md](docs/SAMPLED-CRAWLER-PLAN.md)，实测记录见 [docs/experiments/sampled-crawler](docs/experiments/sampled-crawler/README.md)。
