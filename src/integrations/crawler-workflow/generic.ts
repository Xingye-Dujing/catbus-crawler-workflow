import { CatbusError } from '../../core/errors.js'
import {
  asRecord,
  asString,
  callError,
  classifyThrown,
  countOrBlank,
  idOrEmpty,
  localStamp,
  paramOf,
  parseTarget,
  rowsOf,
  textOrEmpty,
} from './common.js'
import type { CatbusRunner, CrawlerMode, Row, RowSink, RunParams, RunResult } from './types.js'

/**
 * CatBus 独有的只读模式：命令与输出类型由清单声明，适配器按输出类型统一映射。
 *
 * 这是「把 CatBus 的读能力全搬进来」而不写 51 份解析器的方式：`user followers`、`keyword hot`、
 * `live list` 这些命令的输出已经是 CatBus 的归一化类型，映射规则只按类型写一次。
 * 写命令永远进不来——清单只收 `write()` 之外的命令，且这里再拒一次 `mutating`
 * （清单与执行器各查一次，不靠上一个环节记性）。
 */

export interface GenericMode {
  mode: string
  command: string
  args: string[]
  /** 可省略的位置参数，以及省略时的取值（来自命令声明的 ArgSpec.default）。 */
  optional: Record<string, string>
  output: string
  paged: boolean
}

/** 命令位置参数 → 采析绘字段名。`user` 复用 `author`，`prefix` 复用 `keyword`。 */
export const ARG_PARAMS: Record<string, string> = {
  user: 'author',
  item: 'urls',
  comment: 'comment_id',
  keyword: 'keyword',
  room: 'room',
  folder: 'folder',
  series: 'series',
  conversation: 'conversation',
  product: 'product',
  prefix: 'keyword',
}

function paramFor(arg: string, params: RunParams): string {
  if (arg === 'user') return asString(params.author) || asString(params.user)
  if (arg === 'comment') return paramOf(params, 'comment_id')
  if (arg === 'item') return splitUrls(params.urls)[0] ?? ''
  if (arg === 'prefix' || arg === 'keyword') return paramOf(params, 'keyword')
  return paramOf(params, arg)
}

function splitUrls(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value]
  const out: string[] = []
  for (const part of list) {
    for (const line of String(part ?? '').split(/\r?\n/)) {
      const url = line.trim()
      if (url && !out.includes(url)) out.push(url)
    }
  }
  return out
}

function mediaUrls(raw: unknown): string[] {
  const media = asRecord(raw).media
  if (!Array.isArray(media)) return []
  return media.filter((m) => asRecord(m).type === 'image' && asRecord(m).url).map((m) => asString(asRecord(m).url))
}

/** 归一化输出 → 通用列。与 `columns.ts` 的 OUTPUT_COLUMNS 一一对应。 */
export function mapGenericOutput(output: string, raw: unknown, platform: string, floor = 0): Row {
  const r = asRecord(raw)
  const stats = asRecord(r.stats)
  const author = asRecord(r.author)
  const host = asRecord(r.host)
  const peer = asRecord(r.peer)
  const from = asRecord(r.from)
  const user = asRecord(r.user)
  const target = asRecord(r.target)
  const price = asRecord(r.price)
  switch (output) {
    case 'Item':
      return {
        平台: platform,
        作品ID: asString(r.id),
        类型: asString(r.kind),
        标题: asString(r.title),
        正文: asString(r.text),
        作者: asString(author.name),
        作者ID: asString(author.id),
        作者主页: asString(author.url),
        发布时间: localStamp(r.created_at),
        链接: asString(r.url),
        播放数: countOrBlank(stats.views),
        点赞数: countOrBlank(stats.likes),
        评论数: countOrBlank(stats.comments),
        收藏数: countOrBlank(stats.collects),
        转发数: countOrBlank(stats.shares),
        图片数: mediaUrls(raw).length,
        视频数: Array.isArray(r.media) ? r.media.filter((m) => asRecord(m).type === 'video').length : 0,
      }
    case 'User':
      return {
        平台: platform,
        用户ID: asString(r.id),
        昵称: asString(r.name),
        账号: asString(r.handle),
        主页: asString(r.url),
        简介: asString(r.bio),
        粉丝数: countOrBlank(stats.followers),
        关注数: countOrBlank(stats.following),
        作品数: countOrBlank(stats.items),
        获赞数: countOrBlank(stats.likes),
      }
    case 'Comment':
      return {
        平台: platform,
        文章URL: '',
        评论者: textOrEmpty(author.name),
        评论者主页: asString(author.url),
        评论内容: textOrEmpty(r.text),
        评论时间: localStamp(r.created_at),
        点赞数: countOrBlank(stats.likes),
        回复数: countOrBlank(stats.replies),
        楼层: floor,
        评论ID: idOrEmpty(r.id),
        父评论ID: idOrEmpty(r.parent_id),
      }
    case 'Keyword':
      return {
        平台: platform,
        关键词: asString(r.text),
        热度: countOrBlank(r.heat),
        排名: floor,
      }
    case 'Topic':
      return {
        平台: platform,
        话题ID: asString(r.id),
        话题: asString(r.name),
        链接: asString(r.url),
        浏览数: countOrBlank(stats.views),
        作品数: countOrBlank(stats.items),
      }
    case 'Live':
      return {
        平台: platform,
        直播间ID: asString(r.id),
        标题: asString(r.title),
        主播: asString(host.name),
        主播主页: asString(host.url),
        状态: asString(r.status),
        观看人数: countOrBlank(stats.viewers),
        链接: asString(r.url),
        封面: asString(r.cover),
      }
    case 'Folder':
      return { 平台: platform, 收藏夹ID: asString(r.id), 名称: asString(r.name), 数量: countOrBlank(r.count), 链接: asString(r.url) }
    case 'Series':
      return { 平台: platform, 合集ID: asString(r.id), 名称: asString(r.name), 数量: countOrBlank(r.count), 链接: asString(r.url) }
    case 'Category':
      return { 平台: platform, 分类ID: asString(r.id), 名称: asString(r.name), 父分类ID: asString(r.parent_id) }
    case 'Notice':
      return {
        平台: platform,
        通知ID: asString(r.id),
        类型: asString(r.type),
        用户: asString(user.name),
        用户主页: asString(user.url),
        内容: asString(r.text),
        目标ID: asString(target.id),
        目标链接: asString(target.url),
        时间: localStamp(r.created_at),
      }
    case 'Poi':
      return { 平台: platform, 地点ID: asString(r.id), 名称: asString(r.name), 地址: asString(r.address) }
    case 'Conversation':
      return {
        平台: platform,
        会话ID: asString(r.id),
        对方: asString(peer.name),
        对方主页: asString(peer.url),
        未读数: countOrBlank(r.unread),
        最后消息: asString(r.last_message),
        更新时间: localStamp(r.updated_at),
      }
    case 'Message':
      return {
        平台: platform,
        消息ID: asString(r.id),
        会话ID: asString(r.conversation_id),
        发送者: asString(from.name),
        发送者主页: asString(from.url),
        类型: asString(r.type),
        内容: asString(r.text),
        时间: localStamp(r.created_at),
      }
    case 'Media':
      return {
        平台: platform,
        媒体ID: asString(r.id),
        类型: asString(r.type),
        地址: asString(r.url),
        宽: countOrBlank(r.width),
        高: countOrBlank(r.height),
        时长秒: countOrBlank(r.duration),
      }
    case 'Rank':
      return {
        平台: platform,
        排名: countOrBlank(r.rank) || floor,
        用户: asString(asRecord(r.user).name),
        用户主页: asString(asRecord(r.user).url),
        分数: countOrBlank(r.score),
      }
    case 'Gift':
      return {
        平台: platform,
        礼物ID: asString(r.id),
        名称: asString(r.name),
        价格: countOrBlank(price.amount),
        币种: asString(price.currency),
      }
    case 'Danmaku':
      return {
        平台: platform,
        弹幕ID: asString(r.id),
        作品ID: asString(r.item_id),
        偏移秒: countOrBlank(r.offset),
        内容: asString(r.text),
        时间: localStamp(r.created_at),
      }
    default:
      throw new CatbusError('UNSUPPORTED', `CatBus 适配器不认识输出类型 ${output}`)
  }
}

export class GenericAdapter {
  private readonly account?: string

  constructor(
    private readonly client: CatbusRunner,
    private readonly platform: string,
    private readonly catbus: string,
    private readonly spec: GenericMode,
    account?: string,
    private readonly onRow?: RowSink,
  ) {
    this.account = account?.trim() || undefined
  }

  private suffix(limit: number): string[] {
    const out: string[] = []
    if (this.spec.paged && limit > 0) out.push('--limit', String(limit))
    out.push('-o', 'json', '-q')
    if (this.account) out.push('-a', this.account)
    return out
  }

  private async call(args: string[], limit: number): Promise<unknown> {
    const call = await this.client.call([this.catbus, ...this.spec.command.split(' '), ...args, ...this.suffix(limit)])
    if (call.code !== 0 || !call.envelope?.ok) throw callError(call)
    return call.envelope.data
  }

  async run(_mode: CrawlerMode, params: RunParams): Promise<RunResult> {
    const target = parseTarget(params.target_count)
    const rows: Row[] = []
    const warnings: string[] = []

    // 一个命令可能按多个输入（例如多条作品链接的「相关推荐」）各跑一次；带 comment 参数的命令
    // 只对第一条链接生效——回复命令问的是一条评论，不是一批。
    const multi = this.spec.args.includes('item') && !this.spec.args.includes('comment')
    const inputs = multi ? splitUrls(params.urls) : ['']
    const sources = inputs.length ? inputs : ['']
    const identity = identityColumn(this.spec.output)
    const seen = new Set<string>()

    for (const source of sources) {
      const positional: string[] = []
      for (const arg of this.spec.args) {
        let value = paramFor(arg, params)
        if (arg === 'item' && source) value = source
        if (!value && arg in this.spec.optional) value = this.spec.optional[arg] ?? ''
        if (!value) {
          throw new CatbusError('USAGE', `${this.spec.mode} 需要 ${ARG_PARAMS[arg] ?? arg}`, {
            hint: `在节点设置里填写 ${ARG_PARAMS[arg] ?? arg}`,
          })
        }
        positional.push(value)
      }
      try {
        const value = await this.call(positional, target)
        let floor = 0
        for (const raw of rowsOf(value)) {
          if (rows.length >= target) break
          floor += 1
          const row = mapGenericOutput(this.spec.output, raw, this.platform, floor)
          const key = identity ? asString(row[identity]) : ''
          if (key && seen.has(key)) continue
          if (key) seen.add(key)
          rows.push(row)
          await this.onRow?.(row)
        }
      } catch (err) {
        const e = classifyThrown(err)
        if (multi && inputs.length > 1) {
          // 多个输入时单条失败不终止整批：与 B 站逐条补详情同一规则，warning 里点名是哪条。
          warnings.push(`${source}: ${e.code} ${e.message}`)
          continue
        }
        throw e
      }
    }

    return { rows, status: warnings.length ? 'partial' : 'ok', warnings, articles: [] }
  }
}

export function identityColumn(output: string): string {
  switch (output) {
    case 'Item':
      return '作品ID'
    case 'User':
      return '用户ID'
    case 'Comment':
      return '评论ID'
    case 'Keyword':
      return '关键词'
    case 'Topic':
      return '话题ID'
    case 'Live':
      return '直播间ID'
    case 'Folder':
      return '收藏夹ID'
    case 'Series':
      return '合集ID'
    case 'Category':
      return '分类ID'
    case 'Notice':
      return '通知ID'
    case 'Poi':
      return '地点ID'
    case 'Conversation':
      return '会话ID'
    case 'Message':
      return '消息ID'
    case 'Media':
      return '媒体ID'
    case 'Rank':
      return '排名'
    case 'Gift':
      return '礼物ID'
    case 'Danmaku':
      return '弹幕ID'
    default:
      return ''
  }
}
