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
| 微博 | 规划中 | 规划中 | 不可用：CatBus 没有热榜命令 | 规划中 |
| 小红书 | 规划中 | 不适用 | 不适用 | 规划中 |
| 抖音 | 不适用 | 规划中 | 规划中 | 规划中 |
| X | 规划中 | 规划中 | 不适用 | 规划中 |

“不适用”是采析绘本身没有这个模式；“不可用”是 CatBus 没有对应能力；“规划中”是 CatBus 有能力但列映射还没做。任何非 `available` 的组合都必须由上层展示 `reason`，不能让用户选中后才发现。

B站 hot 的 `ranking` 榜没有注册进 CatBus。适配器收到 `board=ranking` 会报 `UNSUPPORTED`，不会悄悄改成 `popular`。

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

## 5. 后续接入采析绘（等那边空闲时再做）

适配器故意停在子进程 + JSONL 边界，采析绘只需要加一个很薄的 runner：

1. 在节点参数和 `/api/capabilities` 里增加“采集方式”（`selenium` / `catbus`），默认 `selenium`；`平台 × 模式` 的 CatBus 可用性来自 `catbus-crawler-workflow capabilities`。
2. 新增 `CatbusRunner`：按节点参数拼 `run` 命令，读 stdout JSONL 作为行，读 stderr 摘要更新每篇状态；写操作仍然不经过 CatBus。
3. 把 `backend` 写进节点指纹、去重账本和 cursor。切换后端时清掉或隔离对应账本，否则会拿 Selenium 的行去挡 CatBus 的行。
4. CatBus 账号和 Selenium 账号分开配置；CatBus 登录态失效时只提示 `catbus ... auth login`，不尝试拿 Selenium cookie 去补。
5. 服务器 / Docker 可以固定 CatBus 版本；Windows 桌面安装包默认不打包，避免把 Node 运行时和 100MB 级模型塞进安装包。

## 6. 已知限制

- 目前只完成 B站四个模式；有交集的其他平台在清单里明确标为规划中/不可用；知乎、微信、红果短剧、YouTube 与 CatBus 没有交集，不出现在清单里。
- B站 hot 只支持 popular；ranking 未接入 CatBus。
- 微博没有 CatBus 热榜；微博搜索只有第一页；微博评论只有一级。
- 适配器不维护 CatBus 侧的 cursor。一次 `run` 会尽量取到目标条数，详情失败记在 `warnings` / `status` 里；采析绘的去重账本负责跨运行去重，断点续传仍以采析绘自己的 cursor 为准。
- `--raw` 的字段形状来自 CatBus 0.2.1 的上游接口。上游字段变化时先更新 CatBus 的移植和测试，再更新这里的映射。
- CatBus 的 cookie 导入只认 `expirationDate` / `expires`，不认 Selenium 导出的 `expiry`；`httpOnly` / `sameSite` / `secure` 也不会保留。不要直接把 Selenium 的 cookie 文件喂给 CatBus。
