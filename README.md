# dsh-web-pin-auth

> CI：`test`（语法 + 单测 + 上游契约自检 + 打包校验）；`lib/` 即源码，直接从 `main` 或 commit SHA 安装，不需要 `pkg` 分支。

替换 `dsh web` 的浏览器鉴权（launch token + 签名 cookie）：可以用一个**自选的固定 token**（查询参数或请求头）代替每次启动都会变的进程 token，也可以完全关掉鉴权。两种模式都保留 Host/Origin 栅栏。

> ⚠️ **安全提示**：开放模式下，任何能连到该端口、且通过 Host/Origin 校验的浏览器都会获得 **owner（你）的完整权限**——聊天、工具调用、读写文件、执行 shell。固定 token 模式则把这个门槛换成一个自选口令，请用足够长的随机值。两种模式都只应在可信内网使用。

## 它做了什么

`dsh web` 启动时会生成一次性 launch token，打印成 `?token=` 链接，并把它换成带签名的 cookie；之后前端首页、每个 `/api` 请求和 WebSocket 升级都要校验这个 cookie。本插件只替换 Connection 里的浏览器鉴权判定，按配置分成两种模式：

**开放模式**（`enabled: true` 且不配置 `token`）：

- `browserAuth.isAuthenticated()` → 始终通过（浏览器 cookie 不再必需）
- `browserAuth.authorizeIndex()` → 直接放行首页；带 `?token=` 的旧链接会 303 跳到干净地址
- `browserAuth.authorizeConnect()` → `/connect` 不再要求 token（服务端自动补上进程 token）

**固定 token 模式**（配置 `token: <secret>`）：

- 保留原有的 cookie 校验，`isAuthenticated()` 只额外接受正确的 token
- `authorizeIndex()` / `authorizeConnect()` 把 `?token=<secret>`（或 `Authorization: Bearer` / `X-DSH-Token`）改写成当前进程 token，再交给原逻辑，于是照常 303、下发签名 cookie
- 不带 token / 带错 token 的请求仍然 401

**保留**的行为：

- Host/Origin 信任栅栏（`isTrusted`）：不受信任的 Host / 跨站 Origin 仍然返回 403（防 DNS rebinding）
- 进程销毁后的请求仍然 401
- 通过 `/connect` 换到的独立 API operator（v2 cookie）仍然拥有自己的 Peer
- 不影响任何模型凭据 / API key / 订阅登录

## 安装

插件以 bundle 方式从 GitHub 安装（`lib/` 就是源码，不需要构建）：

```sh
dsh plugin --profile web add -w --ignore-scripts github:Yiklek/dsh-web-pin-auth#main
```

- 安装完成后确认 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里有 `dsh-web-pin-auth`；个别情况下 pnpm 的 reconcile 会漏掉，手动补进数组即可。
- 本仓库不打 tag；需要可复现安装时把 `#main` 换成 commit SHA：`github:Yiklek/dsh-web-pin-auth#<sha>`。
- 更新：`dsh plugin --profile web update -w --ignore-scripts dsh-web-pin-auth`，然后重启 `dsh web`。
- fork 到别处时把 `Yiklek` 换成你自己的 owner。npm 上还没有发布。

`package.json` 的 `files` 已决定安装内容（`lib/`、两个 patch、README、LICENSE、manifest），`test/`、`.github/` 不会进包。

## 配置模式

插件**默认是关闭的**：安装包自带的 `cordis.patch.yml` 里是 `enabled: false`，所以装完不会改变 DSH 的任何行为。必须由部署方显式写 `enabled: true` 才会启用，然后再选开放模式还是固定 token 模式。

要切换模式，就写 profile 的 patch 层：

```text
~/.dsh/profiles/web/cordis.patch.yml
```

> ⚠️ patch 会**替换整行 `config`**，所以下面每一段都要把 `enabled` / `keepApiOperators` 一起写全，不能只写 `token`。

### 开放模式（`enabled: true`，不配 token）

```yaml
- id: web-pin-auth
  config:
    enabled: true
    keepApiOperators: true
```

效果：直接打开 `http://<HOST>:<PORT>/`（或反代域名）即可，匿名请求也放行；Host/Origin 栅栏仍生效。

### 固定 token 模式

```yaml
- id: web-pin-auth
  config:
    enabled: true
    keepApiOperators: true
    token: 'REPLACE_WITH_A_LONG_RANDOM_SECRET'
```

生成一个安全的 token：

```sh
openssl rand -hex 32
```

不想把明文写进文件，可以用环境变量（在启动 `dsh web` 的 shell 里先 `export DSH_WEB_TOKEN=...`）：

```yaml
    token: !!js process.env.DSH_WEB_TOKEN
```

> 注意：环境变量没设上时 `token` 是 `undefined`，插件会**退化成开放模式**（完全免 token）。不确定环境变量一定存在的话，不要用这种方式。

token 的三种携带方式，**任一正确即可**：

| 方式 | 示例 |
|---|---|
| 查询参数 | `http://<HOST>:<PORT>/?token=<secret>`（303 + 下发 cookie） |
| Bearer 头 | `curl -H 'Authorization: Bearer <secret>' http://<HOST>:<PORT>/api/...` |
| 自定义头 | `curl -H 'X-DSH-Token: <secret>' http://<HOST>:<PORT>/api/...` |

- 首页 `/` 用查询参数或头都能换到签名 cookie；头方式会先补上 token 参数，再走原逻辑。
- `/api` 和 WebSocket 用头 token 直接放行，不需要先换 cookie，适合脚本/CLI。
- 之后浏览器仍用 cookie；书签和脚本里的固定 token 重启后依然有效。
- `/connect` 同样接受查询参数或头。
- 反向代理（如 Traefik）给**每个请求**注入 `X-DSH-Token` 时：首次请求 303 换 cookie，之后凭 cookie 直接 200，不会循环重定向。

### 不启用 / 关闭插件（恢复 DSH 原生行为）

```yaml
- id: web-pin-auth
  config:
    enabled: false
```

这也是**默认状态**：插件仍会加载但不改动鉴权，`dsh web` 恢复成启动时打印 `?token=` 链接的原生行为。

### 字段表

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | **必须显式写 `true` 才启用**；其它值（缺省、`false`、字符串 `"true"`）都视为关闭 |
| `token` | 未设置 | 非空字符串即进入固定 token 模式；接受 `?token=`、`Authorization: Bearer`、`X-DSH-Token` 任一匹配；留空等于未设置（开放模式） |
| `keepApiOperators` | `true` | 仅开放模式生效：`/connect` 换来的 v2 operator cookie 仍走独立 Peer；设为 `false` 时所有请求都折叠成浏览器 Peer |

装完先确认 `enabled: true` 已经写进 profile 的 patch，否则插件不产生任何效果。改完 `cordis.patch.yml` 后，运行中的实例通常 **10 秒左右热加载**；没有生效就重启 `dsh web`。

## 使用与验证

### 开放模式

```sh
# 首页：应返回 200 HTML（不是 401）
curl -s -o /dev/null -w '%{http_code}\n' http://<HOST>:<PORT>/

# 跨站 Origin 仍被拒绝：应返回 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Origin: http://evil.example' http://<HOST>:<PORT>/api/rpc
```

直接用 `http://<HOST>:<PORT>/`（或 `--trusted-host` 里声明的域名）打开界面即可，手机、平板、其它电脑都不需要 token 链接。

### 固定 token 模式

```sh
# 不带 token：应 401
curl -s -o /dev/null -w '%{http_code}\n' http://<HOST>:<PORT>/
# 查询参数：应 303（并下发 cookie）
curl -s -o /dev/null -w '%{http_code}\n' 'http://<HOST>:<PORT>/?token=<secret>'
# Bearer 头：应 303
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer <secret>' http://<HOST>:<PORT>/
# 头 token 直连 API：应 404（已过鉴权；无 token 是 401）
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-DSH-Token: <secret>' http://<HOST>:<PORT>/api/
```

浏览器打开 `http://<HOST>:<PORT>/?token=<secret>`，服务端换 cookie 并 303 到干净地址；之后正常使用。

注意：

- token 用常量时间比较；但它仍会出现在 URL、浏览器历史和可能的访问日志里，建议用书签或让脚本带上。
- cookie 由持久签名密钥签发（默认 30 天），**换 token 不会让已签发的 cookie 失效**；要立刻收回某台设备，得清掉它的 `dsh-auth-*` cookie。
- token 值不要提交进仓库（`cordis.patch.yml` 本来就在 profile 的 `.gitignore` 里）。

## 卸载

```sh
dsh plugin --profile web remove -w --ignore-scripts dsh-web-pin-auth
```

然后确认 `dsh.profile.bundles` 里已无 `dsh-web-pin-auth`，重启 `dsh web`。插件会通过 Cordis 的 disposer 还原被替换的鉴权方法。

## 实现与兼容性

- 插件是标准 Cordis 插件：`export const name` / `inject = ['connection']` / `apply(ctx, config)`。
- 通过 `ctx.connection.browserAuth`（Connection 服务的公开字段）替换鉴权方法，不修改 DSH 安装目录。
- 日志：开放模式打印 `browser token authentication is disabled; ...`，固定 token 模式打印 `fixed token enabled; ...`（都不会打印 token 本身）。
- 已验证：在隔离的 `DSH_HOME` 中从官方 `web` 模板启动——未挂载插件时 `GET /` 与 `/api/` 均 401；开放模式下 `GET /` 为 200、`/api/remote.mux` WebSocket 升级为 101、`/connect` 无 token 返回 302、跨站 Origin 仍 403；固定 token 模式下匿名 401、`?token=` / Bearer / `X-DSH-Token` 均为 303、带 cookie 后 200（反代每请求注入头也不会循环）。

## 兼容性风险

DSH 目前没有公开的「关闭浏览器鉴权」开关，本插件替换的是 Connection 内部的 `BrowserAuth` 方法名（`isAuthenticated` / `authorizeIndex` / `authorizeConnect`）。DSH 升级后若这些方法改名，插件会打印 `unrecognized Connection implementation` 并保持原行为（安全失败），届时需要按新版实现调整 `lib/index.js`。

## CI 与打包

`.github/workflows/ci.yml` 只有一个 `test` job（push / PR / 手动触发）：

1. `node --check lib/index.js`
2. `node --test`（Node 的测试发现会扫 `test/**/*.test.mjs`）
3. 安装钉住的 DSH，跑上游契约自检 `scripts/compat-check.mjs`
4. `npm pack --dry-run` 检查发布内容
5. 把打出来的 tarball 装进空项目并 `import`，验证 `files`/`exports`/`main` 组合没坏

- `DSH_VERSION` 只在 workflow 顶部 `env` 出现一次，锁定在 `0.2.2-rc.1`。契约自检断言这个确切的 DSH 构建仍暴露 `BrowserAuth.isAuthenticated/authorizeIndex/authorizeConnect` 和 `connection.browserAuth` 字段；上游改名时 CI 变红，而不是插件静默失效。
- **为什么没有 `pkg` 分支**：参考的 `dsh-slots-manager` 的 `lib/` 是 esbuild 产物且被 gitignore，`main` 上没有可安装内容，才需要一条已构建的分支。本插件的 `lib/` 就是源码并已提交，`main`/commit SHA 直接可装，`files` 白名单也已经在安装时做掉了发布裁剪。以后若引入构建步骤（`lib/` 变成产物），再补一个 `pkg` job 即可。

## 开发与测试

- 单元测试：`npm test`（等价于 `node --test`），覆盖默认关闭（未显式 `enabled: true` 时不做任何替换）、开放模式匿名放行、`/connect` operator 保持独立、`?token=` 相对跳转、固定 token 的改写/错误 token 保持原样、反代注入头不循环、禁用开关、两种模式的卸载还原。
- 示例里的 `http://<HOST>:<PORT>/` 是占位符，按你的部署替换。
