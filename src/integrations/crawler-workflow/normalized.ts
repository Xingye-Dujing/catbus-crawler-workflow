import { CatbusError } from '../../core/errors.js'
import {
  asRecord,
  asString,
  aggregateStatus,
  callError,
  classifyThrown,
  commentStatusOf,
  countOrBlank,
  idOrEmpty,
  isRecord,
  localStamp,
  parseCommentLimit,
  parseTarget,
  parseUrls,
  rowsOf,
  textOrEmpty,
  topicsOf,
} from './common.js'
import {
  DOUYIN_COMMENT_COLUMNS,
  DOUYIN_VIDEO_COLUMNS,
  ITEM_COLUMNS,
  COMMENT_COLUMNS,
  TWITTER_COMMENT_COLUMNS,
  TWITTER_POST_COLUMNS,
  WEIBO_COMMENT_COLUMNS,
  WEIBO_POST_COLUMNS,
  XHS_COMMENT_COLUMNS,
  XHS_NOTE_COLUMNS,
} from './columns.js'
import type { ArticleResult, CatbusRunner, CrawlerMode, Row, RowSink, RunParams, RunResult } from './types.js'

/**
 * 微博 / 小红书 / 抖音 / X 的共享模式：CatBus 已经把它们归一化成 Item / Comment，
 * 适配器只需要把归一化字段摆进采析绘同平台的列，不再各自解析一遍原始 JSON。
 *
 * 与 B 站不同，这里**不用 `--raw`**：采析绘这些平台的表要的字段（正文、作者、计数、时间）
 * 都在归一化契约里；raw 是某个上游版本的形状，拿它当表结构就是把版本差异带进账本。
 * 归一化层没给的列（微博发布来源、抖音单条粉丝数、X 的引用/卡片/投票）留空，
 * 绝不写 0 或「否」冒充「接口说没有」。
 */

function stat(raw: unknown, key: string): unknown {
  return asRecord(asRecord(raw).stats)[key]
}

function authorOf(raw: unknown): Record<string, unknown> {
  return asRecord(asRecord(raw).author)
}

function imagesOf(raw: unknown): string[] {
  const media = asRecord(raw).media
  if (!Array.isArray(media)) return []
  return media
    .filter((m) => isRecord(m) && m.type === 'image' && typeof m.url === 'string' && m.url)
    .map((m) => String(asRecord(m).url))
}

function videoCountOf(raw: unknown): number {
  const media = asRecord(raw).media
  if (!Array.isArray(media)) return 0
  return media.filter((m) => isRecord(m) && m.type === 'video').length
}

function handleOf(url: unknown, fallback: unknown): string {
  const text = asString(url)
  const last = text.split('?')[0]?.replace(/\/+$/, '').split('/').pop() ?? ''
  return last || asString(fallback)
}

export function mapWeiboItem(raw: unknown): Row {
  const text = asString(asRecord(raw).text)
  const author = authorOf(raw)
  const images = imagesOf(raw)
  return {
    发布者: asString(author.name),
    发布时间: localStamp(asRecord(raw).created_at),
    发布来源: '',
    正文: text,
    转发数: countOrBlank(stat(raw, 'shares')),
    评论数: countOrBlank(stat(raw, 'comments')),
    点赞数: countOrBlank(stat(raw, 'likes')),
    图片链接: images.join(' | '),
    图片数: images.length,
    话题: topicsOf(text).join(' | '),
    视频数: videoCountOf(raw),
    用户链接: asString(author.url),
    链接: asString(asRecord(raw).url),
    微博ID: asString(asRecord(raw).id),
  }
}

export function mapWeiboComment(raw: unknown, url: string, floor: number): Row {
  const author = authorOf(raw)
  return {
    平台: 'weibo',
    文章URL: url,
    评论者: textOrEmpty(author.name),
    评论者主页: asString(author.url),
    评论内容: textOrEmpty(asRecord(raw).text),
    评论时间: localStamp(asRecord(raw).created_at),
    点赞数: countOrBlank(stat(raw, 'likes')),
    楼层: floor,
    父楼层: '',
    评论ID: idOrEmpty(asRecord(raw).id),
  }
}

export function mapXhsItem(raw: unknown): Row {
  const author = authorOf(raw)
  return {
    笔记链接: asString(asRecord(raw).url),
    笔记ID: asString(asRecord(raw).id),
    标题: asString(asRecord(raw).title),
    作者: asString(author.name),
    点赞数: countOrBlank(stat(raw, 'likes')),
    正文: asString(asRecord(raw).text),
    发布时间: localStamp(asRecord(raw).created_at),
    收藏数: countOrBlank(stat(raw, 'collects')),
    评论数: countOrBlank(stat(raw, 'comments')),
    评论列表: '',
  }
}

export function mapXhsComment(raw: unknown, url: string, floor: number, parent = ''): Row {
  const author = authorOf(raw)
  return {
    平台: 'xiaohongshu',
    文章URL: url,
    评论者: textOrEmpty(author.name),
    评论者主页: asString(author.url),
    评论内容: textOrEmpty(asRecord(raw).text),
    评论时间: localStamp(asRecord(raw).created_at),
    点赞数: countOrBlank(stat(raw, 'likes')),
    楼层: floor,
    评论ID: idOrEmpty(asRecord(raw).id),
    父评论ID: parent || idOrEmpty(asRecord(raw).parent_id),
    子回复数: countOrBlank(stat(raw, 'replies')),
  }
}

export function mapDouyinItem(raw: unknown): Row {
  const text = asString(asRecord(raw).text)
  const author = authorOf(raw)
  return {
    标题: (text || asString(asRecord(raw).title)).slice(0, 120),
    正文: text,
    作者: asString(author.name),
    粉丝数: '',
    获赞数: '',
    发布时间: localStamp(asRecord(raw).created_at),
    视频ID: asString(asRecord(raw).id),
    点赞数: countOrBlank(stat(raw, 'likes')),
    评论数: countOrBlank(stat(raw, 'comments')),
    收藏数: countOrBlank(stat(raw, 'collects')),
    转发数: countOrBlank(stat(raw, 'shares')),
    链接: asString(asRecord(raw).url) || (asString(asRecord(raw).id) ? `https://www.douyin.com/video/${asString(asRecord(raw).id)}` : ''),
  }
}

export function mapDouyinComment(raw: unknown, url: string, floor: number, parent = ''): Row {
  const author = authorOf(raw)
  return {
    平台: 'douyin',
    文章URL: url,
    评论者: textOrEmpty(author.name),
    评论者主页: asString(author.url),
    评论内容: textOrEmpty(asRecord(raw).text),
    评论时间: localStamp(asRecord(raw).created_at),
    评论地区: '',
    点赞数: countOrBlank(stat(raw, 'likes')),
    子回复数: countOrBlank(stat(raw, 'replies')),
    楼层: floor,
    父楼层: parent,
    评论ID: idOrEmpty(asRecord(raw).id),
    父评论ID: parent || idOrEmpty(asRecord(raw).parent_id),
  }
}

export function mapTwitterItem(raw: unknown): Row {
  const text = asString(asRecord(raw).text)
  const author = authorOf(raw)
  const images = imagesOf(raw)
  return {
    发布者: asString(author.name),
    发布者ID: handleOf(author.url, author.id),
    用户链接: asString(author.url),
    发布时间: localStamp(asRecord(raw).created_at),
    正文: text,
    话题: topicsOf(text).join(' | '),
    评论数: countOrBlank(stat(raw, 'comments')),
    转发数: countOrBlank(stat(raw, 'shares')),
    点赞数: countOrBlank(stat(raw, 'likes')),
    收藏数: countOrBlank(stat(raw, 'collects')),
    浏览数: countOrBlank(stat(raw, 'views')),
    图片链接: images.join(' | '),
    图片数: images.length,
    视频数: videoCountOf(raw),
    是否引用: '',
    含外链卡片: '',
    含投票: '',
    链接: asString(asRecord(raw).url),
    推文ID: asString(asRecord(raw).id),
  }
}

export function mapTwitterComment(raw: unknown, url: string, floor: number): Row {
  const author = authorOf(raw)
  return {
    平台: 'twitter',
    文章URL: url,
    评论者: handleOf(author.url, author.id),
    评论者昵称: textOrEmpty(author.name),
    评论者主页: asString(author.url),
    评论内容: textOrEmpty(asRecord(raw).text),
    评论时间: localStamp(asRecord(raw).created_at),
    点赞数: countOrBlank(stat(raw, 'likes')),
    回复数: countOrBlank(stat(raw, 'replies')),
    转发数: '',
    浏览数: '',
    图片链接: '',
    图片数: '',
    是否引用: '',
    楼层: floor,
    评论ID: idOrEmpty(asRecord(raw).id),
    推文ID: idOrEmpty(asRecord(raw).id),
  }
}

function mapGenericItem(raw: unknown, platform: string): Row {
  const author = authorOf(raw)
  const images = imagesOf(raw)
  const text = asString(asRecord(raw).text)
  return {
    平台: platform,
    作品ID: asString(asRecord(raw).id),
    类型: asString(asRecord(raw).kind),
    标题: asString(asRecord(raw).title),
    正文: text,
    作者: asString(author.name),
    作者ID: asString(author.id),
    作者主页: asString(author.url),
    发布时间: localStamp(asRecord(raw).created_at),
    链接: asString(asRecord(raw).url),
    播放数: countOrBlank(stat(raw, 'views')),
    点赞数: countOrBlank(stat(raw, 'likes')),
    评论数: countOrBlank(stat(raw, 'comments')),
    收藏数: countOrBlank(stat(raw, 'collects')),
    转发数: countOrBlank(stat(raw, 'shares')),
    图片数: images.length,
    视频数: videoCountOf(raw),
  }
}

function mapGenericComment(raw: unknown, platform: string): Row {
  const author = authorOf(raw)
  return {
    平台: platform,
    文章URL: '',
    评论者: textOrEmpty(author.name),
    评论者主页: asString(author.url),
    评论内容: textOrEmpty(asRecord(raw).text),
    评论时间: localStamp(asRecord(raw).created_at),
    点赞数: countOrBlank(stat(raw, 'likes')),
    回复数: countOrBlank(stat(raw, 'replies')),
    楼层: '',
    评论ID: idOrEmpty(asRecord(raw).id),
    父评论ID: idOrEmpty(asRecord(raw).parent_id),
  }
}

export interface PlatformSpec {
  platform: string
  catbus: string
  columns: { item: string[]; comment: string[] }
  mapItem: (raw: unknown) => Row
  mapComment: (raw: unknown, url: string, floor: number, parent?: string) => Row
  commands: {
    posts: string
    author: string
    comments: string
    replies?: string
  }
  /** 列表里按这个字段去重（搜索与作者列表可能重复同一项）。 */
  itemKey: (raw: unknown) => string
  /** 评论列表里的根评论是否值得再问一次回复（上游有 `comment replies` 才有）。 */
  expandReplies: boolean
}

function keyById(raw: unknown): string {
  return asString(asRecord(raw).id)
}

const GENERIC_ITEM_COLUMNS = ITEM_COLUMNS
const GENERIC_COMMENT_COLUMNS = COMMENT_COLUMNS

export const PLATFORM_SPECS: Record<string, PlatformSpec> = {
  weibo: {
    platform: 'weibo',
    catbus: 'weibo',
    columns: { item: WEIBO_POST_COLUMNS, comment: WEIBO_COMMENT_COLUMNS },
    mapItem: mapWeiboItem,
    mapComment: mapWeiboComment,
    commands: { posts: 'item search', author: 'user items', comments: 'comment list' },
    itemKey: keyById,
    // 微博的 comment replies 上游没有注册；只取一级评论，清单里标 partial 并写明。
    expandReplies: false,
  },
  xiaohongshu: {
    platform: 'xiaohongshu',
    catbus: 'xhs',
    columns: { item: XHS_NOTE_COLUMNS, comment: XHS_COMMENT_COLUMNS },
    mapItem: mapXhsItem,
    mapComment: mapXhsComment,
    commands: { posts: 'item search', author: 'user items', comments: 'comment list', replies: 'comment replies' },
    itemKey: keyById,
    expandReplies: true,
  },
  douyin: {
    platform: 'douyin',
    catbus: 'douyin',
    columns: { item: DOUYIN_VIDEO_COLUMNS, comment: DOUYIN_COMMENT_COLUMNS },
    mapItem: mapDouyinItem,
    mapComment: mapDouyinComment,
    commands: { posts: 'item search', author: 'user items', comments: 'comment list', replies: 'comment replies' },
    itemKey: keyById,
    expandReplies: true,
  },
  twitter: {
    platform: 'twitter',
    catbus: 'x',
    columns: { item: TWITTER_POST_COLUMNS, comment: TWITTER_COMMENT_COLUMNS },
    mapItem: mapTwitterItem,
    mapComment: mapTwitterComment,
    commands: { posts: 'item search', author: 'user items', comments: 'comment list' },
    itemKey: keyById,
    expandReplies: false,
  },
  kuaishou: {
    platform: 'kuaishou',
    catbus: 'kuaishou',
    columns: { item: GENERIC_ITEM_COLUMNS, comment: GENERIC_COMMENT_COLUMNS },
    mapItem: (raw) => mapGenericItem(raw, 'kuaishou'),
    mapComment: (raw, _url, floor, parent) => ({
      ...mapGenericComment(raw, 'kuaishou'),
      楼层: floor,
      父评论ID: parent || idOrEmpty(asRecord(raw).parent_id),
    }),
    commands: { posts: 'item search', author: 'user items', comments: 'comment list', replies: 'comment replies' },
    itemKey: keyById,
    expandReplies: true,
  },
  tiktok: {
    platform: 'tiktok',
    catbus: 'tiktok',
    columns: { item: GENERIC_ITEM_COLUMNS, comment: GENERIC_COMMENT_COLUMNS },
    mapItem: (raw) => mapGenericItem(raw, 'tiktok'),
    mapComment: (raw, _url, floor, parent) => ({
      ...mapGenericComment(raw, 'tiktok'),
      楼层: floor,
      父评论ID: parent || idOrEmpty(asRecord(raw).parent_id),
    }),
    commands: { posts: 'item search', author: 'user items', comments: 'comment list', replies: 'comment replies' },
    itemKey: keyById,
    expandReplies: true,
  },
}

export class NormalizedAdapter {
  private readonly account?: string

  constructor(
    private readonly client: CatbusRunner,
    private readonly spec: PlatformSpec,
    account?: string,
    private readonly onRow?: RowSink,
  ) {
    this.account = account?.trim() || undefined
  }

  private suffix(limit: number | 'all' | null = null): string[] {
    const out: string[] = []
    if (limit === 'all') out.push('--all')
    else if (typeof limit === 'number' && limit > 0) out.push('--limit', String(limit))
    out.push('-o', 'json', '-q')
    if (this.account) out.push('-a', this.account)
    return out
  }

  private async call(command: string, args: string[], limit: number | 'all' | null = null): Promise<unknown> {
    const call = await this.client.call([this.spec.catbus, ...command.split(' '), ...args, ...this.suffix(limit)])
    if (call.code !== 0 || !call.envelope?.ok) throw callError(call)
    return call.envelope.data
  }

  private async emit(rows: Row[], row: Row): Promise<void> {
    rows.push(row)
    await this.onRow?.(row)
  }

  async run(mode: CrawlerMode, params: RunParams): Promise<RunResult> {
    switch (mode) {
      case 'posts':
        return this.list('posts', params)
      case 'author':
        return this.list('author', params)
      case 'comments':
        return this.comments(params)
      default:
        throw new CatbusError('UNSUPPORTED', `${this.spec.platform} 没有 ${mode} 模式`)
    }
  }

  private async list(mode: 'posts' | 'author', params: RunParams): Promise<RunResult> {
    const target = parseTarget(params.target_count)
    let value: unknown
    if (mode === 'posts') {
      const keyword = asString(params.keyword)
      if (!keyword) throw new CatbusError('USAGE', 'posts 模式需要 keyword')
      value = await this.call(this.spec.commands.posts, [keyword], target)
    } else {
      const author = asString(params.author)
      if (!author) throw new CatbusError('USAGE', 'author 模式需要 author')
      value = await this.call(this.spec.commands.author, [author], target)
    }
    const rows: Row[] = []
    const seen = new Set<string>()
    for (const raw of rowsOf(value)) {
      if (rows.length >= target) break
      const key = this.spec.itemKey(raw)
      if (key && seen.has(key)) continue
      if (key) seen.add(key)
      await this.emit(rows, this.spec.mapItem(raw))
    }
    return { rows, status: 'ok', warnings: [], articles: [] }
  }

  private async comments(params: RunParams): Promise<RunResult> {
    const urls = parseUrls(params.urls)
    if (urls.length === 0) {
      throw new CatbusError('USAGE', 'comments 模式需要 urls', { hint: '在 params 里传 urls，一行一个链接' })
    }
    const limit = parseCommentLimit(params.comment_limit)
    const rows: Row[] = []
    const articles: ArticleResult[] = []
    const warnings: string[] = []

    for (let index = 0; index < urls.length; index += 1) {
      const url = urls[index]!
      try {
        const value = await this.call(this.spec.commands.comments, [url], limit > 0 ? limit : 'all')
        const roots = rowsOf(value)
        let floor = 0
        let articleRows = 0
        for (const root of roots) {
          if (limit > 0 && rows.length >= limit) break
          floor += 1
          await this.emit(rows, this.spec.mapComment(root, url, floor))
          articleRows += 1
          const replies = asRecord(root).replies
          const replyCount = Array.isArray(replies) ? replies.length : Number(asRecord(asRecord(root).stats).replies ?? 0)
          if (!this.spec.expandReplies || !this.spec.commands.replies || replyCount <= 0) continue
          // 上游的 comment list 只给根评论；子回复单独问一次。与 Selenium 版一样把回复接在父楼层之后，
          // 但绝不为了一条回复再开一篇文章的递归——回复的回复不在本模式的承诺里。
          try {
            const remaining = limit > 0 ? limit - rows.length : 0
            const parentId = idOrEmpty(asRecord(root).id)
            if (!parentId) continue
            const childValue = await this.call(this.spec.commands.replies, [url, parentId], remaining > 0 ? remaining : 'all')
            for (const child of rowsOf(childValue)) {
              if (limit > 0 && rows.length >= limit) break
              floor += 1
              await this.emit(rows, this.spec.mapComment(child, url, floor, parentId))
              articleRows += 1
            }
          } catch (err) {
            const e = classifyThrown(err)
            warnings.push(`${url} 评论 ${asString(asRecord(root).id)} 的回复: ${e.code} ${e.message}`)
          }
        }
        articles.push({ url, status: 'ok', rows: articleRows, error: null })
      } catch (err) {
        const e = classifyThrown(err)
        const status = commentStatusOf(e)
        articles.push({ url, status, rows: 0, error: e.toJSON() })
        warnings.push(`${url}: ${e.code} ${e.message}`)
        if (status === 'blocked') {
          for (const rest of urls.slice(index + 1)) {
            articles.push({ url: rest, status: 'blocked', rows: 0, error: e.toJSON() })
          }
          break
        }
      }
    }

    return { rows, status: aggregateStatus(articles), warnings, articles }
  }
}
