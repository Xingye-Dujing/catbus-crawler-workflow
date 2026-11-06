# 采析绘（crawler_workflow）CatBus 后端适配

这个适配器把 CatBus 的 JSON 输出映射成采析绘现有的表格行，作为 Selenium 之外**用户显式选择**的采集方式。它只改 CatBus 仓库，不修改 `crawler_workflow` 的任何代码。

## 1. 原则

- 采析绘继续默认使用 Selenium；CatBus 只出现在已经适配的 `平台 × 模式` 组合里。
- 不可用或只完成一部分的组合必须带原因，不做自动回退，也不静默换榜单。
- 输出列沿用采析绘现有契约。CatBus 拿不到的视频计数字段留空，不能写成 `0`；真实 `0` 仍然是 `0`。评论表的等级、点赞数、子回复数、回复数沿用 Selenium 的 `_as_int` 语义，缺失为 `0`。
- 后端是节点指纹、去重账本和 cursor 的一部分。换后端等于重新采集，不能把 Selenium 的行和 CatBus 的行混成一个账本。
- CatBus 使用自己的账号文件，不复用 Selenium cookie。运行前先 `catbus bilibili auth login`，命令里用 `-a <CatBus 账号>` 或 `--account`。

## 2. 当前矩阵

`catbus-crawler-workflow capabilities` 输出机器可读的完整清单；这里是摘要。

| 平台 | posts | author | hot | comments |
|---|---|---|---|---|
| B站 | CatBus 可用 | CatBus 可用 | CatBus 部分（只有热门 popular） | CatBus 可用 |
| 微博 | CatBus 部分（只有第一页） | CatBus 可用 | 不可用：CatBus 没有热榜命令 | CatBus 部分（只有一级评论） |
| 小红书 | CatBus 可用 | CatBus 可用（引擎独有） | 不可用：没有榜单 | CatBus 可用（根评论 + 子回复） |
| 抖音 | CatBus 可用（引擎独有） | CatBus 可用 | 不可用：上游 `feed list --kind hot` 是 `NOT_IMPLEMENTED` | CatBus 可用（根评论 + 子回复） |
| X | CatBus 可用 | CatBus 可用 | 不可用：feed list 只有推荐流 | CatBus 可用（不展开楼中楼） |
| 快手 | CatBus 部分（搜索无筛选） | CatBus 可用 | 不可用：feed list 是推荐流 | CatBus 部分（子回复只核对过一组参数） |
| TikTok | CatBus 可用 | CatBus 可用 | 不可用：feed list 是推荐流 | CatBus 可用 |
| 京东 / 淘宝 / 闲鱼 | 无共享模式 | 无共享模式 | 无共享模式 | 无共享模式 |

“不可用”是 CatBus 没有对应能力；“部分”是上游只支持一部分，原因写在清单的 `reason` 里；任何非 `available` 的组合都必须由上层展示原因，不能让用户选中后才发现。京东 / 淘宝 / 闲鱼的“商品”不是帖子，不套用 posts/author/hot/comments 语义，只用下面生成的独有模式（如 `item.search`、`comment.list`、`product.get`）。

B站 hot 的 `ranking` 榜没有注册进 CatBus。适配器收到 `board=ranking` 会报 `UNSUPPORTED`，不会悄悄改成 `popular`。

### CatBus 独有只读模式

注册表里**已实现、只读、非流式、输出是表格类型**的命令会自动变成一条模式（`user followers` → `user.followers`），`capabilities` 里带命令路径、位置参数、输出类型、通用列与身份列。覆盖粉丝/关注/点赞/收藏列表、用户搜索与资料、作品详情/相关推荐/媒体地址、热搜词与联想词、推荐流分类、收藏夹/合集/浏览历史、话题/地点搜索、直播间/礼物/排行榜、通知等。

- **写操作一律不进**：`write()` 声明的命令带 `mutating: true`，生成时机械排除；测试同时从 `vocab.ts` 源码清点核对，防止绕过 `write()` 声明一个会改平台状态的命令。
- **私信不出现**（`msg *`）：这是用户的私人通信，不是采析绘要采集的内容。
- 通用模式的列按输出类型定义在 `columns.ts`（`ITEM_COLUMNS` / `USER_COLUMNS` / `KEYWORD_COLUMNS` …），同一类型跨平台同列，不另造方言。
- 参数名沿用采析绘已有字段：`author` 填用户，`urls` 填作品链接，`keyword` 填关键词；`room` / `folder` / `series` / `conversation` / `product` / `comment_id` 是独有模式的新字段。省略 `user` 的命令（如 `folder list`）用命令自己的默认值 `me`。

## 3. 运行

```bash
npm run build
node dist/integrations/crawler-workflow/cli.js capabilities
node dist/integrations/crawler-workflow/cli.js preflight --platform bilibili

# 评论：params 的 urls 可以是数组，也可以是换行分隔的字符串
node dist/integrations/crawler-workflow/cli.js run \
  --platform bilibili --mode comments \
  --params '{"urls":["https://www.bilibili.com/video/BV1xx411c7mD"],"comment_limit":100}'

# 也可以直接用快捷选项
node dist/integrations/crawler-workflow/cli.js run \
  --platform bilibili --mode posts --keyword 机械键盘 --target-count 50

node dist/integrations/crawler-workflow/cli.js run \
  --platform bilibili --mode author --author 2 --target-count 50

node dist/integrations/crawler-workflow/cli.js run \
  --platform bilibili --mode hot --board popular --target-count 50
```

全局安装后命令名是 `catbus-crawler-workflow`。`--catbus-bin` 可以指定另一个 CatBus 可执行文件或 `dist/cli/main.js`；默认优先使用同包的 `dist/cli/main.js`，否则走 `PATH` 里的 `catbus`。

`preflight --platform bilibili` 单独调用 `catbus bilibili auth status`，输出 `{ok, backend, endpoint, platform, account, logged_in, user, method, expires_at, error}`。成功和失败都向 stdout 输出这一结构；未登录时退出码 3，并给出 `catbus bilibili auth login` 提示。它不会读取或改写 Selenium cookie。

采析绘节点里的 `account` 是 Selenium 账号，适配器不读；CatBus 账号只认 `params.catbus_account` 或 `--account`。两者可以同名，但存储和登录态完全独立。

`--params` 接受 JSON 字符串、`@文件` 或 `-`（stdin）。采析绘的 `recrawl`、`format`、`part_size`、`per_article_file` 等执行层字段会原样保留但不消费：分片、格式、断点续传仍由采析绘自己负责。

## 4. 输出契约

stdout 每行一条采析绘表格行；`-o json` 时是一个数组。默认的 jsonl **产出一条就写一条**：采析绘把每行写成一个事务，中途 停止 或后面失败都不会丢掉已经落地的行。stderr 最后一行是摘要：

```json
{
  "ok": true,
  "backend": "catbus",
  "endpoint": "web",
  "platform": "bilibili",
  "platform_input": "bilibili",
  "mode": "comments",
  "status": "ok",
  "rows": 2,
  "columns": ["平台", "文章URL", "评论者", "..."],
  "account": "default",
  "warnings": [],
  "articles": [{"url": "https://...", "status": "ok", "rows": 2, "error": null}],
  "error": null
}
```

- `status`：`ok` / `partial` / `blocked` / `dead` / `error`。`partial` 表示有行但部分链接或详情失败。
- `articles` 逐篇报告评论状态，供采析绘复用 `ok` / `blocked` / `dead` 的既有语义。
- 退出码沿用 CatBus：1 未分类，2 用法/不支持，3 登录，4 未实现，5 风控，6 网络，7 上游错误。`partial` 返回 0，由摘要里的 `warnings` / `articles` 决定是否提示用户。
- 失败时摘要的 `rows` 是**实际已经写出的行数**，不是 0：jsonl 下 stdout 已经交出的行不撤回（采析绘按行记账，这些行是真数据）；`-o json` 因为格式本身是一个数组，失败时不写出数组，只有 stderr 的摘要。
- `--provenance` 会在每行末尾追加 `采集方式=catbus`。默认不加，保证和现有列契约一致。

### B站视频列

`标题, UP主, UP主ID, 正文, 发布时间, BV号, 稿件ID, 合集, 分P数, 时长秒, 播放数, 点赞数, 投币数, 收藏数, 转发数, 弹幕数, 评论数, 链接`

CatBus 的归一化 `Item.stats` 只有播放/点赞/评论/收藏/转发，投币、弹幕、合集、分P、UP主ID 必须从 `--raw` 取。搜索和作者列表的卡片统计不完整，所以适配器会逐条调用 `item get --raw`，和现有 Selenium 版逐条解析详情的行为一致。

### B站评论列

`平台, 文章URL, 评论者, 评论者主页, 用户等级, 评论内容, 评论时间, 点赞数, 楼层, 评论ID, 父评论ID, 子回复数, 回复数, UP主态`

- 根评论 + 接口随附的 `replies` 预览楼中楼；`子回复数` 保留未展开的剩余部分。完整楼中楼仍不在 comments 模式展开，和现有 Selenium 版一致。
- 楼层从 1 开始，跨根评论和预览子回复连续编号；预览子回复的 `父评论ID` 是根评论 ID。
- 时间按北京时间 `YYYY-MM-DD HH:MM:SS` 渲染，和采析绘的 `_stamp` 一致。
- 用户等级取 `member.level_info.current_level`；UP主态先看 `card_label` 里有没有“UP主”标记，再看 `up_action.like`。

### 其他平台的共享模式列

微博 / 小红书 / 抖音 / X / 快手 / TikTok 的共享模式**不用 `--raw`**：CatBus 已经把结果归一化成 `Item` / `Comment`，适配器只把归一化字段摆进采析绘同平台的列（`columns.ts`）：

- 微博：`发布者, 发布时间, 发布来源, 正文, 转发数, 评论数, 点赞数, 图片链接, 图片数, 话题, 视频数, 用户链接, 链接, 微博ID`；发布来源不在归一化输出里，留空。
- 小红书：`笔记链接, 笔记ID, 标题, 作者, 点赞数, 正文, 发布时间, 收藏数, 评论数, 评论列表`；搜索卡片没有正文与评论预览，留空。
- 抖音：`标题, 正文, 作者, 粉丝数, 获赞数, 发布时间, 视频ID, 点赞数, 评论数, 收藏数, 转发数, 链接`；单条粉丝数/获赞数接口没给，留空。
- X：与 Selenium 版同列；引用/卡片/投票标记不在归一化输出里，留空。
- 快手 / TikTok：没有 Selenium 表，用通用作品/评论列（`ITEM_COLUMNS` / `COMMENT_COLUMNS`）。
- 评论的 `评论ID` / `父评论ID` 取自归一化输出；小红书、抖音、快手、TikTok 会按父评论再问一次 `comment replies` 展开一层子回复，楼层连续，父评论 ID 是根评论 ID。微博只取一级评论，X 不展开楼中楼（上游没有对应命令）。

## 5. 采析绘侧的三维模型

适配器停在子进程 + JSONL 边界。采析绘按 **平台 × 引擎 × 功能** 组织：

1. 节点参数有 `backend`（`selenium` / `catbus`），进指纹、去重账本和 cursor；两个引擎不共用账本。
2. 面板先选平台，再选引擎，功能列表随引擎变：Selenium 列出自己的模式，CatBus 列出 `capabilities` 里该平台的模式。不可运行的仍**列出 + 置灰 + 写明原因**，绝不静默换成另一个模式。
3. CatBus 独有模式（`user.followers` 等）走同一条 `run` 子进程边界，参数通过 stdin 传给适配器；写命令不在清单里，面板也没有入口。
4. CatBus 账号和 Selenium 账号分开配置；CatBus 登录态失效时只提示 `catbus ... auth login`，不尝试拿 Selenium cookie 去补。
5. 服务器 / Docker 可以固定 CatBus 版本；Windows 桌面安装包默认不打包，避免把 Node 运行时和 100MB 级模型塞进安装包。

## 6. 已知限制

- 共享模式覆盖 B站、微博、小红书、抖音、X、快手、TikTok 的 28 个格子，其中 6 个按上游事实标为不可用（各平台热榜、微博热榜等）；抖音热榜按上游事实仍是不可用（`feed list --kind hot` 是 `NOT_IMPLEMENTED`），没有冒充。京东 / 淘宝 / 闲鱼只提供注册表里真实实现的读命令；知乎、微信、红果短剧、YouTube 与 CatBus 没有交集，不出现在清单里。
- 微博搜索只有第一页、微博评论只有一级；快手搜索没有筛选；快手子回复只核对过一组抓包参数——都写进清单的 `reason`，由上层展示。
- CatBus 独有模式按输出类型映射成通用列；它们不是 Selenium 表的替代，同一平台的两套模式喂给分析节点时列名不同是事实，不是错误。
- B站 hot 只支持 popular；ranking 未接入 CatBus。
- 微博没有 CatBus 热榜；微博搜索只有第一页；微博评论只有一级。
- 适配器不维护 CatBus 侧的 cursor。一次 `run` 会尽量取到目标条数，详情失败记在 `warnings` / `status` 里；采析绘的去重账本负责跨运行去重，断点续传仍以采析绘自己的 cursor 为准。
- `--raw` 的字段形状来自 CatBus 0.3.0 的上游接口（同步基线 `cv-cat/catbus` `87dfce4`，其 CI 全绿）。上游字段变化时先更新 CatBus 的移植和测试，再更新这里的映射。
- CatBus 的 cookie 导入只认 `expirationDate` / `expires`，不认 Selenium 导出的 `expiry`；`httpOnly` / `sameSite` / `secure` 也不会保留。不要直接把 Selenium 的 cookie 文件喂给 CatBus。

## 7. 同步上游

本仓库是 [`cv-cat/catbus`](https://github.com/cv-cat/catbus) 的分支，`master` 同时保留上游历史与采析绘适配提交。同步只做一件事：把上游**最新一个 CI 全绿**的提交合进来，再验证适配。

```bash
npm run sync:upstream -- --crawler-workflow <采析绘仓库目录>          # 合并并验证，不推送
npm run sync:upstream -- --crawler-workflow <采析绘仓库目录> --push   # 验证通过后推 origin
```

脚本（`scripts/sync-upstream.mjs`）的规则：

1. `git fetch upstream` 后从 `upstream/master` 由新到旧找提交；用 `gh run list` 看该提交的**每一条** workflow——有失败、取消或还在跑的都跳过，取最新的全部完成且没有失败的版本。截至本次同步，最新提交 `ee20285`（YouTube）CI 是红的，因此停在 `87dfce4`（0.3.0）。
2. `git merge --no-commit` 合并，然后 `npm ci` → `npm run build` → `npm test` → `node scripts/audit-mutating.mjs`；给了 `--crawler-workflow` 时还会用 `CATBUS_HOME=<本仓库>` 跑采析绘的 `tests/integration/test_catbus_adapter.py`。
3. 任何一步失败就 `git merge --abort`，不留下坏提交；全部通过才提交，`--push` 才推送。
4. 冲突不自动解决：脚本会停下并保留冲突现场，按 `docs/crawler-workflow.md` 的平台映射与 `mutating` 约定人工处理后重跑。

**写命令体检**是同步的硬门槛：`scripts/audit-mutating.mjs` 会找出所有以写动作结尾、却既没有 `mutating` 也没有 `confirm` 的平台命令，并检查适配器清单里没有写命令。上游新增的写命令必须补 `mutating: true`，否则它会作为“读模式”出现在采析绘面板上。

