import { findPlatform } from '../../platforms/index.js'
import { BILIBILI_COMMENT_COLUMNS, BILIBILI_VIDEO_COLUMNS } from './bilibili.js'
import {
  DOUYIN_COMMENT_COLUMNS,
  DOUYIN_VIDEO_COLUMNS,
  ITEM_COLUMNS,
  COMMENT_COLUMNS,
  TABLE_OUTPUTS,
  OUTPUT_COLUMNS,
  TWITTER_COMMENT_COLUMNS,
  TWITTER_POST_COLUMNS,
  WEIBO_COMMENT_COLUMNS,
  WEIBO_POST_COLUMNS,
  XHS_COMMENT_COLUMNS,
  XHS_NOTE_COLUMNS,
} from './columns.js'
import { ARG_PARAMS, identityColumn } from './generic.js'
import type { BackendManifest, CrawlerMode, ModeCapability, PlatformCapability } from './types.js'

/**
 * 采析绘的 CatBus 清单。
 *
 * 两件事分开：
 * - **共享模式**（posts/author/hot/comments）在这里声明，因为它们是采析绘与 Selenium 版同名的功能，
 *   列顺序要与 Selenium 表一致；每个平台写清可用性与理由。
 * - **CatBus 独有模式**从注册表**生成**：凡是平台 web 端已实现、只读、非流式、输出是表格类型的命令，
 *   都变成一条模式（`user followers` → `user.followers`）。这样「只读能力全部进来」不是一张
 *   需要人记得更新的名单，而是注册表本身；新增一个读命令，下一次 capabilities 就有了。
 *
 * 写命令由 `write()` 打上 `mutating`，生成时机械排除；测试再从 `vocab.ts` 源码清点核对，
 * 防止有人绕过 `write()` 声明一个会改平台状态的命令。
 */

const sharedMode = (opts: {
  status: ModeCapability['status']
  handler: 'posts' | 'author' | 'hot' | 'comments'
  command: string
  columns: string[]
  identity: string[]
  params: string[]
  note?: string
  reason?: string
}): ModeCapability => ({
  status: opts.status,
  handler: opts.handler,
  command: opts.command,
  args: [],
  optional: {},
  paged: true,
  output: '',
  catbus: [],
  params: opts.params,
  columns: opts.columns,
  identity: opts.identity,
  auth: 'required',
  ...(opts.note ? { note: opts.note } : {}),
  ...(opts.reason ? { reason: opts.reason } : {}),
})

const unavailable = (reason: string): ModeCapability => ({
  status: 'unavailable',
  catbus: [],
  params: [],
  columns: [],
  auth: 'required',
  reason,
})

const PLATFORM_IDS: Array<{ id: string; catbus: string }> = [
  { id: 'bilibili', catbus: 'bilibili' },
  { id: 'weibo', catbus: 'weibo' },
  { id: 'xiaohongshu', catbus: 'xhs' },
  { id: 'douyin', catbus: 'douyin' },
  { id: 'twitter', catbus: 'x' },
  { id: 'kuaishou', catbus: 'kuaishou' },
  { id: 'tiktok', catbus: 'tiktok' },
  { id: 'jd', catbus: 'jd' },
  { id: 'taobao', catbus: 'taobao' },
  { id: 'xianyu', catbus: 'xianyu' },
]

/** 共享模式背后那条 CatBus 命令；生成独有模式时跳过它们，免得同一个命令出现两次。 */
const SHARED_COMMANDS: Record<string, string[]> = {
  bilibili: ['item search', 'user items', 'feed list', 'comment list'],
  weibo: ['item search', 'user items', 'comment list'],
  xiaohongshu: ['item search', 'user items', 'comment list'],
  douyin: ['item search', 'user items', 'comment list'],
  twitter: ['item search', 'user items', 'comment list'],
  kuaishou: ['item search', 'user items', 'comment list'],
  tiktok: ['item search', 'user items', 'comment list'],
  jd: [],
  taobao: [],
  xianyu: [],
}

function sharedModes(id: string, columns: { item: string[]; comment: string[] }): Record<string, ModeCapability> {
  switch (id) {
    case 'bilibili':
      return {
        posts: {
          status: 'available',
          handler: 'posts',
          command: 'item search',
          args: [],
          optional: {},
          paged: true,
          output: 'Item',
          catbus: ['bilibili', 'item', 'search', '<keyword>', '--limit', '<target_count>', '--raw'],
          params: ['keyword', 'target_count', 'catbus_account'],
          columns: BILIBILI_VIDEO_COLUMNS,
          identity: ['链接'],
          auth: 'required',
          note: '搜索卡片逐条用 item get 补齐统计；列顺序和 Selenium 版一致，接口没给的计数留空。',
        },
        author: {
          status: 'available',
          handler: 'author',
          command: 'user items',
          args: [],
          optional: {},
          paged: true,
          output: 'Item',
          catbus: ['bilibili', 'user', 'items', '<author>', '--limit', '<target_count>', '--raw'],
          params: ['author', 'target_count', 'catbus_account'],
          columns: BILIBILI_VIDEO_COLUMNS,
          identity: ['链接'],
          auth: 'required',
          note: '走 CatBus 的 user items；同样逐条补齐详情。',
        },
        hot: {
          status: 'partial',
          handler: 'hot',
          command: 'feed list',
          args: [],
          optional: {},
          paged: true,
          output: 'Item',
          catbus: ['bilibili', 'feed', 'list', '--kind', 'hot', '--limit', '<target_count>', '--raw'],
          params: ['board', 'target_count', 'catbus_account'],
          columns: BILIBILI_VIDEO_COLUMNS,
          identity: ['链接'],
          auth: 'required',
          note: '只支持热门（popular）。排行榜（ranking）没有注册进 CatBus，选它必须明确报错，不能悄悄换成 popular。',
          reason: '排行榜 ranking 尚未接入 CatBus；热门 popular 可用。',
        },
        comments: {
          status: 'available',
          handler: 'comments',
          command: 'comment list',
          args: [],
          optional: {},
          paged: true,
          output: 'Comment',
          catbus: ['bilibili', 'comment', 'list', '<url>', '--raw'],
          params: ['urls', 'comment_limit', 'catbus_account'],
          columns: BILIBILI_COMMENT_COLUMNS,
          identity: ['平台', '评论ID'],
          auth: 'required',
          note: '根评论 + 接口随附的预览楼中楼，和现有 Selenium 版一致；完整楼中楼仍不在本模式展开。',
        },
      }
    case 'weibo':
      return {
        posts: sharedMode({
          status: 'partial',
          handler: 'posts',
          command: 'item search',
          columns: WEIBO_POST_COLUMNS,
          identity: ['微博ID'],
          params: ['keyword', 'target_count', 'catbus_account'],
          note: 'CatBus 的微博搜索只返回第一页；列与 Selenium 版一致，接口没给的计数留空。',
          reason: 'CatBus 的微博搜索只返回第一页，无法承诺 target_count。',
        }),
        author: sharedMode({
          status: 'available',
          handler: 'author',
          command: 'user items',
          columns: WEIBO_POST_COLUMNS,
          identity: ['微博ID'],
          params: ['author', 'target_count', 'catbus_account'],
          note: '走 CatBus 的 user items；列与搜索模式一致。',
        }),
        comments: sharedMode({
          status: 'partial',
          handler: 'comments',
          command: 'comment list',
          columns: WEIBO_COMMENT_COLUMNS,
          identity: ['平台', '评论ID'],
          params: ['urls', 'comment_limit', 'catbus_account'],
          note: 'CatBus 的微博 comment list 只返回一级评论；楼中楼没有对应的读命令，所以不假装展开了。',
          reason: 'CatBus 的微博 comment replies 尚未实现，只能取一级评论。',
        }),
        hot: unavailable('CatBus 没有注册微博热搜/热榜命令；feed list 也不覆盖微博。'),
      }
    case 'xiaohongshu':
      return {
        posts: sharedMode({
          status: 'available',
          handler: 'posts',
          command: 'item search',
          columns: XHS_NOTE_COLUMNS,
          identity: ['笔记ID'],
          params: ['keyword', 'target_count', 'catbus_account'],
          note: 'CatBus 的小红书搜索卡片已归一化；正文与评论预览没有在卡片里，留空而不是编造。',
        }),
        author: sharedMode({
          status: 'available',
          handler: 'author',
          command: 'user items',
          columns: XHS_NOTE_COLUMNS,
          identity: ['笔记ID'],
          params: ['author', 'target_count', 'catbus_account'],
          note: 'Selenium 版没有小红书作者模式；这是 CatBus 引擎独有的读能力。',
        }),
        comments: sharedMode({
          status: 'available',
          handler: 'comments',
          command: 'comment list',
          columns: XHS_COMMENT_COLUMNS,
          identity: ['平台', '评论ID'],
          params: ['urls', 'comment_limit', 'catbus_account'],
          note: '根评论 + 按父评论展开子回复（comment replies）；列与 Selenium 版一致并补上评论 ID。',
        }),
        hot: unavailable('采析绘与 CatBus 都没有小红书热榜；feed list 是推荐流，不是榜单。'),
      }
    case 'douyin':
      return {
        posts: sharedMode({
          status: 'available',
          handler: 'posts',
          command: 'item search',
          columns: DOUYIN_VIDEO_COLUMNS,
          identity: ['视频ID'],
          params: ['keyword', 'target_count', 'catbus_account'],
          note: 'Selenium 版没有抖音关键词模式；CatBus 的 item search 是引擎独有的读能力。',
        }),
        author: sharedMode({
          status: 'available',
          handler: 'author',
          command: 'user items',
          columns: DOUYIN_VIDEO_COLUMNS,
          identity: ['视频ID'],
          params: ['author', 'target_count', 'catbus_account'],
          note: '走 CatBus 的 user items；列与 Selenium 版一致，单条粉丝数/获赞数接口没给就留空。',
        }),
        comments: sharedMode({
          status: 'available',
          handler: 'comments',
          command: 'comment list',
          columns: DOUYIN_COMMENT_COLUMNS,
          identity: ['平台', '评论ID'],
          params: ['urls', 'comment_limit', 'catbus_account'],
          note: '根评论 + 按父评论展开子回复；评论地区接口没给，留空。',
        }),
        hot: unavailable('CatBus 的抖音 feed list 只实现推荐流；hot 在上游是 NOT_IMPLEMENTED，不能冒充。'),
      }
    case 'twitter':
      return {
        posts: sharedMode({
          status: 'available',
          handler: 'posts',
          command: 'item search',
          columns: TWITTER_POST_COLUMNS,
          identity: ['推文ID'],
          params: ['keyword', 'target_count', 'catbus_account'],
          note: '列与 Selenium 版一致；引用/卡片/投票标记不在归一化输出里，留空。',
        }),
        author: sharedMode({
          status: 'available',
          handler: 'author',
          command: 'user items',
          columns: TWITTER_POST_COLUMNS,
          identity: ['推文ID'],
          params: ['author', 'target_count', 'catbus_account'],
          note: '走 CatBus 的 user items。',
        }),
        comments: sharedMode({
          status: 'available',
          handler: 'comments',
          command: 'comment list',
          columns: TWITTER_COMMENT_COLUMNS,
          identity: ['平台', '评论ID'],
          params: ['urls', 'comment_limit', 'catbus_account'],
          note: '回复列表来自 CatBus 的 comment list；X 没有单独的 comment replies 命令，楼中楼不展开。',
        }),
        hot: unavailable('CatBus 的 X feed list 只有推荐流，没有热榜。'),
      }
    case 'kuaishou':
      return {
        posts: sharedMode({
          status: 'partial',
          handler: 'posts',
          command: 'item search',
          columns: columns.item,
          identity: ['作品ID'],
          params: ['keyword', 'target_count', 'catbus_account'],
          note: 'CatBus 的快手搜索没有筛选，只按关键词搜。',
          reason: '上游搜索不支持排序/类型/时间筛选。',
        }),
        author: sharedMode({
          status: 'available',
          handler: 'author',
          command: 'user items',
          columns: columns.item,
          identity: ['作品ID'],
          params: ['author', 'target_count', 'catbus_account'],
          note: 'CatBus 独有的平台：采析绘没有快手 Selenium 版，列用通用作品表。',
        }),
        comments: sharedMode({
          status: 'partial',
          handler: 'comments',
          command: 'comment list',
          columns: columns.comment,
          identity: ['平台', '评论ID'],
          params: ['urls', 'comment_limit', 'catbus_account'],
          note: '子回复接口只核对过一组抓包参数；能取到的照实写。',
          reason: '快手的 comment replies 上游只部分核对过。',
        }),
        hot: unavailable('CatBus 的快手 feed list 是推荐流（new-reco），不是热榜。'),
      }
    case 'tiktok':
      return {
        posts: sharedMode({
          status: 'available',
          handler: 'posts',
          command: 'item search',
          columns: columns.item,
          identity: ['作品ID'],
          params: ['keyword', 'target_count', 'catbus_account'],
          note: 'CatBus 独有的平台：采析绘没有 TikTok Selenium 版，列用通用作品表。',
        }),
        author: sharedMode({
          status: 'available',
          handler: 'author',
          command: 'user items',
          columns: columns.item,
          identity: ['作品ID'],
          params: ['author', 'target_count', 'catbus_account'],
          note: '走 CatBus 的 user items。',
        }),
        comments: sharedMode({
          status: 'available',
          handler: 'comments',
          command: 'comment list',
          columns: columns.comment,
          identity: ['平台', '评论ID'],
          params: ['urls', 'comment_limit', 'catbus_account'],
          note: '根评论 + 按父评论展开子回复。',
        }),
        hot: unavailable('CatBus 的 TikTok feed list 是推荐流，不是热榜。'),
      }
    default:
      // 电商平台没有「作品/作者/热榜/评论」这套 Selenium 语义：只出注册表里真实实现的读命令。
      return {}
  }
}

/** 表里平台的展示名来自注册表，不在这里抄第二份。 */
function labelOf(catbusId: string): string {
  return findPlatform(catbusId)?.name ?? catbusId
}

/**
 * 注册表 → CatBus 独有模式。
 *
 * 只收：已实现（有 handler）、只读（没有 `mutating`）、非流式、输出是表格类型、且每个位置参数
 * 都有采析绘字段可填。少一条就不出现——宁可少一个入口，不做一个点下去必然失败的按钮。
 *
 * `msg` 是唯一按资源整体排除的只读面：私信是用户的私人通信，不是采析绘要采集的内容；
 * 把它摆成一个「采集模式」会让一次点击把收件箱导出成表。通知、浏览历史等清单里明确列出的读能力不受影响。
 */
function generatedModes(catbusId: string, sharedCommands: string[]): Record<string, ModeCapability> {
  const platform = findPlatform(catbusId)
  if (!platform || platform.endpoints.web === 'planned') return {}
  const out: Record<string, ModeCapability> = {}
  for (const [key, command] of platform.endpoints.web.commands) {
    if (!command.handler || command.status !== 'implemented') continue
    if (command.mutating || command.stream || command.confirm) continue
    if (key.startsWith('auth ') || key.startsWith('msg ')) continue
    if (sharedCommands.includes(key)) continue
    const output = command.output.replace(/\[\]$/, '')
    if (!TABLE_OUTPUTS.has(output)) continue
    const args = command.args.map((a) => a.name)
    if (args.some((a) => !(a in ARG_PARAMS))) continue
    const optional: Record<string, string> = {}
    for (const a of command.args) {
      if (a.optional) optional[a.name] = a.default ?? ''
    }
    const params = [...new Set([...args.map((a) => ARG_PARAMS[a]!), ...(command.paged ? ['target_count'] : []), 'catbus_account'])]
    const mode = key.replace(' ', '.')
    out[mode] = {
      status: command.upstream === 'partial' ? 'partial' : 'available',
      command: key,
      args,
      optional,
      paged: Boolean(command.paged),
      output,
      catbus: [
        catbusId,
        ...key.split(' '),
        ...args.map((a) => `<${ARG_PARAMS[a]}>`),
        ...(command.paged ? ['--limit', '<target_count>'] : []),
      ],
      params,
      columns: OUTPUT_COLUMNS[output] ?? [],
      identity: ['平台', identityColumn(output)],
      auth: 'required',
      ...(command.note ? { note: command.note } : {}),
      ...(command.upstream === 'partial' ? { reason: command.note ?? 'CatBus 上游部分支持。' } : {}),
    }
  }
  return out
}

/** 采析绘的平台 id 是 xiaohongshu / twitter，CatBus 是 xhs / x；清单以采析绘侧为准。 */
export function manifest(): BackendManifest {
  const platforms: Record<string, PlatformCapability> = {}
  for (const { id, catbus } of PLATFORM_IDS) {
    const columns = columnsFor(id)
    const modes = {
      ...sharedModes(id, columns),
      ...generatedModes(catbus, SHARED_COMMANDS[id] ?? []),
    }
    platforms[id] = { catbus_platform: catbus, label: labelOf(catbus), modes }
  }
  return {
    schema: 1,
    backend: 'catbus',
    label: 'CatBus',
    endpoint: 'web',
    platforms,
    requirements: {
      node: '^22.22.2 || ^24.15.0 || >=26.0.0',
      catbus: 'catbus 0.2.1 或更高',
      auth: 'CatBus 账号独立于 Selenium cookie；先运行 catbus <平台> auth login',
    },
    deployment: {
      server: true,
      desktop: false,
    },
  }
}

function columnsFor(id: string): { item: string[]; comment: string[] } {
  switch (id) {
    case 'bilibili':
      return { item: BILIBILI_VIDEO_COLUMNS, comment: BILIBILI_COMMENT_COLUMNS }
    case 'weibo':
      return { item: WEIBO_POST_COLUMNS, comment: WEIBO_COMMENT_COLUMNS }
    case 'xiaohongshu':
      return { item: XHS_NOTE_COLUMNS, comment: XHS_COMMENT_COLUMNS }
    case 'douyin':
      return { item: DOUYIN_VIDEO_COLUMNS, comment: DOUYIN_COMMENT_COLUMNS }
    case 'twitter':
      return { item: TWITTER_POST_COLUMNS, comment: TWITTER_COMMENT_COLUMNS }
    default:
      return { item: ITEM_COLUMNS, comment: COMMENT_COLUMNS }
  }
}

export const CRAWLER_MODES: CrawlerMode[] = ['posts', 'author', 'hot', 'comments']

/** 采析绘 id 与 CatBus id/别名的唯一映射表。 */
export const PLATFORM_ALIASES: Record<string, string> = {
  bilibili: 'bilibili',
  bili: 'bilibili',
  b: 'bilibili',
  weibo: 'weibo',
  wb: 'weibo',
  xiaohongshu: 'xiaohongshu',
  xhs: 'xiaohongshu',
  rednote: 'xiaohongshu',
  douyin: 'douyin',
  dy: 'douyin',
  twitter: 'twitter',
  x: 'twitter',
  kuaishou: 'kuaishou',
  ks: 'kuaishou',
  tiktok: 'tiktok',
  tt: 'tiktok',
  jd: 'jd',
  taobao: 'taobao',
  xianyu: 'xianyu',
}

/** 任意拼写 → 清单里的采析绘平台 id（未知原样返回）。 */
export function canonicalPlatform(platform: string): string {
  const key = platform.trim().toLowerCase()
  return PLATFORM_ALIASES[key] ?? key
}

export function platformCapability(platform: string): PlatformCapability | null {
  return manifest().platforms[canonicalPlatform(platform)] ?? null
}
