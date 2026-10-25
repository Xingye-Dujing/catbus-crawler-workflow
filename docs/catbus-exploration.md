# catbus 项目探索总结

> 本文是对 catbus 仓库源码、文档、测试与平台实现的一次系统性阅读笔记，不是项目规范。
> 项目规范以 `AGENTS.md` 为准；能力矩阵以 `docs/capabilities.md` 和注册表为准。
>
> 整理时间：2026-10-25

---

## 0. 结论摘要

catbus 不是浏览器自动化工具，而是一个**浏览器请求重放引擎**。

它把平台前端做过的事情在 Node 里重新实现：

1. 建立登录态与设备状态；
2. 计算平台要求的签名；
3. 按浏览器实际抓包的请求头顺序、Cookie 顺序、TLS/HTTP2 指纹发请求；
4. 解析 JSON、JSONP、SSR HTML 或 protobuf；
5. 归一化成统一字段；
6. 用不透明游标翻页。

因此它有几个明显特征：

- **快**：不启动浏览器，不渲染页面；
- **结构化**：直接拿平台给前端的数据，不解析 DOM；
- **统一**：11 个平台共用同一套信封、字段和错误码；
- **脆弱**：强依赖逆向签名，平台前端发版后可能需要同步更新；
- **会话独立**：登录态在 `~/.catbus`，不直接复用浏览器的 Cookie 或 profile；
- **只有 CLI**：没有 HTTP 服务，也没有 Python SDK；
- **只有 web 端**：app / pc 端在注册表里是 planned。

---

## 1. 项目定位与边界

### 1.1 定位

catbus 是“一个 CLI，操作各大平台接口的统一入口”。

- 命令：`catbus`
- npm 主包：`catbus-cli`
- 数据目录：`~/.catbus/`，可用 `CATBUS_HOME` 覆盖
- 输出：stdout 只输出 JSON 或 JSONL，日志和提示走 stderr
- 登录态：按平台 × 端 × 账号隔离

### 1.2 支持平台

| 规范 id | 平台 | 别名 |
|---|---|---|
| `xhs` | 小红书 | `xiaohongshu`、`rednote` |
| `douyin` | 抖音 | `dy` |
| `tiktok` | TikTok | `tt` |
| `bilibili` | B 站 | `bili`、`b` |
| `kuaishou` | 快手 | `ks` |
| `weibo` | 微博 | `wb` |
| `xianyu` | 闲鱼 | `goofish`、`xy` |
| `taobao` | 淘宝 | `tb` |
| `jd` | 京东 | `jingdong` |
| `x` | X / Twitter | `twitter` |
| `12306` | 12306 铁路 | — |

各平台注册表声明的命令数（含 core 自动注册的 `auth` 命令，按 `src/platforms/<p>/index.ts` 统计）：xhs 67、douyin 67、tiktok 70、bilibili 74、kuaishou 68、weibo 64、xianyu 27、taobao 37、jd 23、x 48、12306 5。数量里包含大量 planned（未实现、执行时报 `NOT_IMPLEMENTED`）的词表命令；已实现的读取类命令以 `docs/capabilities.md` 为准。

### 1.3 不提供的能力

- 不提供 HTTP API 服务；
- 不提供 Python / Go / Java SDK；
- 不提供 app 端、pc 端实现；
- 不提供 12306 的登录、下单、候补、退改签；
- 不提供通用网页抓取能力；
- 不保证所有验证码都能自动通过。

---

## 2. 代码地图

### 2.1 入口与调度

| 文件 | 作用 |
|---|---|
| `src/cli/main.ts` | CLI 入口：加载任何模块前设 `NO_PROXY`、stdout EPIPE 退出 0、跑完 `closeTransports()` 并 flush 后强制 `process.exit(code)` |
| `src/cli/dispatch.ts` | 解析 argv、全局命令、选择身份、校验参数、危险确认、`@file` 读取、分页/流式调度、信封输出、凭证回写 |
| `src/cli/argv.ts` | `node:util` 的 `parseArgs` 封装：全局选项、`--` 之后全部按位置参数、同名选项类型全局一致性收集 |
| `src/cli/help.ts` | 由注册表生成四层帮助（根 / 平台 / resource / 命令），按 CJK 显示宽度（宽字符计 2）对齐表格 |
| `src/cli/hints.ts` | 平台原生叫法 → 规范词提示表（`collection` 按平台映射 tiktok 的 `folder` / 快手的 `series`；`un-` 前缀反查 `like` 等） |
| `src/cli/output.ts` | JSON / JSONL 输出，信封字段按固定顺序写 |
| `src/cli/confirm.ts` | 危险操作确认：仅 stdin+stderr 都为 TTY 才交互问 y/N，否则要求 `-y` |
| `src/cli/commands/` | 全局命令实现：`platforms.ts`（能力矩阵）、`doctor.ts`、`version.ts`、`auth.ts`、`config.ts` |

### 2.2 核心

| 文件 | 作用 |
|---|---|
| `src/core/registry.ts` | 平台、端、命令、参数、选项、分页、handler 的唯一事实来源 |
| `src/core/vocab.ts` | 跨平台通用词表、默认参数、默认输出类型，含 `checkMsgSend` 等跨参数约束 |
| `src/core/options.ts` | 标准筛选项取值表、发布选项、分页选项、登录方式、`--visibility` 取值 |
| `src/core/auth-store.ts` | 凭证读写、账号名校验（小写字母数字 `_`/`-`，≤32 位，`guest` 保留）、`_current`、损坏文件容忍 |
| `src/core/auth-handlers.ts` | core 自动注册到每个平台的 `auth list` / `use` / `logout`（登出时先试服务端登出，失败仅告警） |
| `src/core/login.ts` | 登录流程公共部分：登录目标账号、短信中间态、二维码 PNG、密码隐藏输入、新凭证用户冲突校验 |
| `src/core/http.ts` | `wreq-js` 传输池、浏览器指纹、重定向、字符集、网络错误分类、`mockSender` / `fakeResponse` 测试钩子 |
| `src/core/cookies.ts` | Cookie 罐：直接挂凭证里的 cookie 数组，Set-Cookie 自动回写；domain/path 匹配、`parseCookieInput` |
| `src/core/vm.ts` | `node:vm` 脚本加载与调用，确定性模式注入 `Math.random` / `Date`，顶层 `const`/`let` 可取值 |
| `src/core/py.ts` | Python 兼容编码：`pyStr`、精确十进制浮点、`urlencode`/`quote`、`requoteUri`、`jsonLoads`（保 64 位 ID）、`jsonDumps` |
| `src/core/rand.ts` | 统一随机数与时钟：与 Python `random` 一一对应的推导公式、`mulberry32`、确定性切换 |
| `src/core/pb.ts` | 无 schema protobuf 解码（protobufjs Reader），替代上游 blackboxprotobuf |
| `src/core/stream.ts` | WebSocket 长连接包装成异步迭代：队列 + wake、指数退避重连、上游连续失败上限 |
| `src/core/schemas.ts` | 归一化类型定义（zod + TS interface）、凭证 schema、`RAW` 符号 |
| `src/core/normalize.ts` | 计数（“1.2万”→12000）、时间启发式（s/ms/µs、朴素时间补 +08:00）、价格、纯文本提取等归一化工具 |
| `src/core/toolkit.ts` | handler 公共工具：`scope()`、`jarOf()`、`httpClient()`、`authError()`/`paged()`/`stream()` |
| `src/core/files.ts` | `item download` 与发布用本地上传：`.part` 临时文件、按 Content-Type 推扩展名、URL 下载 |
| `src/core/image.ts` | 验证码图像解码：PNG 自带解码器（与 cv2 逐像素一致）、其余走 `@napi-rs/canvas`，opencv-js（WASM）加载 |
| `src/core/mp4.ts` | MP4/MOV 视频轨信息：只读 moov 盒子（tkhd/stts/stsz/mdhd、旋转矩阵），替代上游 ffmpeg/opencv 探测 |
| `src/core/log.ts` | stderr 日志：`-v` debug、`-q` 静默，输出前对 cookie/token/代理 URL 用户信息等正则打码 |
| `src/core/capabilities.ts` | 渲染 `docs/capabilities.md`：分区、✓/◐/○ 符号、脚注、扩展命令表 |
| `src/core/config.ts` | `config.toml` 读写与代理校验（http/https/socks4/socks5/socks5h），优先级 `--proxy > <p>.proxy > proxy` |
| `src/core/paths.ts` | 包根定位（向上找 `catbus-cli` 的 package.json）、`CATBUS_HOME`、auth/cache/static 路径 |
| `src/core/fsutil.ts` | 原子写入（临时文件 0600 + rename，Windows 上 EPERM/EBUSY/EACCES 重试最多 5 次）、目录 0700 |
| `src/core/errors.ts` | `CatbusError`、错误码 → 退出码映射 |
| `src/core/hash.ts` | md5 / sha1 / sha256 / HMAC 等 hex 摘要小工具 |

### 2.3 平台实现模板

每个平台基本遵循同一套结构：

```text
src/platforms/<p>/
├── index.ts          # 平台声明、命令注册、懒加载 handler
├── UPSTREAM          # 上游仓库与 commit
└── web/
    ├── client.ts     # 会话、设备、签名、请求、错误
    ├── api.ts        # 一个上游方法一个函数
    ├── commands.ts   # 命令 handler
    ├── normalize.ts  # 原始对象 → 统一类型
    ├── resolve.ts    # ID / URL / 短链 / me 归一化
    └── ...           # 平台私有模块
```

在注册表里大多数平台用 `handlers(load)` 声明懒加载 handler；有的平台会传第二个包装函数改写 handler 行为，例如抖音用 `handlers(load, (m, h) => m.retryWithUifid(h))` 生成“读取类”入口——缺 UIFID 时补一次设备数据后整条命令只重跑一次，而登录与写操作用不包装的入口，避免重复发消息或重出二维码。

### 2.4 静态资源与模型

| 路径 | 内容 |
|---|---|
| `static/<p>/` | 上游签名 JS、protobuf、proto 等原样副本 |
| `packages/assets-jd/` | 京东 JCAP ONNX 模型，约 81 MB |
| `packages/assets-ocr/` | ddddocr OCR 模型（检测 `common_det.onnx` + 识别 `common_old.onnx` + 字符集），约 34 MB，B 站极验点选在用 |
| `scripts/golden/<p>/` | 调用上游 Python 生成对拍数据 |
| `tests/golden/<p>/` | 已提交的对拍数据 |
| `tests/fixtures/12306/` | 12306 无上游仓库，用真实响应裁剪的 fixture 回放 |
| `tests/e2e/` | 在线只读测试，不在 CI 运行 |

`static/` 各平台资产明细（均为原样复制，不手改）：

| 平台 | `static/<p>/` 内容 |
|---|---|
| `xhs` | 三套子树：`xhs_core/js`（`b1.js`、`mns.js` + `mns_keystreams.json` / `mns_0101_keystream.json`、`sign.js`、`websectiga_env.js` / `websectiga_cli.js`、`xs_common.js`）、`xhs_pc/js`（AES 加解密、deflate、rap 系列 + 指纹模板 + `web_ssk`、`reference_profile.json`）、`xhs_creator/js`（创作者端签名 + 指纹） |
| `douyin` | `acrawler_runtime/`（`ac_vm.js`、`run_ac_node.js`、浏览器窗口形状 / canvas 实测 JSON、窗口键基线）、`challenge_template_runner.js` + `challenge_profile.json`、`dtrait_profile.json`、`mstoken_common_profile.json` / `mstoken_profile.json`、`Live.proto` / `Request.proto` / `Response.proto` |
| `tiktok` | `signing/`（`env/env_core.js`、`env/sign.js`、`source/webmssdk.js` / `webmssdk_ex.js` / `webmssdk_legacy.js`、`sdk_config.json`）、`shop_bsid/`（loader / run / sign / webmssdk 系列，商城下单 BSID） |
| `kuaishou` | `bundles/weapon/`（`kwf-0.0.2` + `kws-0` ~ `kws-19`，共 21 个脚本）、`js/cp-kwf.js`、`tools/`（kwf / kws / like_token 三把 oracle）、`fixtures/`（GraphQL 网络响应、直播 WebSocket proto 地图） |
| `xianyu` | `et_f.js`、`gen_tfstk.js`（阿里 et_f 补环境生成 `tfstk`）、`goofish_js_version_2.js`（mtop 辅助 + 推送解密） |
| `taobao` | 单文件 `taobao_js_20260407.js`（签名、设备、推送解析） |
| `jd` | `h5st5_env.js` / `h5st5_lib.js` / `h5st5_server.js`（h5st 5.3，jsdom 执行）、`pc_tk_lib.js` / `pc_tk_server.js`（WebM）、`summer_cryptico_runner.js`（密码加密）、`jcap/`（验证码 `env/env_core.js`·`run.js` + `run/jcap_ujb96b.js`）、`webm/`（`env/run.js` + `run/jdwebm-riskhandle.js`） |
| `x` | `graphql.json`（queryId / operationType / featureSwitches）、`transaction_l1.json`（XCTID 的 key、动画帧、索引） |
| `bilibili`、`weibo`、`12306` | 无 `static/` 目录：签名全部为纯 TS（B 站极验 OCR 用 `assets-ocr` 模型，12306 官方接口无需签名） |

### 2.5 文档与技能

| 路径 | 内容 |
|---|---|
| `docs/capabilities.md` | 由注册表生成的能力矩阵，手改会被测试打回 |
| `docs/upstream-map.md` | 上游仓库与移植对照 |
| `docs/platforms/<p>.md` | 各平台说明与限制 |
| `.claude/skills/catbus/` | Agent 技能源 |
| `.agents/skills/catbus/` | OpenCode 读取的副本，必须与 `.claude` 完全一致 |

---

## 3. 一条命令的完整执行链路

以 `catbus bilibili item get BV1xx411c7mD` 为例：

### 3.1 解析 argv

`dispatch.ts` 解析：

- 平台：`bilibili`
- resource：`item`
- action：`get`
- 位置参数：`BV1xx411c7mD`
- 全局选项：`-a`、`-e`、`-o`、`--raw`、`--proxy` 等
- 命令选项：`--limit`、`--cursor`、`--all` 等

底层是 `node:util` 的 `parseArgs`（strict 模式）＋注册表生成的选项表：

- `--` 之后的内容一律按位置参数处理，用于以 `-` 开头的文本；
- 未知选项、缺值等 parseArgs 错误会被翻译成 `USAGE` 信封，`hint` 提示如何写；
- `cli/argv.ts` 的 `collectOptionKinds` 在加载平台时收集所有选项的类型：命令选项与全局选项重名、或同名选项在命令间类型不一致，都会在启动时报错；
- 数字选项（如 `--limit`）在这里完成字符串到整数的转换，负数或非法取值报 `USAGE`。

帮助也是这一步分发的：`catbus`（无参数）等同 `--help`；四级帮助（根 / `catbus <p> --help` / `catbus <p> item --help` / `catbus <p> item get --help`）全部由注册表渲染，是 stdout 上唯一不是 JSON 的输出。

### 3.2 查注册表

从平台注册表里找到 `item get` 的命令声明，检查：

- 端是否可用；
- 命令是否存在；
- 上游支持程度；
- 是否需要登录；
- 是否需要确认；
- 是否分页；
- handler 是否存在。

如果端是 planned，报 `NOT_IMPLEMENTED`，退出码 4。

如果命令是矩阵里的 `—`，或者不在词表内，报 `UNSUPPORTED`，退出码 2。

判定顺序上有几条细节：

- 参数 / 选项校验先于 ○ 判断：写错的命令先报用法错误，planned 端不做校验；
- `UNSUPPORTED` 时若其他端有该命令，`hint` 会提示加 `-e <端>`；用了平台原生叫法（note / aweme / playurl…），`hint` 给出规范词（`cli/hints.ts` 的原生词表，`collection` 对 tiktok 是 `folder`、对快手是 `series`）；
- 用了词表有、但平台没声明支持的标准选项（`supports` 列表之外）报 `UNSUPPORTED`，`hint` 列出可用选项——选项不会被静默忽略；
- 筛选取值先查标准值表（`USAGE` / `UNSUPPORTED` 的区分见 AGENTS 4.9），错误里只列本平台支持的取值。

### 3.3 选择身份

优先级：

```text
-a <name> > _current > 游客
```

但 web 端除 12306 外都不支持游客态。未登录时直接报 `AUTH_REQUIRED`，退出码 3，`hint` 是登录命令（非 web 端会带 `-e` 补正）。

补充细节：

- `-a` 指定的账号不存在 → `AUTH_REQUIRED`，`hint` 提示 `catbus <p> auth login -a <name>`；
- `-a guest` 强制游客身份（`guest` 是保留名，`auth login` / `logout` / `use` 拒绝它）；
- `me` 参数需要登录态，游客时同样报 `AUTH_REQUIRED`；
- 游客凭证若该端声明了 `guest: true` 就读写 `guest.json`；没声明（web 端除 12306 外）则只有一份只在内存里的空凭证，不落盘；
- 声明 `auth: optional` 且端支持登录时，游客访问在 stderr 打一行提示（`-q` 或 `-a guest` 时不打），提示冒号后是登录命令；
- auth 命令在 `ctx.account == null`（没 `-a`、没有当前账号）时按“无身份”处理而不是报 AUTH_REQUIRED，例如 `auth login` 会落到 `default`。

### 3.4 校验参数

- 位置参数个数；
- 选项是否适用于该命令；
- 筛选取值是否在标准表内；
- 平台是否支持该取值；
- 跨参数约束；
- 危险操作确认。

### 3.5 懒加载 handler

注册表里只存动态 import：

```ts
handler: () => import('./web/commands.js').then((m) => m.itemGet)
```

只有真正执行该命令时才加载对应平台代码，不会连带加载其他平台或验证码模型。

### 3.6 创建 HandlerContext

上下文里包含：

- `platform`、`endpoint`、`resource`、`action`
- `args`、`options`
- `account`、`credential`
- `cursor`
- `raw`
- `config`（代理、超时）
- `log`
- `signal`
- `saveCredential`

### 3.7 执行 handler

handler 内部通常会：

1. 构造平台客户端；
2. 补齐设备状态；
3. 计算签名；
4. 发请求；
5. 检查业务码；
6. 解析响应；
7. 归一化；
8. 返回数组或对象，并带 `page`。

### 3.8 分页

如果命令声明了 `paged`，`dispatch.ts` 会调用 `runPaged`：

- 默认只取一页；
- `--limit N` 自动翻页直到 N 条；
- `--all` 翻到没有更多；
- `--cursor` 从上次的 `page.cursor` 继续；
- 如果截在一页中间，游标会带 `#skip=N`；
- 游标不变或页面为空时停止，避免死循环。

`#skip` 的具体语义：`runPaged` 给 handler 传的 cursor 是平台原始游标；当 `--limit` 要求的条数比当前页剩余的少时，本页取完所需条数后输出 `page.cursor = "<本页游标>#skip=<已跳过条数>"`。下次续翻时 dispatch 按 `#skip` 截掉开头已输出的条目，再把干净的平台游标传给 handler——所以翻页不丢数据，也不会重复请求上游已给过的页。

翻页节奏与看门狗：

- 每页之间 sleep 该平台注册的 `pageInterval`（默认 1000 ms）；
- 同一游标连续出现时视为死循环保护：停止翻页、`has_more: false`，stderr 提示一行而不是报错。

### 3.9 输出信封

成功：

```json
{
  "ok": true,
  "platform": "bilibili",
  "endpoint": "web",
  "resource": "item",
  "action": "get",
  "account": "default",
  "data": {},
  "page": null,
  "error": null
}
```

失败：

```json
{
  "ok": false,
  "platform": "bilibili",
  "endpoint": "web",
  "resource": "item",
  "action": "get",
  "account": "default",
  "data": null,
  "page": null,
  "error": {
    "code": "RISK_CONTROL",
    "message": "...",
    "hint": "...",
    "detail": {}
  }
}
```

### 3.10 输出实现细节

`cli/output.ts` 的 `Output`：

- 信封字段按固定顺序写：`ok`、`platform`、`endpoint`、`resource`、`action`、`account`、`data`、`page`、`error`；
- stdout 是 TTY 时缩进美化，重定向时紧凑单行；
- `-o jsonl` 时每条 `data` 立即 flush 一行；结束信封（`data: null`，带 `page` / `error`）写到 **stderr**，供管道取 next cursor 或错误信息；
- 流式命令（listen）强制 jsonl；
- `--raw` 时每个对象换成平台原始对象（`schemas.ts` 的 `RAW` 符号挂在归一化对象上），信封结构不变。

### 3.11 凭证回写

命令结束前，`dispatch.ts` 会把以下变化合并回凭证文件：

- `Set-Cookie`（请求中 `CookieJar` 收到的都会进 scope 的 cookie 数组）；
- 刷新后的 token；
- 新生成的游客设备数据；
- 平台私有票据。

写入是原子的：先写临时文件（0600），再 rename（Windows 上目标被占用会重试几次）。回写还有两个保护：

- 回写前先比对进入命令时的凭证快照，没有变化就不写盘；
- 账号文件在命令执行中途被删（例如并行跑了 `auth logout`）就不写回，避免复活已删除的登录态；
- 游客命令在不支持游客态的端上没有凭证文件，不回写。

### 3.12 长连接与进程退出

`runStream`（`msg listen`、`live listen`）：

- 全程输出 jsonl，SIGINT 只注册一次 handler，`--duration` 到期正常收尾，退出码 0；
- 输出循环与中断用 race 竞争，收流时调 handler 的 `return()` 结束异步迭代（不等待卡住的帧）；
- 底层 WebSocket 在 `core/stream.ts`：消息按到达顺序进队列，消费者经 `messages` 异步迭代取；断线自动重连（指数退避、上限 30 s），上游连续失败达到 5 次才放弃。

进程出口（`cli/main.ts`）：

1. 跑 `run()` 得到退出码；
2. `closeTransports()` 释放连接池；
3. 先 flush stdout / stderr 再 `process.exit(code)`——长连接的原生句柄不会让进程挂着不走；
4. stdout 写入遇到 EPIPE（管道下游提前关闭）时直接以 0 退出，不算错误。

---

## 4. 底层机制

### 4.1 HTTP 传输与指纹

catbus 使用 `wreq-js`，不是 Node 原生 `fetch`。

它做了几件事：

- 模拟 Chrome 的 TLS / HTTP2 指纹；
- 关闭默认请求头，让平台代码自己按浏览器顺序排列；
- Cookie 按浏览器实际线序拼接；
- 支持显式代理；
- 不读取 `HTTP(S)_PROXY` 环境变量。

为了禁止环境代理，`core/http.ts` 在加载时（以及 `main.ts` 在加载任何模块前）设置：

```text
NO_PROXY=*,0.0.0.0/0,::/0
```

代理只能通过 `--proxy`、`config.toml` 显式传入。

逐条请求的实现要点（`HttpClient.request`，`http.ts` 关于 400 行）：

- **传输池**：wreq-js transport 按 `browser|os|proxy` 三元组缓存复用，默认 `chrome` + `windows`，避免每请求重建 TLS 会话；
- **头顺序完全由调用方决定**：`disableDefaultHeaders` 默认为 true，平台代码显式给出 `[name, value]` 对，catbus 不排序、不补默认头；
- **Cookie 头的位置**：显式 Cookie 头优先插在 `priority` 头之前（Chrome 的顺序），没有 `priority` 时放最后；
- **URL 拼接**：`buildUrl` 对齐 curl_cffi 的 `update_url_params`——查询串里同名键只有本就重复出现时才保留多个，其余替换值；布尔值 true/false 直接出现在串里；最后经 `urlencode` + `requoteUri` 与 requests 的 URL 规范化一致；
- **重定向**：手动逐跳跟随，最多 10 跳；中间跳的 `Set-Cookie` 会进 Cookie 罐，303 以及 301/302 的 POST 改成 GET 并剥掉 body / form / multipart 与相关头；
- **字符集**：响应头声明非 UTF-8 时按 charset 解码（京东 GBK 页面），body 是二进制时原样取出；
- **超时**:`config.timeout`（秒）转毫秒传给 transport，超时、代理、TLS、DNS、连接失败被归类成带 `detail.kind` 的 `NETWORK` 错误;
- **测试钩子**：`mockSender` 替换真正发请求的函数（离线测试直接抛错），`fakeResponse` 构造回放响应。

### 4.2 签名实现方式

catbus 的签名分三类。

#### 第一类：纯 TypeScript

例如：

- 抖音 `a_bogus`；
- B 站 WBI；
- X 的 `x-client-transaction-id`；
- 闲鱼 / 淘宝 mtop MD5；
- 京东部分设备参数。

优点是离线、可测试、可逐字节对拍。

#### 第二类：上游签名 JS

例如：

- 小红书 `X-s` / `X-t` / `X-S-Common`；
- 京东 h5st 5.3；
- 闲鱼 `tfstk`；
- 快手部分签名。

这些 JS 从上游仓库**原样复制**到 `static/<p>/`，catbus 不格式化、不改写。

执行方式：

- `node:vm` 创建 context；
- 需要 DOM 的注入 `jsdom`；
- `require` 指向 catbus 自己的 `node_modules`；
- 需要进程级全局、stdin/stdout 的脚本起子进程。

#### 第三类：设备绑定

例如：

- TikTok ticket-guard；
- 抖音 UIFID；
- 快手 webweapon；
- 京东 WebM；
- B 站 `ExClimbWuzhi`。

这类签名不只需要算法，还需要：

- 设备 ID；
- localStorage / sessionStorage；
- 私钥、证书；
- 一次性票据；
- 浏览器指纹。

#### 执行方式细目（按平台落实）

“跑上游 JS”在不同平台落地方式不同，逐个说明：

| 方式 | 平台 / 内容 |
|---|---|
| 纯 TS 计算 | 抖音 `a_bogus`（SM3、变体 RC4 等）、B 站 WBI / `bili_ticket` / BV 号转换、TikTok X-Bogus / X-Gnarly / X-Dynosaur / AWS-SigV4、X 系 XCTID、快手 hxfalcon sig4 与 GraphQL 先签名体、闲鱼/淘宝 mtop MD5、微博 XSRF |
| vm 按 CommonJS 加载模块 | 小红书：`static/xhs/` 三套子树加载进 vm Realm，`require('crypto')` 换成确定性 `randomBytes` 的实现，导出的 `signFull`、`generateB1`、rap 系列函数直接调用 |
| vm + jsdom | 京东 h5st5（`h5st5_env/lib/server`）、pc_tk（WebM）、`summer_cryptico`：需要 DOM / localStorage，注入 jsdom 与网络桥 |
| 子进程退路 | 小红书 `websectiga_cli.js`（改写进程级全局）、TikTok `signing/` 与 `shop_bsid/`（webmssdk）、京东 JCAP 验证码（`run.js` + `host.js` 替换上游 Python 的 http_bridge / captcha_solver） |
| 有状态签名器 | 快手：`sign.ts` 的纯算签名器有启动时间、调用计数等状态，每条命令 new 一个实例；`kwscode` / `kwssectoken` 约 6 分钟有效，现算不落盘（kwscode 由 vm 跑 signUrl 指定的那份官方 kws 脚本产生） |
| vm 嵌套补环境 | 闲鱼 `gen_tfstk.js`：命令行脚本写法，catbus 喂假的 `process` 收 stdout，脚本内部再开一层 vm 跑阿里的 `et_f`（宿主对象要透传，否则环境检测不过） |
| 推送流解码 | 闲鱼/淘宝 IMPaaS 推送里的 `decrypt(data)` 是 base64 + MessagePack，靠 `goofish_js_version_2.js` / taobao JS 里导出的函数解 |

vm 确定性注入：对拍模式下，`core/vm.ts` 给每个新建 context 注入与 `scripts/golden/node_determinism.cjs` 相同的 `Math.random` 和 `Date`（上游每次签名都新起一个 node 进程，随机序列从头开始），并发出 `__catbus_random` / `__catbus_now` 供脚本读取。

### 4.3 随机数与时间

所有平台代码的随机数和当前时间都通过 `core/rand.ts`。

这样做的目的：

- 对拍测试可以固定随机源；
- 同一输入可以复现同样的请求；
- 签名里的时间戳、随机数不会绕过测试框架。

与 Python `random` 的推导公式一一对应（改任何一边都要同步另一边）：

| catbus 函数 | 对应 Python |
|---|---|
| `random()` | `random.random()` |
| `randint(a, b)` | `random.randint(a, b)`（含两端） |
| `uniform(a, b)` | `random.uniform(a, b)` |
| `choice(seq)` | `random.choice(seq)` |
| `string(n, alphabet)` | `''.join(random.choice(alphabet) for _ in range(n))` |
| `gauss(...)` | `random.gauss()`（缓存第二个值，与 Python 生成对一致） |
| `sample(...)` / `shuffle(...)` | 同名函数 |
| `bytes(n)` | `os.urandom(n)` |
| `hex(n)` | `secrets.token_hex(n)` |
| `uuid4()` | `uuid.uuid4()` |
| `now()` / `nowSeconds()` | `time.time()*1000` / 秒 |
| `sleep(ms)` | `time.sleep()`（确定性模式下不等待） |

实现：替换源是一个经过取距的 `mulberry32`，与生成对拍数据的框架（`scripts/golden/catbus_golden.py`）逐位一致。确定性模式的默认参数：`DEFAULT_SEED = 20260927`、`DEFAULT_NOW = 1790000000123`；`deterministic()` 切换源，`isDeterministic()` 用“source 是否还是 `Math.random`”判断。

### 4.4 响应解析

catbus 不假设响应一定是标准 JSON。

| 形态 | 使用场景 |
|---|---|
| JSON | 大多数平台 |
| JSONP | 京东、闲鱼、淘宝 |
| SSR HTML hydration | TikTok 详情、微博详情 |
| HTML 表格 | 京东订单 |
| protobuf | 抖音直播/私信、TikTok 私信 |
| 管道分隔文本 | 12306 余票 |

解析平台响应时，优先使用 `core/py.ts` 的 `jsonLoads`，保留 64 位整数 ID，不直接用 `JSON.parse`。

HTTP 层的解析入口（`core/http.ts`）：

- `parseJson`：JSON 格式错时报 `UPSTREAM`，`detail` 里带响应体前 300 个字符，便于定位是登录墙还是别的页面；
- `parseJsonp` / `jsonpOf`：京东、闲鱼、淘宝的 JSONP 回调包裹；
- 非 2xx 时保留状态码与截断后的 body，交给平台 client 映射成登录墙 / 风控 / 业务码。

### 4.5 Python 兼容编码（core/py.ts）

上游是 Python 写的，签名的输入常常是 `urlencode` / `json.dumps(str)` 的产物，编码差一个字符签名就对不上。这个文件逐字节复刻了 Python 行为：

| 函数 | 对齐目标 |
|---|---|
| `pyStr(v)` | `str(v)`：`True / False / None` 写法 |
| `pyFloatStr` / `pyRound` | 浮点的精确十进制表示（按 IEEE 754 位展开成 digits / 10^scale），`round` 的银行家舍入 |
| `quote(s, safe='/')` | `urllib.parse.quote`：保留字 `A-Za-z0-9_.-~`，safe 默认为 `'/'` |
| `quotePlus` / `unquote` | 同名函数（`+` 与空格的转换） |
| `urlencode(pairs)` | `urllib.parse.urlencode`，顺序保持 |
| `requoteUri(url)` | requests 的 URL 规范化：把已编码的非保留字符解出来，再整体 quote 一遍（`REQUOTE_SAFE` 集为 `!#$%&'()*+,/:;=?@[]~\|`） |
| `jsonLoads` | `json.loads`：64 位整数 ID 不丢精度（大数保留为字符串，平台侧再归一化） |
| `jsonDumps(x)` | `json.dumps`：默认 ensure_ascii，需要精确键序的对象用 `Map` |

配套的约定写在 AGENTS 里：平台代码的编码一律走这个文件，随机数一律走 `rand.ts`，等待一律用 `rand.sleep`，这样对拍才能逐字节成立。

### 4.6 归一化

所有平台最终输出统一结构。

基础类型：

- `UserRef`
- `Price`
- `Media`
- `User`
- `Item`
- `Comment`
- `Folder` / `Series`
- `Category`
- `Keyword`
- `Topic`
- `Poi`
- `Live`
- `Event`
- `Gift`
- `Rank`
- `Conversation`
- `Message`
- `Notice`
- `AuthStatus`
- `Account`
- `File`

扩展类型：

- `Subtitle`
- `Danmaku`
- `Order`
- `Coupon`
- `Station`
- `Ticket`
- `Stop`
- `Fare`
- `Transfer`
- `TransferLeg`

规则：

- ID 一律是字符串；
- 计数是整数或 null；
- 时间用带时区的 ISO 8601；
- 字段总是存在，缺失时为 null 或 `[]`；
- 不追加平台私有字段；
- 需要原始字段时用 `--raw`。

### 4.7 登录态与作用域

凭证文件结构：

```jsonc
{
  "schema": 1,
  "platform": "xhs",
  "endpoint": "web",
  "account": "default",
  "user": { "id": "...", "name": "...", "url": "..." },
  "method": "qrcode",
  "created_at": "...",
  "updated_at": "...",
  "scopes": {
    "main": {
      "cookies": [],
      "tokens": {}
    },
    "creator": {
      "cookies": [],
      "tokens": {}
    }
  },
  "device": {},
  "extra": {}
}
```

要点：

- 一个账号一个文件；
- `guest` 是保留名；
- 目录 0700，文件 0600；
- 子站点用 scope 隔离；
- 平台实现不直接读写 `~/.catbus/`，只通过 core 拿凭证、交回凭证。

登录流程的公共辅助（`core/login.ts`，各平台 `auth login` handler 调用）：

- `loginTarget`：`-a` > 当前账号 > `default`；
- 扫码：二维码画到 stderr，PNG 存 `cache/<p>/qrcode.png`；轮询拿票据和用户信息，网络抖动时重试几次；
- 短信：TTY 下交互输入；非 TTY 分两步，中间态存 `cache/<p>/sms-<endpoint>-<account>.json`，10 分钟有效；
- 密码：只从 stdin 读，TTY 下隐藏输入；
- cookie 导入：`--cookie <str|@file|->`，也接受浏览器导出的 JSON 数组，导入后必须调一次 `me` 校验；
- `finishLogin`：成功前校验目标账号名下是不是另一个用户，是则报 `USAGE`（提示 `-a <新名字>` 或先 logout），不保存凭证；
- `auth logout`：先试服务端登出（bilibili、kuaishou 支持，失败仅告警），再删本地文件并清除指向它的 `_current`；
- `auth use` / `auth list`：`core/auth-handlers.ts` 自动注册，账号不存在报 `AUTH_REQUIRED` 而不是 USAGE。

### 4.8 错误映射

| 退出码 | code | 含义 |
|---|---|---|
| 0 | — | 成功 |
| 1 | `ERROR` | 未分类错误 |
| 2 | `USAGE` / `UNSUPPORTED` / `CONFIRM_REQUIRED` | 参数错误 / 不支持 / 未确认 |
| 3 | `AUTH_REQUIRED` / `AUTH_EXPIRED` | 未登录或登录失效 |
| 4 | `NOT_IMPLEMENTED` | planned 的端或能力 |
| 5 | `RISK_CONTROL` | 验证码、限流、封禁 |
| 6 | `NETWORK` | 网络 / 代理错误 |
| 7 | `UPSTREAM` | 平台业务错误 |

每个 `CatbusError` 带 `code`（查表换退出码）、`hint`（建议执行的命令，可为 null）、`detail`（原始信息）。

两条细分：

- **网络错误的 `detail.kind`**：`timeout` / `proxy` / `tls` / `abort` / `dns` / `connect`，代理类错误的 `hint` 提示检查 `--proxy` 与 config.toml；
- **登录态的区分**（`toolkit.authError`）：凭证文件不存在或账号为空 → `AUTH_REQUIRED`；持有有效登录态但服务端判失效 → `AUTH_EXPIRED`；判据是平台业务码或登录墙特征（如 cookie 里少了 `web_session`）。

`--raw` 等细节由平台 client 决定映射：登录墙走 `toolkit.authError`，验证码 / 限流走 `RISK_CONTROL`（detail.kind 标 `captcha` / `rate_limit` / `blocked`），其余业务码走 `UPSTREAM` 并把原始码放 `detail`。

### 4.9 Cookie 罐（core/cookies.ts）

`CookieJar` 直接挂在凭证某个 scope 的 cookie 数组上，所以请求中更新的 cookie 随凭证由 core 落盘（无需平台手动保存）。要点：

- `forUrl` 按 domain 后缀（`.` 开头对子域名生效，否则 host-only）+ path 前缀 + 未过期过滤，返回按存入顺序的列表；需要浏览器线序时可显式排序；
- `set` 覆盖判断：同名 + 同 domain + 同 path 视为同一条；
- `applySetCookie`（处理 `Set-Cookie` 头）遵循 RFC 6265：`Domain` 属性必须匹配当前主机才接受；`max-age` 存在时优先于 `expires`；过期即删除；
- `parseCookieInput` 接受 `a=1; b=2` 字符串（可带 `cookie:` 前缀）或浏览器导出的 JSON 数组，字符串里同名以后者为准，domain 缺省用平台默认域；
- 显式 Cookie 头在发请求时被拆成有序 pairs，顺序与浏览器一致。

### 4.10 下载与媒体（files.ts / image.ts / mp4.ts）

`core/files.ts`：

- 下载写 `<platform>_<id>_<序号>.<ext>`，默认跳过已有文件，`--overwrite` 才覆盖；
- 先写 `.part` 临时文件再 rename，避免留半截文件；
- 扩展名来自 Content-Type 表（jpeg/png/webp/gif/heic/mp4/mov/webm/m4a/mp3…），DASH 流等没有单一 Content-Type 的情况由平台传回调决定；
- `readMedia` 直接把 URL 内容读成字节，供发布上传用。

`core/image.ts`（验证码识别用）：

- PNG 用自带解码器，与 `cv2.imdecode` / Pillow 逐像素一致，半透明不做预乘，输出 BGR/BGRA（与 cv2 一致）；
- JPEG / WebP 等交给 `@napi-rs/canvas`；
- `loadCv()` 懒加载 `@techstark/opencv-js`（WASM），首次几百毫秒。

`core/mp4.ts`：只读 moov 里的盒子不解码——tkhd 显示尺寸（16.16 定点）、stsd 编码尺寸、旋转矩阵角度、mdhd 时间刻度、stts/stsz 样本计数，按上游的算法从这些原始值算尺寸、时长、帧率（替代上游用 ffmpeg / opencv 探测）。

### 4.11 日志脱敏（core/log.ts）

所有 stderr 输出（含 `-v` debug 与平台传入的 data）先过 `redact`：

- 键名命中 `cookie|token|authorization|password|secret|ticket|sessdata|ct0` 等的值换成 `***`；
- 字符串里 `Cookie: …` / `Set-Cookie: …` 的整行打码；
- `key=value` / JSON 里的敏感键只打码值（保留 `Bearer ` 前缀结构）；
- URL 里的 `user:pass@host`（代理地址）打码成 `//***@`。

### 4.12 配置、路径与原子落盘

- `core/config.ts`：`config.toml` 只有 `proxy`、`timeout`、`<platform>.proxy`；代理协议限定 http(s)/socks4/socks5/socks5h；优先级 `--proxy > <platform>.proxy > proxy`；不读 `HTTP(S)_PROXY`；
- `core/paths.ts`：包根从入口文件向上找 `name === 'catbus-cli'` 的 package.json，src 与 dist 都适用；数据目录 `CATBUS_HOME` 或 `~/.catbus`；
- `core/fsutil.ts`：`writeFileAtomic` = 同目录临时文件（0600，名字含 pid 与随机数）+ rename；Windows 上 EPERM / EBUSY / EACCES 重试最多 5 次（间隔递增），失败仍删临时文件；`ensureDir` 用 0700（Windows 依赖用户目录 ACL）。

---

## 5. 11 个平台的技术档案

### 5.1 小红书（xhs）

#### 定位

签名 API + `xsec_token`。

#### 会话与设备

- `a1`：52 位设备标识；
- `web_session`：登录态；
- `b1`：浏览器环境快照；
- 其他 Cookie 和 localStorage。

#### 签名

- `X-t`：时间戳；
- `X-s`：请求签名；
- `X-S-Common`：公共签名头。

签名 JS 来自 `static/xhs/`，catbus 在 `node:vm` 里按 CommonJS 加载，直接调用导出函数。

部分登录/风控链路会执行服务端下发的 `websectiga` 代码，catbus 用子进程隔离。

补充细节（`web/js.ts`、`web/state.ts`）：

- `static/xhs/` 分三套子树：`xhs_core`（主站 mns / X-s / b1、xs_common）、`xhs_pc`（创作者 web 端 rap 系列、AES、`web_ssk`）、`xhs_creator`（创作者端签名）；三套在正常模式共用一个 vm Realm（确定性 / 对拍模式每次调用新建 context，模拟上游每次签名新起进程），`require('crypto')` 被换成确定性的 `randomBytes` 实现；`websectiga_cli.js` 是例外，它改写进程级全局，和上游一样起子进程；
- 签名输出有门禁 `checkSign`：`X-s` 必须以 `mns<tier>_` 开头且长度落在该档位的集合里，否则直接报错，防止上游 JS 行为漂移后把坏签名发出去；
- `mns_keystreams.json` / `mns_0101_keystream.json` 是 mns 的密钥流素材，进版本控制；
- 会话状态（loadts、dsllt、MNS 序号、tiga 时间、webSsk）对应浏览器的 localStorage / sessionStorage，持久部分存凭证 `device.pc` / `device.creator`；MNS 序号计数器每条命令从 0 起（首个签名自增为 1，对齐上游 from_cookie），dsllt 每 15 分钟刷新一次；
- `normalizeEts`（毫秒末位避开 1）和 `randbits32`（对齐 `secrets.randbits(32)`）这类细节都走 `rand.ts`，保证对拍一致。

#### 主要接口

- 用户信息：`/api/sns/web/v2/user/me`
- 用户主页：`/api/sns/web/v1/user/otherinfo`
- 用户笔记：`/api/sns/web/v1/user_posted`
- 点赞、收藏：`/api/sns/web/v1/note/like/page`、`/api/sns/web/v2/note/collect/page`
- 笔记详情：`/api/sns/web/v1/feed`
- 搜索：`/api/sns/web/v1/search/notes`
- 评论：`/api/sns/web/v2/comment/page`
- 子评论：`/api/sns/web/v2/comment/sub/page`
- 首页推荐：`/api/sns/web/v1/homefeed`

#### 关键点：xsec_token

搜索和推荐流返回的笔记 URL 带 `xsec_token`。

笔记详情和评论接口都需要这个 token。

所以：

```bash
catbus xhs item search "关键词"
# 从结果里拿 url
catbus xhs item get "https://www.xiaohongshu.com/explore/<id>?xsec_token=..."
```

只传纯 ID 时，可能拿不到详情。

#### 翻页

- 搜索：页码 + `search_id`；
- 推荐流：`note_index:cursor_score:category`；
- 评论：平台 `cursor`；
- 用户笔记：平台 `cursor`。

#### 风控

- 登录墙；
- 验证码重定向；
- 业务码 `300012`、`300013` 等；
- `websectiga` 服务端代码。

#### 能力边界

- 详情、搜索、评论、用户作品、创作者发布比较完整；
- `item related` 没有；
- app / pc 端占位。

#### 关键文件

`client.ts`、`js.ts`、`api.ts`、`commands.ts`、`resolve.ts`、`state.ts`、`creator.ts`。

---

### 5.2 抖音（douyin）

#### 定位

设备状态 + `a_bogus` 签名 + 大量业务接口。

#### 会话与设备

- `ttwid`：通过字节 ttwid 注册接口获取；
- `msToken`：600 秒缓存，从 `mssdk.bytedance.com` 获取；
- `webid`：用户唯一 ID；
- `s_v_web_id`：验证指纹；
- `UIFID`：页面脚本写入的设备 Cookie。

catbus 会按浏览器 Cookie 顺序拼接，并区分 `www.douyin.com` 与 `.douyin.com` 的 domain。

#### 签名

`a_bogus` 用纯 TypeScript 实现，内部包括：

- SM3；
- 变体 RC4；
- 浏览器 UA 指纹；
- 查询串和 body；
- 时间戳。

部分接口还会加 `X-Bogus`、`x-secsdk-web-signature`。

配套实现：

- `web/sign.ts` 内含 SM3 等纯算签名原语，浏览器指纹常量在 `web/profile.ts`；
- msToken 不是本地算的：调 `/web/r/token`（普通）与 `/web/common`（手机端）接口换，缓存 600 秒，失败时退回随机值；
- 挑战页与设备绑定用子进程跑 `static/douyin/` 的脚本：`acrawler_runtime/run_ac_node.js` 生成 `__ac_signature`，`challenge_template_runner.js` 执行挑战模板（窗口形状与 canvas 实测数据在 `acrawler_runtime/` 的 JSON 里）；
- dtrait 由 `dtrait_profile.json` 经 `buildBlob` 生成，登录导入 cookie 时可一并带 `dtrait_profile` / `dtrait_blob`；
- 直播与私信 protobuf 用 `Live.proto` / `Request.proto` / `Response.proto`，运行期经 `core/pb.ts` 无 schema 解码。

#### 主要接口

- 作品详情：`/aweme/v1/web/aweme/detail/`
- 用户作品：`/aweme/v1/web/aweme/post/`
- 用户喜欢：`/aweme/v1/web/aweme/favorite/`
- 搜索：`/aweme/v1/web/general/search/single/`
- 评论：`/aweme/v1/web/comment/list/`
- 子评论：`/aweme/v1/web/comment/list/reply/`
- 用户搜索：`/aweme/v1/web/discover/search/`
- 关系、通知、私信、直播：各自的接口

#### 翻页

- 综合搜索：`offset` 递增；
- 视频搜索：`offset, X-Tt-Logid`；
- 用户搜索：`offset`，每页 25；
- 用户作品：`max_cursor`；
- 评论：`cursor`；
- 直播：`room_id` + WebSocket。

#### 风控

catbus 会识别：

- 空响应；
- `__ac_nonce` / `_$jsvmprt` 挑战页；
- `Uifid Not Found`；
- `x-vc-bdturing-parameters`；
- `x-tt-verify-passport-decision`；
- 登录墙业务码。

读操作遇到 UIFID 缺失时，会补一次 UIFID 后整条命令重跑一次；写操作不会重跑，避免重复发消息。

#### 私信和直播

- 私信：protobuf + `frontier-im` WebSocket；
- 直播：从直播间页面 hydration 拿 `room_id`、`user_unique_id`，再连 webcast WebSocket，解析聊天、礼物、进场、点赞等事件。

#### 能力边界

- web 端命令需要登录；
- 设备绑定较强，单纯复制 Cookie 有时不够；
- 创作者中心是单独接口。

#### 关键文件

`sign.ts`、`client.ts`、`api.ts`、`im.ts`、`live.ts`、`creator.ts`、`passport.ts`。

---

### 5.3 TikTok

#### 定位

SSR 详情 + 签名 API + ticket-guard。

#### 两个入口

1. **详情页 SSR**：视频详情和用户详情解析 `__UNIVERSAL_DATA_FOR_REHYDRATION__`；
2. **签名 API**：搜索、评论、用户作品、相关推荐、私信、直播。

#### 签名

当前包括：

- `msToken`；
- `X-Dynosaur`；
- `X-Bogus`；
- `X-Gnarly`。

catbus 用纯 TypeScript 实现，按 URL 路径选择签名组合。

查询参数很多，包括设备 ID、region、screen、timezone、browser 信息等。

执行方式：常见签名（X-Bogus、X-Gnarly、X-Dynosaur、AWS-SigV4）全部纯 TS；`static/tiktok/signing/`（`env/env_core.js` + `source/webmssdk*.js`）与商城下单签名 `shop_bsid/`（loader / run / sign / webmssdk 系列）保留原样 JS，用子进程执行——webmssdk 家族对运行环境的要求 vm 满足不了（AGENTS 7.4 的退路）。

#### 详情

```text
https://www.tiktok.com/@user/video/<id>
```

catbus 拉页面，从 hydration JSON 里取 `itemStruct`，不是调详情 API。

#### 写操作

点赞、评论、发布等需要 `tt-ticket-guard`：

- 浏览器安全 SDK 生成的 `encrypt_ticket`；
- EC 私钥；
- `ts_sign`；
- `req_sign`；
- `ticket`、`path`、`timestamp`。

这些数据必须从浏览器导入。只有 Cookie 时，读操作可能还能用，写操作会报缺少会话安全数据。

#### 翻页

- 搜索：`cursor`；
- 评论：`cursor`；
- 用户作品：`cursor` / `minCursor`；
- 相关推荐：`cursor`。

#### 私信和直播

- 私信：protobuf + WebSocket；
- 直播：WebSocket 事件流。

#### 能力边界

- 只支持 cookie 登录；
- app / pc 端未实现；
- 写操作依赖浏览器设备数据；
- story 不开放。

#### 关键文件

`sign.ts`、`client.ts`、`api.ts`、`commands.ts`、`resolve.ts`、`im.ts`。

---

### 5.4 B 站（bilibili）

#### 定位

WBI 签名 + 设备 Cookie + 极验。

#### 会话与设备

- `buvid3` / `buvid4`：设备标识；
- `bili_ticket`：HMAC + 时间戳；
- `_uuid`、`b_lsid`、`qv_id`；
- `ExClimbWuzhi`：浏览器指纹上报；
- 登录 Cookie：`SESSDATA`、`bili_jct`、`DedeUserID`。

#### WBI

1. 请求 `/x/web-interface/nav` 拿 `img_url`、`sub_url`；
2. 从 URL 文件名生成 `mixin_key`；
3. 参数按 key 排序，拼 `wts`；
4. `w_rid = md5(query + mixin_key)`；
5. 请求带 `wts` 和 `w_rid`。

部分接口带 `dm_img` 系列参数，模拟 WebGL 指纹。

#### 主要接口

- 搜索：`/x/web-interface/wbi/search/type`
- 视频详情：`/x/web-interface/view`
- 播放地址：`/x/player/wbi/playurl`
- 评论：`/x/v2/reply`
- 子评论：`/x/v2/reply/reply`
- 用户空间：`/x/space/wbi/arc/search`
- 动态：`/x/polymer/web-dynamic/v1/feed/space`
- 专栏：`/x/article/view`
- 直播：`/xlive/web-room/v1/index/getInfoByRoom`

#### 动态评论区的坑

图文动态的评论区 oid 不是动态 ID。

catbus 先调动态详情接口，取：

- `basic.comment_type == 11`；
- `comment_id_str`，即相簿 ID。

然后拿相簿 ID 请求评论。输出里的 `Comment.item_id` 仍然保留动态 ID。

#### 翻页

- 搜索：页码；
- 用户投稿：页码；
- 评论：`cursor` / `next_offset`；
- 动态：`offset`。

#### 风控

- `-352`、`-799`、`-509`、`-412`；
- 412 会重试；
- 登录、点赞、投币、发布可能触发极验；
- catbus 内置极验点选识别，使用 OCR 模型，失败时退回本地人工页面。

极验的实现全部在 TS 侧（`static/` 没有 bilibili 目录）：`geetest.ts` 实现极验 v3（`9.2.0-guwyxh`）——AES-128-CBC 加密 `w`、RSA、按掩码做位挑选的自定义 base64，先走 fullpage 无感通道；`geetest-vision.ts` 用移植的 ddddocr（`assets-ocr` 模型 + `core/image.ts` 解码 + onnxruntime-web 推理）做点选识别，连续失败时 `geetest-manual.ts` 在本地起页面让人工验证；`gaia.ts` 负责 `ExClimbWuzhi` 指纹上报。

#### 能力

搜索、详情、播放地址、下载、点赞、收藏、投币、三连、评论、弹幕、动态、专栏、直播、用户、收藏夹等。

#### 关键文件

`client.ts`、`sign.ts`、`gaia.ts`、`api.ts`、`commands.ts`、`geetest*.ts`、`ddddocr.ts`、`upos.ts`。

---

### 5.5 快手（kuaishou）

#### 定位

REST + GraphQL + 有状态签名 + 滑块验证码。

#### 两套接口

- `/rest/v/...`：传统 REST；
- `/graphql`：GraphQL。

GraphQL 查询文本是固定的，catbus 直接照抄上游 query 字符串，不能随意改字段顺序。

#### 签名

- `__NS_hxfalcon`：sig4，www / cp 共用；
- `__NS_sig3`：创作者中心；
- `weapon`：`kwfv1`、`kwfcv1`、`kwscode`、`kwssectoken`；
- `gdfp`：设备指纹预检。

`kwscode`、`kwssectoken` 只有约 6 分钟有效期，每条命令开始时现算，不落盘。

`static/kuaishou/` 的支撑：`tools/` 是 kwf / kws / like_token 三把 oracle（上游 `reverse/tools/*_oracle.js` 的命令行脚本），catbus 在 `node:vm` 里按 CommonJS 执行同一份脚本，喂环境变量、收 stdout；`bundles/weapon/` 存官方 kwf 脚本与 kws 混淆脚本（`kws-N-0.0.1-obfuscated.<hash>.js`，32–128 KB，文件名里的 hash 是脚本 MD5 的中间 16 位）。kws 按 signUrl 选对应那一个：先找随包副本，再找 `~/.catbus/cache/kuaishou/kws/`，都没有才下载，并校验地址域名、文件名里的 MD5、大小与内容特征，不用别的变体替代；`fixtures/` 存 GraphQL 网络响应与直播 WebSocket 的 proto 地图。签名器是**有状态**的：实例记录启动时间和调用计数，序列必须按上游节奏走，所以每条命令 new 一个实例，不复用。

#### 主要接口

- 热门推荐：`/rest/v/feed/hot`
- 视频详情：GraphQL `visionVideoDetail`
- 相关推荐：GraphQL `visionShortVideoReco`
- 评论：`/rest/v/photo/comment/list`
- 用户作品：GraphQL 用户作品流
- 搜索：REST 搜索接口
- 直播：直播 REST + WebSocket

#### 翻页

- 大部分列表用 `pcursor`；
- 搜索 cursor 里还带 `searchSessionId`；
- 评论用 `pcursor`。

#### 滑块验证码

1. 识别验证码类型；
2. 拉背景图和滑块图；
3. 计算缺口位置；
4. 生成滑动轨迹；
5. 走 `gdfp` 预检；
6. 提交验证；
7. 用原 Cookie 顺序重放原请求。

#### 能力边界

- 搜索没有 `--sort` / `--type` / `--time` 筛选；
- app / pc 端未实现；
- 部分用户能力只支持 `me`。

#### 关键文件

`session.ts`、`sign.ts`、`gdfp.ts`、`oracle.ts`、`gql.ts`、`captcha.ts`、`gap.ts`、`live.ts`。

---

### 5.6 微博（weibo）

#### 定位

两套站点 + 访客身份 + XSRF。

#### 两个站点

- `weibo.com`：主站，登录 Cookie；
- `m.weibo.cn`：移动端，访客身份。

catbus 的策略：

- 详情、评论、用户作品走 `weibo.com`；
- 搜索走 `m.weibo.cn`；
- 移动端没有登录 Cookie 时，自动申请访客身份，拿 `SUB` / `SUBP`。

访客申请走 `visitor.passport.weibo.cn` 的 `genvisitor2`，访客 Cookie 缓存在凭证里。

#### 请求

- `weibo.com` AJAX 需要 `XSRF-TOKEN`；
- 请求头、Referer、`X-Requested-With` 按浏览器构造；
- 没有复杂请求签名，主要靠 Cookie 和 XSRF。

#### 主要接口

- 微博详情：`m.weibo.cn` 详情页 JSON；
- 搜索：`m.weibo.cn/api/container/getIndex`；
- 评论：`weibo.com/ajax/statuses/buildComments`；
- 用户作品：`weibo.com/ajax/statuses/mymblog`；
- 发布：创作者接口。

#### 关键限制：搜索只取第一页

原因：

- `m.weibo.cn` 访客身份从第二页开始就是登录墙；
- 上游 `searchSome` 也只翻第一页。

#### 评论

只取一级评论，不展开楼中楼。

#### 能力边界

- 只支持 cookie 登录；
- 搜索第一页；
- 评论一级；
- 用户搜索、关注、点赞等没有；
- 发布能力有，但不是重点。

#### 关键文件

`client.ts`、`api.ts`、`commands.ts`、`normalize.ts`、`resolve.ts`、`profile.ts`。

---

### 5.7 闲鱼（xianyu）

#### 定位

mtop H5 接口 + MD5 签名 + 私信长连接。

#### 接口

```text
https://h5api.m.goofish.com/h5/...
```

#### 签名

```text
sign = md5(token & t & appKey & data)
```

其中：

- `token` 来自 Cookie `_m_h5_tk`；
- `t` 是毫秒时间戳；
- `appKey` 是 `34839810`；
- `data` 是请求体 JSON。

token 过期时，catbus 先发一次无签名请求，让服务端下发新的 `_m_h5_tk`，然后用新 token 重签一次。

`static/xianyu/` 三个文件的用法：

- `goofish_js_version_2.js`：上游用 PyExecJS 调的 goofish 辅助 JS，catbus 在 vm 里按顶层函数名取值调用——`generate_sign`、`generate_mid`、`generate_uuid`、`generate_device_id`，以及 `decrypt`（把 IMPaaS 推送里的 base64 + MessagePack 数据解成 JSON）；
- `gen_tfstk.js` + `et_f.js`：生成 cookie `tfstk`。脚本是命令行写法（读 `__dirname` 下的 et_f、结果写 stdout、失败 `process.exit`），catbus 喂一个假 `process` 收结果；脚本内部还会再开一层 vm 补浏览器环境，`ArrayBuffer` / `Error` / `console` 等宿主对象必须透传宿主 realm 的（console 要是完整 Console），否则 et_f 的环境检测不过、算出来是 undefined；失败返回空串，与上游 `_gen_tfstk` 行为一致。

#### 设备

- 生成 deviceId；
- 访问 `log.mmstat.com/eg.js` 拿 `cna`；
- 调两个 mtop 接口拿 `cookie2`；
- 用静态 JS 生成 `tfstk`；
- 写回 Cookie 罐。

#### 能力

- 商品详情；
- 发布商品；
- 当前账号 `me`；
- 私信会话、历史、发送、监听；
- 媒体上传。

#### 没有

- 商品搜索；
- 商品列表；
- 评论；
- 用户主页。

#### 风控

商品详情请求头不能带太多，否则容易触发 `RGV587`。catbus 对详情页只保留最小必要的头。

#### 私信

闲鱼和淘宝共用 `src/platforms/_shared/impaas.ts`，通过钉钉 IMPaaS 的 WebSocket 长连接收发消息。

#### 关键文件

`client.ts`、`sign.ts`、`api.ts`、`commands.ts`、`im.ts`、`profile.ts`。

---

### 5.8 淘宝（taobao）

#### 定位

HTML 识别卖家 + mtop 私信。

签名与推送解析用 `static/taobao/taobao_js_20260407.js`（单文件，含 mtop 签名、设备参数与推送解码），在 vm 里调用导出函数；私信长连接与闲鱼共用 `src/platforms/_shared/impaas.ts`。

#### 卖家识别

`user get <商品链接>` 不是调用户 API，而是：

1. 拉商品页 HTML；
2. 从页面里解析卖家 ID、昵称、店铺 URL；
3. 返回 User。

所以淘宝的 `user get` 只接受商品链接，不接受用户名，也不支持 `me`。

#### 私信

- 用 mtop 接口 `mtop.taobao.login.token.get.h5` 拿 `accessToken`；
- 用 accessToken 连 IMPaaS WebSocket；
- 支持会话历史、发送、监听；
- 不支持 `--to`，因为淘宝没有按用户发起会话的接口。

#### 没有

- 商品详情；
- 商品搜索；
- 评论；
- 用户主页；
- 直播。

#### 能力边界

淘宝更适合做“商品卖家识别 + 客服消息”节点，不适合做内容采集。

#### 关键文件

`client.ts`、`sign.ts`、`api.ts`、`commands.ts`、`im.ts`。

---

### 5.9 京东（jd）

#### 定位

h5st 5.3 + WebM 指纹 + JCAP 验证码。

#### h5st 5.3

京东 `api.m.jd.com` 请求需要 `h5st`。

catbus 不重写算法，而是把上游签名 JS 原样放到 `static/jd/`，在 `node:vm` + `jsdom` 里执行。

脚本会：

- 读取浏览器环境；
- 生成设备指纹；
- 写 localStorage；
- 访问网络；
- 生成 `h5st`、`_stk` 等参数。

catbus 给脚本注入：

- `jsdom`；
- `require('https')` 的 wreq 实现；
- 虚拟文件系统；
- 伪造的 `process.env`；
- 真实网络请求桥。

`static/jd/` 的分工：

- `h5st5_env.js` / `h5st5_lib.js` / `h5st5_server.js`：h5st 5.3 的环境、库与调用侧；
- `pc_tk_lib.js` / `pc_tk_server.js`：WebM 指纹（`webm.ts` 跑）；
- `summer_cryptico_runner.js`：密码加密（登录）；
- `jcap/`：验证码程序（`env/env_core.js` + `run/jcap_ujb96b.js`）；
- `webm/`：`env/run.js` + `run/jdwebm-riskhandle.js`（风控句柄）。

#### WebM

搜索前先跑 WebM 指纹，拿 `x-rp-evtoken` 或类似 token。没有它，搜索可能直接返回验证码。

#### JCAP 验证码

1. 用 `@cv-cat/catbus-assets-jd` 的 ONNX 模型；
2. 起子进程跑官方 `run.js`；
3. 用 `host.js` 把网络和图像求解替换成 catbus 实现；
4. 自动识别、点击、提交；
5. 拿 `vt` 票据重试原请求。

不支持的类型会报 `RISK_CONTROL`，不会无限重试。

#### 主要接口

- 商品详情：`pc_detailpage_wareBusiness`
- 商品搜索：`pc_search_searchWare`
- 商品评价：`getLegoWareDetailComment`
- 优惠券：`getRecommendCoupon`
- 购物车数量：`pcCart_jc_getCartNum`
- 浏览历史、关注商品；
- 订单：订单中心 HTML 页面解析；
- 私信：咚咚 / IMPaaS。

#### 翻页和限制

- 搜索每页 30；
- 评价只取第一页；
- 订单按时间范围分页；
- 地区编码影响价格和库存。

#### 能力边界

- 评价第一页；
- 订单是 HTML 解析；
- app / pc 端未实现；
- 验证码不是所有类型都能自动过。

#### 关键文件

`client.ts`、`js.ts`、`webm.ts`、`jcap.ts`、`api.ts`、`commands.ts`、`login.ts`、`chat.ts`。

---

### 5.10 X（Twitter）

#### 定位

GraphQL + XCTID + 公开 bearer。

#### GraphQL

```text
https://x.com/i/api/graphql/<queryId>/<OperationName>
```

queryId 不写死。

catbus 从 `static/x/graphql.json` 读取：

- `queryId`；
- `operationType`；
- `featureSwitches`；
- `fieldToggles`。

X 前端发版后 queryId 会变，注册表需要同步更新：从上游仓库同步最新的 `graphql.json` 原样替换 `static/x/` 下的副本即可，catbus 运行期只读这个文件，不解析 babel 或产物。

`transaction_l1.json` 同理：XCTID 用的 key、4 帧动画路径与 4 个下标都来自这个静态文件，`web/transaction.ts` 纯 TS 计算（由素材算 animation_key，对 `method!path!t{keyword}{anim_key}` 取 sha256，再混入随机字节做 base64），不执行上游 JS。

#### 请求头

- `authorization: Bearer <公开 bearer>`；
- `x-csrf-token: <ct0>`；
- `x-twitter-auth-type`；
- `x-twitter-client-language`；
- `x-twitter-active-user`；
- `x-client-transaction-id`。

#### XCTID

`x-client-transaction-id` 是每个请求现算的一次性签名。

步骤：

1. 从 `static/x/transaction_l1.json` 读 key、动画帧、索引；
2. 算稳定 `animation_key`；
3. 对 `method!path!t{keyword}{animation_key}` 做 SHA-256；
4. 拼 key bytes、时间、随机字节；
5. base64 编码。

同一输入每次输出不同，因为混入随机字节；固定随机源时可以逐字节对拍。

#### 登录

只支持 cookie 导入，需要：

- `auth_token`；
- `ct0`。

没有账密登录，因为上游依赖 Castle token。

#### 主要能力

- 推文详情；
- 搜索：Top / Latest / People / Media；
- 用户信息、用户作品；
- 首页时间线；
- 评论列表、发评论、点赞；
- 发推、删推、转推、引用；
- 媒体上传；
- 文章（Premium 长文）；
- X Chat 私信。

#### 翻页

- 时间线、搜索、评论：`Bottom` cursor；
- 用户作品：`Bottom` cursor。

#### 风控

- 88：限流；
- 226：自动封禁；
- 344：日上限；
- 登录墙和账号锁定。

#### 能力边界

- 只支持 cookie；
- 需要能访问 X 的网络环境；
- 文章需要 Premium；
- app / pc 端未实现。

#### 关键文件

`graphql.ts`、`transaction.ts`、`profile.ts`、`client.ts`、`api.ts`、`article.ts`、`commands.ts`。

---

### 5.11 12306

#### 定位

公开只读接口，不需要登录。

#### 特殊状态

- `guest: true`；
- 所有查询命令 `auth: optional`；
- 不提供 `auth login`。

#### 车站数据

从官方车站字典 JS 解析：

```text
https://kyfw.12306.cn/otn/resources/js/framework/station_name.js
```

每个车站包含：

- 中文名；
- 电报码；
- 拼音；
- 缩写；
- 城市。

车站列表缓存 24 小时。

#### 余票查询

1. 请求 `/otn/leftTicket/init`；
2. 取 `CLeftTicketUrl`，例如 `queryG`；
3. 拼出真正余票路径；
4. 用出发站、到达站电报码查；
5. 如果响应里又给 `c_url`，更新路径后重试。

#### 余票解析

12306 返回管道分隔的字符串数组。catbus 按固定下标取：

- 车次；
- 出发站、到达站；
- 发车、到达；
- 历时；
- 是否可买；
- 各席别余票；
- `yp_info_new`。

`yp_info_new` 每 10 位一段：

- 席别代码；
- 票价，单位是角，除以 10 得到元；
- 余票数。

余票规则：

- 小于 21 时给精确整数；
- 大于等于 21 时给 `{ min: 21 }`；
- 无座票有 3000 偏移，减掉后是精确数。

#### 其他查询

- 票价：`/otn/leftTicket/queryTicketPrice`
- 经停站：`/otn/czxx/queryByTrainNo`
- 中转：`/lcquery/queryG`

中转结果区分：

- `同车换座`：同一车次分段有座；
- `换乘`：不同车次。

#### 能力边界

- 只读；
- 不登录；
- 不下单、不候补、不退改；
- 受 403 / 429 限流影响。

#### 关键文件

`client.ts`、`api.ts`、`commands.ts`、`normalize.ts`、`resolve.ts`。

测试方面与其他平台不同：没有上游 Python 参考实现、没有对拍 golden，离线测试用真实响应裁剪的 fixture（`tests/fixtures/12306/`），通过 `mockSender` / `fakeResponse` 回放，并单独导出 `parseStations` / `parseYp` 做纯函数断言；`/otn/leftTicket/init` 页面里的 `CLeftTicketUrl` 动态拼路径这一行为也被测试覆盖。

---

## 6. 横向技术分层

按实现难度和会话脆弱度，可以分成三层。

### 第一层：Cookie + 简单 token

代表：

- 微博；
- 12306；
- 闲鱼 / 淘宝的 mtop。

特点：

- 登录 Cookie；
- XSRF；
- mtop token；
- 访客身份。

难点不在算法，而在登录态稳定性和登录墙。

### 第二层：参数签名

代表：

- 小红书；
- 抖音；
- TikTok；
- B 站；
- 快手；
- 京东；
- X。

特点：

- 参数排序；
- 时间戳；
- 随机数；
- 设备指纹；
- 签名算法；
- 请求头顺序。

catbus 的 TypeScript 实现和静态 JS 主要都在这一层。

### 第三层：设备绑定 + 验证码

代表：

- 抖音 UIFID；
- TikTok ticket-guard；
- 京东 JCAP；
- B 站极验；
- 快手滑块；
- 小红书 websectiga。

特点：

- 设备 ID 要和账号绑定；
- localStorage 要一致；
- 私钥、证书要导入；
- 验证码要自动求解；
- 有时需要真实浏览器先建立会话。

这一层最容易失效，也最难移植。

---

## 7. 能力与已知限制

### 7.1 通用限制

- 只实现 web 端；
- app / pc 端是 planned；
- 没有 HTTP 服务；
- 没有 SDK；
- 登录态与浏览器 profile 分离；
- 强依赖上游签名和接口；
- 验证码不是所有类型都能过；
- 平台发版后可能需要更新 `static/` 和签名实现。

### 7.2 平台特定限制

| 平台 | 限制 |
|---|---|
| 小红书 | 详情/评论需要 `xsec_token`；无 `item related` |
| 抖音 | 设备绑定强；UIFID 缺失会被拦；web 端需登录 |
| TikTok | 只支持 cookie；写操作需要 ticket-guard 设备数据 |
| B 站 | 部分操作触发极验；动态评论区 oid 需要特殊解析 |
| 快手 | 搜索无排序/类型/时间筛选；签名有状态 |
| 微博 | 搜索只有第一页；评论只有一级；只支持 cookie |
| 闲鱼 | 无商品搜索、列表、评论；只支持当前账号 `me` |
| 淘宝 | 无商品详情、搜索、评论；`user get` 只接受商品链接 |
| 京东 | 评价只有第一页；订单是 HTML 解析；JCAP 类型有限 |
| X | 只支持 cookie；queryId 会随前端变化；需要可用网络 |
| 12306 | 只读；不登录；不提供购票 |

---

## 8. 测试与工程化

### 8.1 常用命令

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run gen:capabilities
npm run test:e2e -- -t bilibili
```

### 8.2 测试分层

| 层级 | 内容 |
|---|---|
| 单元测试 | 纯函数、签名、解析、归一化 |
| 对拍测试 | 用上游 Python 生成 golden，逐字节比较请求 |
| 离线集成测试 | `replay()` / `mockSender()` 回放真实响应 |
| 在线只读测试 | 使用本机登录态，发真实请求 |
| 冒烟测试 | 打包安装后跑 `version`、`doctor`、`platforms`、签名 VM、原生依赖 |

### 8.3 对拍机制

- 用 `scripts/golden/<p>/gen.py` 调用上游 Python；
- 框架替换 `random`、`secrets`、`uuid`、`os.urandom`、`time`；
- 截获 HTTP 请求，不联网；
- 固定时区 `Asia/Shanghai`；
- 输出 `tests/golden/<p>/<case>.json`；
- TS 侧用 `tests/golden.ts` 的 `replay()` 重新运行；
- `expectRequests()` 比较 URL、header 顺序、cookie、body、签名。

回放实现的细节（`tests/golden.ts`、`tests/setup.ts`）：

- `tests/setup.ts` 在所有离线测试加载前 `mockSender` 直接抛错——误发的真实请求会让测试立刻失败；
- golden 用例结构：`{ input, seed, now, requests[], responses[], result, error }`，请求条目含 method/url/headers/cookies/body/multipart；
- `replay()` 先 `deterministic(seed, now)` 固定随机与时钟，再挂 `mockSender` 逐个返回 `responses`，并按序记录每个 `PreparedRequest`；
- `expectRequests()` 逐条 deepEqual：请求条数不一致时报错（TS 实现多发或漏发都会暴露），body 里的二进制内容以 `{ base64 }` 表示比较；
- 例外：12306 没有上游 Python、没有 golden，用 `tests/fixtures/12306/` 的裁剪响应 + `mockTrain` 路由回放（见 5.11）。

### 8.4 测试文件一览

| 文件 | 覆盖 |
|---|---|
| `tests/core.test.ts` | 错误码、日志脱敏、选项校验、原生词提示、doctor、fsutil、auth-store、config、HttpClient、vm、登录轮询、字符集解码、归一化工具、`checkMsgSend`、`jsonLoads` 等 |
| `tests/golden-core.test.ts` | `py.ts` 兼容编码、curl_cffi URL 拼接语义、确定性随机与时钟 |
| `tests/cli.test.ts` | 全局命令、帮助输出、平台 / 端判定与 UNSUPPORTED 提示、core 的 auth list / use / logout |
| `tests/registry.test.ts` | 注册表约束（handler 命名、词表一致）、`docs/capabilities.md` 是否最新、package.json 钉版本 |
| `tests/runtime.test.ts` | 未知平台 / 端、危险操作确认、分页 `#skip`、流式输出、`supports` 选项、不支持游客态的端 |
| `tests/skill.test.ts` | 技能文件与注册表对照：平台表、提到的命令必须真实存在；`.agents` 副本与 `.claude` 完全一致（含 yaml 头） |
| `tests/<p>.test.ts` | 各平台：签名、登录与设备初始化、业务流、错误映射、私有选项 |
| `tests/bilibili-geetest.test.ts` | 极验：`w` 参数生成（AES + RSA）、挑战路径、ddddocr 点选识别、人工兜底页面 |
| `tests/e2e/*.e2e.ts` | 在线只读链路（见下） |

在线 e2e 的运行方式（不进 CI）：

- `vitest.config.ts` 不加载 `tests/setup.ts`（请求打到真实平台），用例超时 180 s、钩子 60 s；
- `tests/e2e/shapes.ts` 用 zod `strictObject` 定义 6.2 全部类型的结构（字段必须都在，缺失值为 null/[]，多余字段报错）；
- 从注册表枚举每个平台已实现的读取类命令，前面命令返回的对象的 `url`/`id` 喂给后面命令；写操作、下载、长连接不跑；
- 命令间固定间隔（默认 1.5 s，小红书 4 s）；子站点未登录、风控、planned 取值、注册表 note 限制按 skip 处理；
- 每条命令的信封（列表留前 3 条）写到 `.e2e/<platform>.json`（gitignore）核对归一化字段是否取到值。

### 8.5 资源与模型

- 京东 JCAP 模型：`npm run assets:jd`（`scripts/fetch-jd-models.mjs`），按 `src/platforms/jd/UPSTREAM` 记录的 commit 从本地 references/ 复制或 GitHub 下载，逐文件校验 sha256；
- OCR 模型：`npm run assets:ocr`（`scripts/fetch-ocr-models.mjs`）从 PyPI 固定版本的 ddddocr wheel（1.6.1）里提取，wheel 与每个文件都校验 sha256，可用 `CATBUS_DDDDOCR_WHEEL` 指定本地 wheel；包里附带 ddddocr 的 `LICENSE-ddddocr`（MIT）；
- 模型文件不进 git（`.gitignore` 掉 `packages/assets-*/models/`），但 npm workspace 包 `@cv-cat/catbus-assets-{jd,ocr}` 生成 tarball 时会先跑取回脚本；主包把这两个包钉成精确版本；
- 构建产物也不进 git：`npm test` 直接跑 `src/` 的 TS，无需先 build。

### 8.6 能力矩阵

`docs/capabilities.md` 由 `npm run gen:capabilities` 从注册表生成（`scripts/gen-capabilities.mjs` 读 `dist/core/capabilities.js` 渲染——生成器自己也是 TS，所以先 build 再生成）。

手改会被测试打回。

### 8.7 技能同步

`.claude/skills/catbus` 是源，`.agents/skills/catbus` 是 OpenCode 读取的副本。

`tests/skill.test.ts` 会校验两份文件和内容完全一致，并检查技能内容与注册表的一致性：

- SKILL.md 里的平台表（id、别名、item 叫法、登录方式）必须与注册表一致；
- 各平台 `platforms/<id>.md` 里“能做 / 做不到”提到的命令必须真实存在于注册表（从文字里解析 `resource action` 提及）；
- skills 目录结构：`SKILL.md` 总纲 + `platforms/` ×11 + `workflows/{collect,write,live-msg,errors}.md` + `reference/commands.md`。

### 8.8 CI、发布与 Docker

（以下均为 `.github/workflows/` 与 `scripts/` 的静态阅读结论：）

**ci.yml**（push master / PR / 被 release 调用）：

- 测试矩阵：ubuntu / windows / macos × Node 22 / 24 / 26，`fail-fast: false`；
- 模型缓存 key 分别锚定 `src/platforms/jd/UPSTREAM` 与 `fetch-ocr-models.mjs` 的 hash；
- 步骤：`npm ci` → 两个 `assets:*` → `typecheck` → `npm test`；
- `pack`：`npm pack` 三个包并上传 artifact（含 `scripts/smoke.mjs`），冒烟与发布 job 都用这同一份 tarball；
- 冒烟：8 个目标（win/darwin/linux 各 x64+arm64，linux 另分 glibc 与 musl）× Node 22/24，musl 用 Alpine 容器跑 `npm i` + `smoke.mjs`。

**release.yml**（推 `v*` tag）：

1. `check`：tag 与 package.json 版本一致；`scripts/release-notes.mjs` 能从 CHANGELOG.md 取出该版本一节；
2. `ci`：复用上面 ci.yml；
3. `publish`：发布 CI 测过的同一份 tarball，顺序 assets-jd → assets-ocr → catbus-cli；每步先查 npm 上是否已有该版本（幂等，重跑不重复发布）；npm 认证优先 trusted publishing（OIDC，`id-token: write`），未配置时回退 `NPM_TOKEN`；仓库公开时带 `--provenance`；最后用 CHANGELOG 内容建 GitHub Release。

**docker.yml**（路径过滤触发 / 手动）：

- x64 与 arm64 两个 runner 上 `docker build`；
- 镜像里跑 `version`、`doctor`；
- 验证数据写入卷：建 docker volume，`config set timeout 45` 后再 `config get` 检查持久化；
- 以 `--user "$(id -u):$(id -g)"` 非 root 运行，挂载 `data` / `work` 目录写入后文件归当前用户；
- 校验 `compose.yaml` 配置（`catbus` 一次性命令与 `live-listen` 两个服务）。镜像只构建、不推送任何 registry。

**smoke.mjs**（打包后的冒烟测试）：用临时 `CATBUS_HOME`，依次断言 `version`、`doctor`（含 assets 检查）、`platforms`、`--help`、`-e app` 报 `NOT_IMPLEMENTED`、`auth list` 的信封与退出码。

### 8.9 包与构建配置（package.json / tsconfig）

- npm 主包 `catbus-cli`（bin：`catbus` → `dist/cli/main.js`），`files` 只带 `dist`、`static`、`assets/banner.txt`；
- `engines`：`^22.22.2 || ^24.15.0 || >=26.0.0`（跟随 jsdom 30）；
- workspaces：`packages/assets-jd`、`packages/assets-ocr`；
- 运行依赖：`wreq-js`、`zod`、`protobufjs`、`onnxruntime-web`、`@techstark/opencv-js`、`@napi-rs/canvas`、`jsdom`、`crypto-js`、`qrcode`、`smol-toml`，以及两个精确钉版本的 assets 包；原生依赖（wreq-js、canvas）靠 optionalDependencies 的多平台预编译包覆盖全部 6 个目标系统；
- 开发依赖：TypeScript ^7、vitest ^5；
- 脚本：`build` = `clean` + `tsc -p tsconfig.build.json`；`typecheck` 含 `tests/`（tsconfig.json）；`prepack` 先 build；`test` 直接跑 TS 源码；`gen:capabilities`、`assets:jd`、`assets:ocr` 如前述；
- `tsconfig.json`：target ES2024、`moduleResolution: nodenext`、strict、`verbatimModuleSyntax`，include `src` + `tests`；`tsconfig.build.json` 只含 `src`。

### 8.10 本次探索的验证状态

本次以**静态阅读源码和文档**为主。

未执行：

- `npm run typecheck`
- `npm test`
- `npm run build`
- 在线 `test:e2e`

因此本文对行为的描述来自代码阅读和项目文档，不代表当前工作区已经通过完整测试。

---

## 9. 与采析绘的对照和集成评估

> 这一节是外部项目对照，不属于 catbus 官方规范。

### 9.1 两者定位不同

| 维度 | catbus | 采析绘 |
|---|---|---|
| 执行方式 | Node 发 HTTP 请求 | Python + Selenium 驱动浏览器 |
| 数据来源 | JSON / SSR / protobuf | DOM、页面接口 |
| 登录态 | `~/.catbus` | 浏览器 profile / Cookie |
| 输出 | 统一 JSON 信封 | 平台特有中文行 |
| 覆盖 | 11 个固定平台 | 多个平台，含知乎、微信、红果、YouTube、Instagram |
| 扩展方式 | 写平台适配器 | 写 Selenium crawler |

### 9.2 覆盖重叠

重叠平台：

- 微博；
- 小红书；
- B 站；
- 抖音；
- X。

catbus 独有：

- TikTok；
- 快手；
- 闲鱼；
- 淘宝；
- 京东；
- 12306。

采析绘独有：

- 知乎；
- 微信公众号；
- 红果短剧；
- YouTube；
- Instagram。

### 9.3 推荐集成边界

如果要做集成，建议：

```text
采析绘 source node
  → Python CatbusAdapter
  → subprocess: catbus <platform> ... -o jsonl
  → 解析 stdout JSON 行
  → 映射成采析绘现有行结构
  → 写入 run_store
```

不建议：

- 把 catbus 的 TypeScript 移植进 Python；
- 让 catbus 和 Selenium 共享同一个 Cookie 文件；
- 做一个混合所有平台的万能 `catbus` 节点；
- 用 catbus 直接替换采析绘的微博关键词搜索。

### 9.4 各平台取舍建议

| 平台 | 建议 |
|---|---|
| 微博 | 只适合详情/评论增强；搜索第一页，不能替代现有深度搜索 |
| 小红书 | 可作为 API 模式候选；需处理 `xsec_token` 和独立登录 |
| B 站 | 最适合优先接入，覆盖度和稳定性较好 |
| 抖音 | 可补关键词搜索；UIFID/设备绑定要重点验证 |
| X | 适合替代 DOM 抓取；需解决网络和 cookie 登录 |
| TikTok | 新平台，先做只读采集 |
| 快手 | 新平台，签名复杂，先小范围验证 |
| 京东 | 新增电商能力；评价只有第一页 |
| 闲鱼 | 只适合商品/客服节点 |
| 淘宝 | 只适合卖家识别/客服节点 |
| 12306 | 独立查询节点，与内容采集无关 |

### 9.5 行字段映射

catbus 的统一 `Item` 不能直接写入采析绘的中文行。

示例：

**微博**

- `Item.id` → `微博ID`
- `Item.url` → `链接`
- `Item.text` → `正文`
- `Item.author.name` → `发布者`
- `Item.created_at` → `发布时间`
- `Item.stats.likes` → `点赞数`
- `Item.stats.comments` → `评论数`
- `Item.stats.shares` → `转发数`

**小红书**

- `Item.id` → `笔记ID`
- `Item.url` → `笔记链接`
- `Item.title` → `标题`
- `Item.text` → `正文`
- `Item.author.name` → `作者`
- `Item.stats.likes` → `点赞数`
- `Item.stats.collects` → `收藏数`
- `Item.stats.comments` → `评论数`

去重键：

- 小红书用 `Item.id`，不要用带 `xsec_token` 的 URL；
- 微博用 `mid`；
- B 站用 BV 号 / aid；
- 抖音用 aweme_id；
- X 用 tweet id。

### 9.6 评论要独立 handler

采析绘现有评论模式走 `mode.handler == 'comments'`，进入共享 Selenium 评论引擎。

catbus 评论是另一套数据源，建议：

- 新增 `catbus_comments` handler；
- 或给评论路由加“引擎”字段；
- 不要硬塞进现有 Selenium 评论 handler。

### 9.7 游标与断点

- catbus cursor 只在同一平台、同一账号、同一组筛选条件下稳定；
- 不要跨账号复用；
- 不要跨筛选条件复用；
- 去重仍用平台对象 ID，不要只依赖 cursor；
- 把 catbus cursor 存进采析绘自己的 run cursor。

### 9.8 错误映射

| catbus | 采析绘处理 |
|---|---|
| 3 `AUTH_REQUIRED` / `AUTH_EXPIRED` | 提示重新登录，不要当空结果 |
| 5 `RISK_CONTROL` | 标记 blocked / 风控，不要写空表 |
| 6 `NETWORK` | 可重试 |
| 7 `UPSTREAM` | 记录原始错误，按平台决定是否重试 |
| 4 `NOT_IMPLEMENTED` | 该模式不可用，不要静默跳过 |

### 9.9 运行环境

catbus 要求：

```text
^22.22.2 || ^24.15.0 || >=26.0.0
```

子进程集成需要处理：

- `catbus` 可执行文件路径；
- `CATBUS_HOME`；
- 代理；
- 超时；
- 并发；
- 子进程退出码和 stderr。

---

## 10. 主要风险与维护点

### 10.1 签名漂移

平台前端发版后，以下内容可能变化：

- 签名算法；
- 参数名；
- 请求头；
- GraphQL queryId；
- 静态 JS；
- 验证码流程。

需要跟随上游仓库更新。

### 10.2 设备绑定

抖音、TikTok、小红书、快手、京东都有不同程度的设备绑定。

表现：

- 复制 Cookie 后仍然被拦；
- 需要 UIFID、localStorage、私钥；
- 登录后短时间又掉线；
- 同一账号多设备互踢。

### 10.3 验证码

- B 站极验；
- 快手滑块；
- 京东 JCAP；
- 小红书验证码；
- 抖音二次验证。

catbus 能自动过一部分，但不是全部。

### 10.4 第一页限制

- 微博搜索；
- 京东评价；
- 其他上游只实现第一页的接口。

这会影响“全量采集”类需求。

### 10.5 登录态隔离

catbus 与 Selenium 不共享登录态。

这不只是格式问题，还是设备绑定问题。直接把 Selenium Cookie 导入 catbus，不一定能通过风控。

### 10.6 Node 运行时

catbus 需要 Node 22+。

如果集成到 Python 项目，需要额外管理 Node 运行时和 catbus 版本。

### 10.7 并发

catbus 单条命令内部是顺序翻页，没有内建并发。

同一账号并发跑多条命令，可能触发风控或会话互踢。

### 10.8 公开仓库注意事项

根据 `AGENTS.md`：

- 代码、fixture、对拍数据、日志、提交信息里只能有假凭证；
- 真机验证记录、账号与配置状态只放本地；
- `docs/trouble.md`、`docs/roadmap.md` 不进版本控制。

本文不包含任何真实凭证或账号状态。

---

## 11. 待验证清单

以下项目建议在真正使用或集成前逐项验证：

### 11.1 工程验证

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run gen:capabilities` 后 `docs/capabilities.md` 无差异
- [ ] 冒烟测试

### 11.2 平台验证

- [ ] 小红书：带 `xsec_token` 的详情和评论
- [ ] 抖音：UIFID 缺失时的重试
- [ ] TikTok：只有 Cookie 时的读操作；带 ticket-guard 的写操作
- [ ] B 站：极验自动识别和人工回退
- [ ] 快手：滑块验证码和 sig4
- [ ] 微博：搜索第一页、评论一级
- [ ] 闲鱼：mtop token 刷新和私信长连接
- [ ] 淘宝：卖家识别和 accessToken
- [ ] 京东：WebM、JCAP、评价第一页
- [ ] X：GraphQL queryId、XCTID、cookie 登录
- [ ] 12306：动态余票路径和票价单位

### 11.3 集成验证

- [ ] Python 子进程调用 `catbus -o jsonl`
- [ ] stdout / stderr 分离
- [ ] 退出码映射
- [ ] 行字段映射
- [ ] 评论独立 handler
- [ ] run_store 断点与去重
- [ ] 独立 `CATBUS_HOME`
- [ ] 代理和超时
- [ ] 并发和账号隔离

---

## 12. 最终判断

catbus 的爬取原理可以压缩成一句话：

> **它不模拟用户，而是模拟浏览器；不解析页面，而是重放接口。**

优势：

- 结构化输出；
- 速度快；
- 资源占用低；
- 翻页、错误、字段统一；
- 适合批量采集和分析。

代价：

- 强依赖签名逆向；
- 平台前端一改就可能失效；
- 设备绑定和验证码是长期维护点；
- 登录态和 Selenium 不共享；
- 覆盖范围固定，不能替代通用浏览器爬虫。

对采析绘来说，最合理的定位不是“换掉 Selenium”，而是：

> **把 catbus 作为第二种采集引擎，优先补 B 站、抖音关键词、X、TikTok、快手、京东这些现有 Selenium 覆盖不到或成本高的场景；微博、小红书这类强会话绑定的平台，先做小范围验证，不急着替换。**

---

## 附录：本次探索的主要证据文件

### 项目规则与文档

- `AGENTS.md`
- `README.md`
- `docs/capabilities.md`
- `docs/upstream-map.md`
- `docs/platforms/*.md`
- `docs/guide/*.md`

### 核心代码

- `src/cli/main.ts`
- `src/cli/dispatch.ts`
- `src/cli/argv.ts`
- `src/cli/help.ts`
- `src/cli/hints.ts`
- `src/cli/output.ts`
- `src/cli/confirm.ts`
- `src/cli/commands/*.ts`（platforms / doctor / version / auth / config）
- `src/core/registry.ts`
- `src/core/vocab.ts`
- `src/core/options.ts`
- `src/core/auth-store.ts`
- `src/core/auth-handlers.ts`
- `src/core/login.ts`
- `src/core/http.ts`
- `src/core/cookies.ts`
- `src/core/vm.ts`
- `src/core/py.ts`
- `src/core/rand.ts`
- `src/core/pb.ts`
- `src/core/stream.ts`
- `src/core/schemas.ts`
- `src/core/normalize.ts`
- `src/core/toolkit.ts`
- `src/core/files.ts`
- `src/core/image.ts`
- `src/core/mp4.ts`
- `src/core/log.ts`
- `src/core/capabilities.ts`
- `src/core/config.ts`
- `src/core/paths.ts`
- `src/core/fsutil.ts`
- `src/core/hash.ts`
- `src/core/errors.ts`

### 平台代码

- `src/platforms/xhs/web/*`
- `src/platforms/douyin/web/*`
- `src/platforms/tiktok/web/*`
- `src/platforms/bilibili/web/*`
- `src/platforms/kuaishou/web/*`
- `src/platforms/weibo/web/*`
- `src/platforms/xianyu/web/*`
- `src/platforms/taobao/web/*`
- `src/platforms/jd/web/*`
- `src/platforms/x/web/*`
- `src/platforms/12306/web/*`
- `src/platforms/_shared/impaas.ts`

### 测试与构建

- `tests/setup.ts`、`tests/golden.ts`、`tests/helpers.ts`
- `tests/skill.test.ts`、`tests/cli.test.ts`、`tests/registry.test.ts`、`tests/runtime.test.ts`
- `tests/e2e/`（`shapes.ts`、`vitest.config.ts`、`*.e2e.ts`）
- `tests/golden/`、`tests/fixtures/12306/`
- `scripts/golden/`
- `scripts/smoke.mjs`、`scripts/gen-capabilities.mjs`、`scripts/clean.mjs`、`scripts/release-notes.mjs`
- `scripts/fetch-jd-models.mjs`
- `scripts/fetch-ocr-models.mjs`
- `packages/assets-jd/`、`packages/assets-ocr/`（含各自 `package.json`）
- `static/`（各平台资产明细见 2.4）
- `.github/workflows/ci.yml`、`release.yml`、`docker.yml`
- `.claude/skills/catbus/`、`.agents/skills/catbus/`
- `docs/guide/`、`docs/examples/`、`CHANGELOG.md`、`llms.txt`
- `Dockerfile`、`compose.yaml`
- `package.json`
- `tsconfig.json`
- `tsconfig.build.json`

### 外部对照

- 采析绘后端能力矩阵
- 采析绘 Selenium crawler 生命周期
- 采析绘 source node 执行、评论路由、run_store 断点
