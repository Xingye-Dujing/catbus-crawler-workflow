import { BILIBILI_COMMENT_COLUMNS, BILIBILI_VIDEO_COLUMNS } from './bilibili.js'
import type {
  BackendManifest,
  CrawlerMode,
  CrawlerPlatform,
  ModeCapability,
  PlatformCapability,
} from './types.js'

const notYet = (reason: string, catbus: string[] = []): ModeCapability => ({
  status: 'planned',
  catbus,
  params: [],
  columns: [],
  auth: 'required',
  reason,
})

const notAvailable = (reason: string): ModeCapability => ({
  status: 'unavailable',
  catbus: [],
  params: [],
  columns: [],
  auth: 'required',
  reason,
})

const bilibili: PlatformCapability = {
  catbus_platform: 'bilibili',
  label: 'B站',
  modes: {
    posts: {
      status: 'available',
      handler: 'posts',
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
      catbus: ['bilibili', 'comment', 'list', '<url>', '--raw'],
      params: ['urls', 'comment_limit', 'catbus_account'],
      columns: BILIBILI_COMMENT_COLUMNS,
      identity: ['平台', '评论ID'],
      auth: 'required',
      note: '根评论 + 接口随附的预览楼中楼，和现有 Selenium 版一致；完整楼中楼仍不在本模式展开。',
    },
  },
}

const weibo: PlatformCapability = {
  catbus_platform: 'weibo',
  label: '微博',
  modes: {
    posts: notYet('CatBus 的微博搜索只返回第一页，无法承诺 target_count；列映射也尚未适配。', [
      'weibo',
      'item',
      'search',
    ]),
    author: notYet('CatBus 有 user items，但微博 author 的列映射尚未实现。', ['weibo', 'user', 'items']),
    hot: notAvailable('CatBus 没有注册微博热搜/热榜命令；feed list 也不覆盖微博。'),
    comments: notYet('CatBus 的微博 comment list 只读一级评论，预览子回复和采析绘列尚未映射。', [
      'weibo',
      'comment',
      'list',
    ]),
  },
}

const xiaohongshu: PlatformCapability = {
  catbus_platform: 'xhs',
  label: '小红书',
  modes: {
    posts: notYet('CatBus 的 xhs item search 可用，但小红书发布列和去重身份尚未映射。', [
      'xhs',
      'item',
      'search',
    ]),
    author: notAvailable('采析绘的小红书模式没有 author。'),
    hot: notAvailable('采析绘的小红书模式没有 hot。'),
    comments: notYet('CatBus 的 xhs comment list 可用，但评论列映射尚未实现。', ['xhs', 'comment', 'list']),
  },
}

const douyin: PlatformCapability = {
  catbus_platform: 'douyin',
  label: '抖音',
  modes: {
    posts: notAvailable('采析绘的抖音模式没有 posts。'),
    author: notYet('CatBus 有 douyin user items，但作者列映射尚未实现。', ['douyin', 'user', 'items']),
    hot: notYet('CatBus 有 douyin feed list，但热榜列映射尚未实现。', ['douyin', 'feed', 'list']),
    comments: notYet('CatBus 有 douyin comment list，但抖音评论列映射尚未实现。', [
      'douyin',
      'comment',
      'list',
    ]),
  },
}

const twitter: PlatformCapability = {
  catbus_platform: 'x',
  label: 'X',
  modes: {
    posts: notYet('CatBus 的 x item search 可用，但推文列映射尚未实现。', ['x', 'item', 'search']),
    author: notYet('CatBus 的 x user items 可用，但作者列映射尚未实现。', ['x', 'user', 'items']),
    hot: notAvailable('采析绘的 X 模式没有 hot。'),
    comments: notYet('CatBus 的 x comment list 可用，但评论列映射尚未实现。', ['x', 'comment', 'list']),
  },
}

/** 采析绘的平台 id 是 xiaohongshu / twitter，CatBus 是 xhs / x；清单以采析绘侧为准。 */
export function manifest(): BackendManifest {
  const platforms: Record<CrawlerPlatform, PlatformCapability> = {
    bilibili,
    weibo,
    xiaohongshu,
    douyin,
    twitter,
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
      auth: 'CatBus 账号独立于 Selenium cookie；先运行 catbus bilibili auth login',
    },
    deployment: {
      server: true,
      desktop: false,
    },
  }
}

export const CRAWLER_MODES: CrawlerMode[] = ['posts', 'author', 'hot', 'comments']

export function platformCapability(platform: string): PlatformCapability | null {
  const key = platform.trim().toLowerCase()
  const map: Record<string, CrawlerPlatform> = {
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
  }
  const id = map[key]
  return id ? manifest().platforms[id] : null
}
