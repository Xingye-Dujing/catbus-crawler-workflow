import { CatbusError } from '../../core/errors.js'
import {
  aggregateStatus,
  asList,
  asRecord,
  asString,
  callError,
  classifyThrown,
  commentStatusOf,
  countOrBlank,
  formatCst,
  idOrEmpty,
  intOrZero,
  isRecord,
  parseCommentLimit,
  parseTarget,
  parseUrls,
  textOrEmpty,
} from './common.js'
import type {
  ArticleResult,
  CatbusRunner,
  CrawlerMode,
  Row,
  RowSink,
  RunParams,
  RunResult,
} from './types.js'

export { formatCst }

/** 采析绘 B 站视频表的列顺序；不能随手改，分析节点按这些键取值。 */
export const BILIBILI_VIDEO_COLUMNS = [
  '标题',
  'UP主',
  'UP主ID',
  '正文',
  '发布时间',
  'BV号',
  '稿件ID',
  '合集',
  '分P数',
  '时长秒',
  '播放数',
  '点赞数',
  '投币数',
  '收藏数',
  '转发数',
  '弹幕数',
  '评论数',
  '链接',
]

/** 采析绘 B 站评论表的列顺序。 */
export const BILIBILI_COMMENT_COLUMNS = [
  '平台',
  '文章URL',
  '评论者',
  '评论者主页',
  '用户等级',
  '评论内容',
  '评论时间',
  '点赞数',
  '楼层',
  '评论ID',
  '父评论ID',
  '子回复数',
  '回复数',
  'UP主态',
]

/** 视频详情（x/web-interface/view 的 data）→ 采析绘的 18 列。 */
export function mapBilibiliVideo(raw: unknown): Row {
  const v = asRecord(raw)
  const owner = asRecord(v.owner)
  const stat = asRecord(v.stat)
  const season = asRecord(v.ugc_season)
  const bvid = asString(v.bvid)
  return {
    标题: asString(v.title),
    UP主: asString(owner.name),
    UP主ID: idOrEmpty(owner.mid),
    正文: asString(v.desc),
    发布时间: formatCst(v.pubdate),
    BV号: bvid,
    稿件ID: idOrEmpty(v.aid),
    合集: asString(season.title),
    分P数: countOrBlank(v.videos),
    时长秒: countOrBlank(v.duration),
    播放数: countOrBlank(stat.view),
    点赞数: countOrBlank(stat.like),
    投币数: countOrBlank(stat.coin),
    收藏数: countOrBlank(stat.favorite),
    转发数: countOrBlank(stat.share),
    弹幕数: countOrBlank(stat.danmaku),
    评论数: countOrBlank(stat.reply),
    链接: bvid ? `https://www.bilibili.com/video/${bvid}/` : '',
  }
}

function upLiked(raw: Record<string, unknown>): string {
  const labels = Array.isArray(raw.card_label) ? raw.card_label : []
  for (const label of labels) {
    if (isRecord(label) && asString(label.text_content).includes('UP主')) return '点赞'
  }
  const action = asRecord(raw.up_action)
  return action.like ? '点赞' : ''
}

/** 一条原始评论 → 采析绘评论表的 14 列。 */
export function mapBilibiliComment(
  raw: unknown,
  articleUrl: string,
  floor: number,
  parentId = '',
): Row {
  const item = asRecord(raw)
  const member = asRecord(item.member)
  const levelInfo = asRecord(member.level_info)
  const content = asRecord(item.content)
  const rpid = idOrEmpty(item.rpid)
  const parent = parentId || idOrEmpty(item.root)
  const mid = idOrEmpty(member.mid)
  return {
    平台: 'bilibili',
    文章URL: articleUrl,
    评论者: textOrEmpty(member.uname),
    评论者主页: mid ? `https://space.bilibili.com/${mid}` : '',
    用户等级: intOrZero(levelInfo.current_level),
    评论内容: textOrEmpty(content.message),
    评论时间: formatCst(item.ctime),
    点赞数: intOrZero(item.like),
    楼层: floor,
    评论ID: rpid,
    父评论ID: parent,
    子回复数: intOrZero(item.rcount),
    回复数: intOrZero(item.count),
    UP主态: upLiked(item),
  }
}

/**
 * 一页/一篇文章的根评论 → 采析绘行。
 *
 * 采析绘现在只展开接口随附的 `replies` 预览，`子回复数` 保留未展开的剩余部分；
 * 这里照做，避免 CatBus 适配版比 Selenium 版多出（或少了）行。
 */
export function mapBilibiliCommentThread(raws: unknown, articleUrl: string, limit = 0): Row[] {
  const roots = Array.isArray(raws) ? raws : []
  const rows: Row[] = []
  let floor = 0

  const push = (raw: unknown, parentId = ''): boolean => {
    if (limit > 0 && rows.length >= limit) return false
    if (!isRecord(raw)) return true
    floor += 1
    rows.push(mapBilibiliComment(raw, articleUrl, floor, parentId))
    return true
  }

  for (const root of roots) {
    const rootRecord = asRecord(root)
    const rootId = idOrEmpty(rootRecord.rpid)
    if (!push(root, '')) break
    const replies = Array.isArray(rootRecord.replies) ? rootRecord.replies : []
    let stopped = false
    for (const reply of replies) {
      if (!push(reply, rootId)) {
        stopped = true
        break
      }
    }
    if (stopped) break
  }
  return rows
}

/**
 * B 站适配器。所有命令都走 `--raw`：采析绘需要的投币数、弹幕数、合集、分P、
 * 用户等级、UP主态都不在 CatBus 的归一化字段里。
 */
export class BilibiliAdapter {
  private readonly account?: string

  constructor(
    private readonly client: CatbusRunner,
    account?: string,
    private readonly onRow?: RowSink,
  ) {
    this.account = account?.trim() || undefined
  }

  /**
   * 行既进本次结果数组（摘要要数它），也马上交给调用方，不等到整批跑完。
   * 一条详情失败不撤回前面已经交出去的行——采析绘把它们一行一个事务存下了。
   */
  private async emit(rows: Row[], row: Row): Promise<void> {
    rows.push(row)
    await this.onRow?.(row)
  }

  private async call(args: string[]): Promise<unknown> {
    const suffix = ['-o', 'json', '--raw', '-q']
    if (this.account) suffix.push('-a', this.account)
    const call = await this.client.call(['bilibili', ...args, ...suffix])
    if (call.code !== 0 || !call.envelope?.ok) throw callError(call)
    return call.envelope.data
  }

  private async detail(bvid: string): Promise<unknown> {
    return this.call(['item', 'get', bvid])
  }

  async run(mode: CrawlerMode, params: RunParams): Promise<RunResult> {
    switch (mode) {
      case 'comments':
        return this.comments(params)
      case 'posts':
        return this.posts(params)
      case 'author':
        return this.author(params)
      case 'hot':
        return this.hot(params)
      default:
        throw new CatbusError('UNSUPPORTED', `bilibili 没有 ${String(mode)} 模式`)
    }
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
        const data = await this.call(['comment', 'list', url, ...(limit > 0 ? ['--limit', String(limit)] : ['--all'])])
        const mapped = mapBilibiliCommentThread(asList(data, 'comment list'), url, limit)
        for (const row of mapped) await this.emit(rows, row)
        articles.push({ url, status: 'ok', rows: mapped.length, error: null })
      } catch (err) {
        const e = classifyThrown(err)
        const status = commentStatusOf(e)
        articles.push({ url, status, rows: 0, error: e.toJSON() })
        warnings.push(`${url}: ${e.code} ${e.message}`)
        // 登录墙/风控继续请求只会加重限制；后面的链接标成同一个 blocked，留给下一次运行。
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

  private async posts(params: RunParams): Promise<RunResult> {
    const keyword = asString(params.keyword)
    if (!keyword) throw new CatbusError('USAGE', 'posts 模式需要 keyword')
    const target = parseTarget(params.target_count, 'target_count')
    const cards = await this.call(['item', 'search', keyword, '--limit', String(target)])
    return this.fromCards(cards, target)
  }

  private async author(params: RunParams): Promise<RunResult> {
    const author = asString(params.author)
    if (!author) throw new CatbusError('USAGE', 'author 模式需要 author')
    const target = parseTarget(params.target_count, 'target_count')
    const list = await this.call(['user', 'items', author, '--limit', String(target)])
    return this.fromCards(list, target)
  }

  private async hot(params: RunParams): Promise<RunResult> {
    const board = (asString(params.board) || 'popular').toLowerCase()
    if (board !== 'popular') {
      throw new CatbusError('UNSUPPORTED', `bilibili hot 暂不支持 ${board} 榜`, {
        hint: 'CatBus 目前只注册了热门（popular）；排行榜 ranking 没有对应命令，请改用 popular 或 Selenium',
      })
    }
    const target = parseTarget(params.target_count, 'target_count')
    const data = await this.call(['feed', 'list', '--kind', 'hot', '--limit', String(target)])
    const list = asList(data, 'feed list')
    const rows: Row[] = []
    const seen = new Set<string>()
    for (const raw of list) {
      const bvid = asString(asRecord(raw).bvid)
      if (!bvid || seen.has(bvid)) continue
      seen.add(bvid)
      await this.emit(rows, mapBilibiliVideo(raw))
      if (rows.length >= target) break
    }
    return { rows, status: 'ok', warnings: [], articles: [] }
  }

  /** 搜索 / 投稿列表只拿到卡片，逐条走 item get 才是采析绘需要的完整 stat。 */
  private async fromCards(value: unknown, target: number): Promise<RunResult> {
    const cards = asList(value, '视频列表')
    const rows: Row[] = []
    const warnings: string[] = []
    const seen = new Set<string>()
    let blocked: CatbusError | null = null
    let fatal: CatbusError | null = null

    for (const card of cards) {
      if (rows.length >= target) break
      const bvid = asString(asRecord(card).bvid)
      if (!bvid || seen.has(bvid)) continue
      seen.add(bvid)
      try {
        await this.emit(rows, mapBilibiliVideo(await this.detail(bvid)))
      } catch (err) {
        const e = classifyThrown(err)
        if (e.code === 'AUTH_REQUIRED' || e.code === 'AUTH_EXPIRED' || e.code === 'RISK_CONTROL') {
          blocked = e
          break
        }
        warnings.push(`${bvid}: ${e.code} ${e.message}`)
        const status = commentStatusOf(e)
        if (status === 'error') fatal = e
        if (status === 'dead') continue
        // 单条详情失败不终止整批，采析绘的结果里会缺这一行并有 warning 可查。
      }
    }

    if (blocked) throw blocked
    if (!rows.length && fatal) throw fatal
    return {
      rows,
      status: rows.length ? (warnings.length ? 'partial' : 'ok') : warnings.length ? 'dead' : 'ok',
      warnings,
      articles: [],
    }
  }
}
