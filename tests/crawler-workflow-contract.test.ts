import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CatbusError, type ErrorCode } from '../src/core/errors.js'
import { PLATFORMS } from '../src/platforms/index.js'
import { main } from '../src/integrations/crawler-workflow/cli.js'
import {
  ITEM_COLUMNS,
  USER_COLUMNS,
  COMMENT_COLUMNS,
  KEYWORD_COLUMNS,
  TOPIC_COLUMNS,
  LIVE_COLUMNS,
  FOLDER_COLUMNS,
  SERIES_COLUMNS,
  CATEGORY_COLUMNS,
  NOTICE_COLUMNS,
  POI_COLUMNS,
  CONVERSATION_COLUMNS,
  MESSAGE_COLUMNS,
  MEDIA_COLUMNS,
  RANK_COLUMNS,
  GIFT_COLUMNS,
  DANMAKU_COLUMNS,
  YOUTUBE_VIDEO_COLUMNS,
  YOUTUBE_COMMENT_COLUMNS,
} from '../src/integrations/crawler-workflow/columns.js'
import {
  aggregateStatus,
  asList,
  callError,
  classifyThrown,
  commentStatusOf,
  countOrBlank,
  formatCst,
  idOrEmpty,
  intOrZero,
  localStamp,
  parseCommentLimit,
  parseTarget,
  parseUrls,
  topicsOf,
} from '../src/integrations/crawler-workflow/common.js'
import { errorCodeForExit } from '../src/integrations/crawler-workflow/errors.js'
import { identityColumn, mapGenericOutput } from '../src/integrations/crawler-workflow/generic.js'
import { canonicalPlatform, manifest } from '../src/integrations/crawler-workflow/manifest.js'
import {
  PLATFORM_SPECS,
  mapYoutubeComment,
  mapYoutubeItem,
} from '../src/integrations/crawler-workflow/normalized.js'
import type { CatbusCall, CatbusEnvelope, CatbusRunner, RunParams } from '../src/integrations/crawler-workflow/types.js'
import { preflight, runMode } from '../src/integrations/crawler-workflow/runner.js'

// ─── 工具 ────────────────────────────────────────────────────────────────────

const ok = (data: unknown): CatbusCall => ({ args: [], code: 0, envelope: { ok: true, data }, stderr: '' })
const fail = (code: number, errorCode: string, message = 'boom'): CatbusCall => ({
  args: [],
  code,
  envelope: { ok: false, error: { code: errorCode as ErrorCode, message, hint: null, detail: null } },
  stderr: '',
})
const fake = (handler: (args: string[]) => CatbusCall | Promise<CatbusCall>): CatbusRunner => ({
  call: async (args) => handler(args),
})

/** 采析绘面板的词表（backend/capabilities/catbus.py）。清单不能出现这里没有的模式键。 */
const KNOWN_MODE_KEYS = new Set([
  'posts', 'author', 'hot', 'comments',
  'user.get', 'user.search', 'user.followers', 'user.following', 'user.likes', 'user.collects', 'user.reposts',
  'item.get', 'item.search', 'item.related', 'item.list', 'item.media', 'item.categories',
  'comment.list', 'comment.replies',
  'live.get', 'live.list', 'live.search', 'live.categories', 'live.gifts', 'live.products',
  'live.media', 'live.rank', 'live.replays',
  'keyword.hot', 'keyword.suggest', 'feed.list', 'feed.categories',
  'folder.list', 'folder.items', 'series.list', 'series.items', 'history.list',
  'topic.search', 'poi.search', 'notice.list', 'product.get', 'danmaku.list',
])

/** 采析绘的字段模板（CATBUS_FIELD_TEMPLATES）。清单不能声明这里没有的参数名。 */
const KNOWN_PARAMS = new Set([
  'keyword', 'target_count', 'catbus_account', 'author', 'urls', 'comment_limit', 'board',
  'room', 'folder', 'series', 'conversation', 'product', 'comment_id',
])

// ─── 清单与注册表的契约 ──────────────────────────────────────────────────────

describe('清单契约：采析绘能解析、能画出表单、能记账', () => {
  it('每个平台的每个模式都有状态、列和身份列，非可用态说明原因', () => {
    const m = manifest()
    expect(m.backend).toBe('catbus')
    expect(m.schema).toBe(1)
    expect(Object.keys(m.platforms)).toEqual([
      'bilibili', 'weibo', 'xiaohongshu', 'douyin', 'twitter', 'kuaishou', 'tiktok', 'jd', 'taobao', 'xianyu', 'youtube',
    ])
    for (const [platform, cap] of Object.entries(m.platforms)) {
      expect(cap.catbus_platform, platform).toBeTruthy()
      expect(cap.label, platform).toBeTruthy()
      expect(Object.keys(cap.modes).length, platform).toBeGreaterThan(0)
      for (const [mode, cell] of Object.entries(cap.modes)) {
        expect(['available', 'partial', 'planned', 'unavailable'], `${platform}.${mode}`).toContain(cell.status)
        if (cell.status === 'available' || cell.status === 'partial') {
          expect(cell.columns.length, `${platform}.${mode} 没有列`).toBeGreaterThan(0)
          expect(cell.identity?.length, `${platform}.${mode} 没有身份列`).toBeGreaterThan(0)
          for (const id of cell.identity!) expect(cell.columns, `${platform}.${mode} 身份列 ${id}`).toContain(id)
        } else {
          expect(cell.reason, `${platform}.${mode} 拒绝却没有原因`).toBeTruthy()
        }
      }
    }
  })

  it('模式键和参数名都在采析绘的词表与字段模板里（面板不会画不出表单）', () => {
    const m = manifest()
    const modes = new Set<string>()
    const params = new Set<string>()
    for (const cap of Object.values(m.platforms)) {
      for (const [mode, cell] of Object.entries(cap.modes)) {
        modes.add(mode)
        if (cell.status === 'unavailable') continue
        for (const p of cell.params ?? []) params.add(p)
      }
    }
    expect([...modes].filter((k) => !KNOWN_MODE_KEYS.has(k))).toEqual([])
    expect([...params].filter((k) => !KNOWN_PARAMS.has(k))).toEqual([])
  })

  it('清单里的命令都真实存在、已实现、只读、非流式，参数能填满', () => {
    const m = manifest()
    for (const cap of Object.values(m.platforms)) {
      const platform = PLATFORMS.find((p) => p.id === cap.catbus_platform)
      expect(platform, cap.catbus_platform).toBeTruthy()
      const web = platform!.endpoints.web
      if (web === 'planned') continue
      for (const [mode, cell] of Object.entries(cap.modes)) {
        if (!cell.command) continue
        const command = web.commands.get(cell.command)
        expect(command, `${cap.catbus_platform}.${mode}`).toBeTruthy()
        expect(command!.handler, `${cell.command} 没有处理器`).toBeTruthy()
        expect(command!.status).toBe('implemented')
        expect(Boolean(command!.mutating || command!.stream || command!.confirm)).toBe(false)
        // 共享模式的 argv 由适配器按采析绘字段拼，不经过清单的 args；独有模式才逐参数对账。
        if (cell.handler) continue
        expect((cell.args ?? []).length).toBe(command!.args.length)
        for (const [i, arg] of command!.args.entries()) {
          expect(cell.args![i]).toBe(arg.name)
          expect(KNOWN_PARAMS.has(cell.params![i]), `${cell.command} 的 ${arg.name} 没有表单字段`).toBe(true)
        }
      }
    }
  })

  it('登录要求跟随注册表：YouTube 游客可读的模式不再误报 required', () => {
    const m = manifest()
    expect(m.platforms.bilibili.modes['item.get'].auth).toBe('required')
    expect(m.platforms.youtube.modes.posts.auth).toBe('optional')
    expect(m.platforms.youtube.modes.comments.auth).toBe('optional')
    // 注册表显式要求登录的命令不能被「游客可读」带偏。
    expect(m.platforms.youtube.modes['feed.list'].auth).toBe('required')
    expect(m.platforms.youtube.modes['history.list'].auth).toBe('required')
  })

  it('YouTube 共享模式用与 Selenium 版同序的列；独有模式用通用列', () => {
    const m = manifest()
    expect(m.platforms.youtube.label).toBe('YouTube')
    expect(m.platforms.youtube.modes.posts.columns).toEqual(YOUTUBE_VIDEO_COLUMNS)
    expect(m.platforms.youtube.modes.author.columns).toEqual(YOUTUBE_VIDEO_COLUMNS)
    expect(m.platforms.youtube.modes.comments.columns).toEqual(YOUTUBE_COMMENT_COLUMNS)
    expect(m.platforms.youtube.modes['user.likes'].columns).toEqual(ITEM_COLUMNS)
    expect(m.platforms.youtube.modes['series.items'].columns).toEqual(ITEM_COLUMNS)
    expect(m.platforms.youtube.modes['user.get'].columns).toEqual(USER_COLUMNS)
    expect(m.platforms.youtube.modes.hot.status).toBe('unavailable')
    expect(m.platforms.youtube.modes.hot.reason).toContain('推荐流')
  })

  it('平台别名归一化，未知平台原样返回', () => {
    expect(canonicalPlatform(' yt ')).toBe('youtube')
    expect(canonicalPlatform('XHS')).toBe('xiaohongshu')
    expect(canonicalPlatform('b')).toBe('bilibili')
    expect(canonicalPlatform('nope')).toBe('nope')
  })

  it('声明的列与映射器实际产出的键完全相同（保护 Python 端的逐列校验）', () => {
    const m = manifest()
    const sample = {
      id: 'x1', url: 'https://example.com/x', kind: 'video', title: 't', text: '正文', created_at: '2026-01-01T10:00:00+08:00',
      author: { id: 'u1', name: '作者', url: 'https://example.com/u1' },
      stats: { views: 1, likes: 2, comments: 3, collects: 4, shares: 5, replies: 6, followers: 7, following: 8, items: 9 },
      media: [{ type: 'image', url: 'https://img/1' }, { type: 'video', url: 'https://v/1', duration: 42 }],
      cover: 'https://img/1',
      name: 'n', handle: 'h', bio: 'b', count: 3, parent_id: null,
      host: { name: '主播', url: 'https://example.com/host' },
      peer: { name: '对方', url: 'https://example.com/peer' },
      from: { name: '发送者', url: 'https://example.com/from' },
      user: { name: '用户', url: 'https://example.com/user' },
      target: { id: 't1', url: 'https://example.com/t1' },
      price: { amount: 9, currency: 'CNY' },
      status: 'live', viewers: 10, rank: 1, score: 100,
      width: 100, height: 200, duration: 42,
      offset: 3, item_id: 'i1',
      type: 'chat', last_message: 'hi', unread: 1, updated_at: '2026-01-01T10:00:00+08:00',
      conversation_id: 'c1', heat: 88, address: '地址', parent_id2: '',
      reply_count: 1,
    }
    for (const [platform, cap] of Object.entries(m.platforms)) {
      for (const [mode, cell] of Object.entries(cap.modes)) {
        if (cell.status !== 'available' && cell.status !== 'partial') continue
        // 共享模式用平台专用列和专用映射，在下面按 PLATFORM_SPECS 单独对账。
        if (cell.handler || !cell.command || !cell.output) continue
        const row = mapGenericOutput(cell.output, sample, cap.catbus_platform, 1)
        expect(Object.keys(row), `${platform}.${mode} (${cell.output})`).toEqual(cell.columns)
      }
    }
    // 共享模式的专用映射同样对账。
    const spec = PLATFORM_SPECS.youtube!
    expect(Object.keys(spec.mapItem(sample))).toEqual(YOUTUBE_VIDEO_COLUMNS)
    expect(Object.keys(spec.mapComment(sample, 'https://www.youtube.com/watch?v=abc', 1))).toEqual(YOUTUBE_COMMENT_COLUMNS)
    for (const [id, s] of Object.entries(PLATFORM_SPECS)) {
      expect(Object.keys(s.mapItem(sample)), `${id} 作品列`).toEqual(s.columns.item)
      expect(Object.keys(s.mapComment(sample, 'u', 1)), `${id} 评论列`).toEqual(s.columns.comment)
    }
  })
})

// ─── 归一化映射与通用映射 ────────────────────────────────────────────────────

describe('输出映射：缺失留空、真实 0 保留、类型一一对应', () => {
  it('每种归一化类型都映射到自己的通用列', () => {
    const base: Record<string, unknown> = {
      id: '1', text: 'hello', created_at: '2026-01-01T10:00:00+08:00',
      author: { id: 'a', name: '甲', url: 'https://x/u' },
      stats: { followers: 10 },
      rank: 0, score: 0, heat: 0, price: { amount: 0, currency: 'CNY' },
    }
    const cases: Array<[string, string[]]> = [
      ['Item', ITEM_COLUMNS], ['User', USER_COLUMNS], ['Comment', COMMENT_COLUMNS],
      ['Keyword', KEYWORD_COLUMNS], ['Topic', TOPIC_COLUMNS], ['Live', LIVE_COLUMNS],
      ['Folder', FOLDER_COLUMNS], ['Series', SERIES_COLUMNS], ['Category', CATEGORY_COLUMNS],
      ['Notice', NOTICE_COLUMNS], ['Poi', POI_COLUMNS], ['Conversation', CONVERSATION_COLUMNS],
      ['Message', MESSAGE_COLUMNS], ['Media', MEDIA_COLUMNS], ['Rank', RANK_COLUMNS],
      ['Gift', GIFT_COLUMNS], ['Danmaku', DANMAKU_COLUMNS],
    ]
    for (const [type, columns] of cases) {
      expect(Object.keys(mapGenericOutput(type, base, 'bilibili', 3)), type).toEqual(columns)
      expect(() => mapGenericOutput('AuthStatus', base, 'bilibili')).toThrow()
    }
    expect(mapGenericOutput('Keyword', { text: '热词', heat: 0 }, 'bilibili', 2)).toMatchObject({ 关键词: '热词', 热度: 0, 排名: 2 })
    expect(mapGenericOutput('Rank', { rank: 0, score: 0 }, 'bilibili', 4)).toMatchObject({ 排名: 4, 分数: 0 })
    expect(mapGenericOutput('Gift', { price: { amount: 0, currency: 'CNY' } }, 'bilibili')).toMatchObject({ 价格: 0, 币种: 'CNY' })
  })

  it('身份列按输出类型固定，未知类型没有身份列', () => {
    expect(identityColumn('Item')).toBe('作品ID')
    expect(identityColumn('User')).toBe('用户ID')
    expect(identityColumn('Comment')).toBe('评论ID')
    expect(identityColumn('Danmaku')).toBe('弹幕ID')
    expect(identityColumn('NoticeCount')).toBe('')
  })

  it('YouTube 作品/评论取到时长、频道、图片和视频 ID；缺失留空', () => {
    const row = mapYoutubeItem({
      id: 'abc123', title: '标题', text: '正文', url: 'https://www.youtube.com/watch?v=abc123',
      created_at: '2026-01-01T10:00:00+08:00',
      author: { id: 'UC123', name: '频道', url: 'https://www.youtube.com/@ch' },
      stats: { views: 100, likes: 5 },
      media: [{ type: 'video', url: 'https://v', duration: 3725 }],
    })
    expect(row).toMatchObject({
      标题: '标题', 正文: '正文', 视频ID: 'abc123', 频道ID: 'UC123',
      时长: '1:02:05', 时长秒: 3725, 播放数: 100, 点赞数: 5,
      链接: 'https://www.youtube.com/watch?v=abc123', 图片链接: '',
    })
    const empty = mapYoutubeItem({ id: 'x' })
    expect(empty.标题).toBe('')
    expect(empty.时长).toBe('')
    expect(empty.链接).toBe('https://www.youtube.com/watch?v=x')

    const comment = mapYoutubeComment(
      { id: 'c1', text: '评论', author: { id: 'UC9', name: '甲', url: 'https://x/u' }, stats: { likes: 2, replies: 1 } },
      'https://www.youtube.com/watch?v=abc123&t=3',
      7,
    )
    expect(comment).toMatchObject({ 平台: 'youtube', 视频ID: 'abc123', 楼层: 7, 评论ID: 'c1', 是否作者回复: '', 评论者ID: 'UC9' })
  })
})

// ─── 公共工具与错误收敛 ──────────────────────────────────────────────────────

describe('公共工具与错误收敛', () => {
  it('parseUrls 支持数组与换行、去重、去空', () => {
    expect(parseUrls(['a\nb', ' b ', '', 'c'])).toEqual(['a', 'b', 'c'])
    expect(parseUrls('  u  ')).toEqual(['u'])
  })

  it('parseTarget / parseCommentLimit 只接受合法整数', () => {
    expect(parseTarget(undefined)).toBe(50)
    expect(parseTarget('12')).toBe(12)
    for (const bad of [0, -1, 1.5, 'abc']) expect(() => parseTarget(bad)).toThrow()
    expect(parseTarget('')).toBe(50)
    expect(parseCommentLimit(undefined)).toBe(0)
    expect(parseCommentLimit('0')).toBe(0)
    for (const bad of [-1, 1.5, 'all']) expect(() => parseCommentLimit(bad)).toThrow()
  })

  it('缺失计数留空、真实 0 保留；0 号父评论落空串', () => {
    expect(countOrBlank(null)).toBe('')
    expect(countOrBlank(0)).toBe(0)
    expect(countOrBlank('x')).toBe('')
    expect(intOrZero(null)).toBe(0)
    expect(intOrZero(3)).toBe(3)
    expect(idOrEmpty(0)).toBe('')
    expect(idOrEmpty('0')).toBe('')
    expect(idOrEmpty('12')).toBe('12')
  })

  it('北京时间格式化不受运行机器时区影响', () => {
    expect(formatCst(1577835803)).toBe('2020-01-01 07:43:23')
    expect(formatCst(0)).toBe('')
    expect(formatCst(null)).toBe('')
    expect(localStamp('2026-01-01T10:00:00+08:00')).toBe('2026-01-01 10:00:00')
    expect(localStamp('')).toBe('')
  })

  it('topicsOf 只取正文里的 #话题', () => {
    expect(topicsOf('正文 #甲# 和 #乙')).toEqual(['甲', '乙'])
    expect(topicsOf('没有话题')).toEqual([])
  })

  it('asList 遇到非数组报 UPSTREAM', () => {
    expect(asList([1, 2], 'x')).toEqual([1, 2])
    expect(() => asList({ a: 1 }, 'x')).toThrow(/不是数组/)
  })

  it('没有信封时用退出码分类；有信封时读信封的错误码', () => {
    expect(errorCodeForExit(3)).toBe('AUTH_REQUIRED')
    expect(errorCodeForExit(5)).toBe('RISK_CONTROL')
    expect(errorCodeForExit(99)).toBe('ERROR')
    expect(callError(fail(3, 'AUTH_REQUIRED', '未登录')).code).toBe('AUTH_REQUIRED')
    expect(callError({ args: [], code: 6, envelope: null, stderr: 'boom' }).code).toBe('NETWORK')
    expect(callError({ args: [], code: 0, envelope: { ok: true }, stderr: '' }).code).toBe('UPSTREAM')
    expect(classifyThrown('oops').code).toBe('ERROR')
  })

  it('错误 → 采析绘的 ok / blocked / dead 收敛', () => {
    expect(commentStatusOf(classifyThrown(new Error('x')))).toBe('error')
    const c = (code: string, detail: unknown = null) => new CatbusError(code as ErrorCode, 'm', { detail })
    expect(commentStatusOf(c('AUTH_REQUIRED'))).toBe('blocked')
    expect(commentStatusOf(c('RISK_CONTROL'))).toBe('blocked')
    expect(commentStatusOf(c('NETWORK'))).toBe('error')
    expect(commentStatusOf(c('UPSTREAM', { code: '-404' }))).toBe('dead')
    expect(commentStatusOf(c('UPSTREAM', { message: '啥都木有' }))).toBe('dead')
    expect(commentStatusOf(c('UPSTREAM', { code: '-500' }))).toBe('blocked')
  })

  it('aggregateStatus 按文章汇总', () => {
    const a = (status: string) => ({ url: 'u', status, rows: 0, error: null }) as never
    expect(aggregateStatus([])).toBe('error')
    expect(aggregateStatus([a('ok'), a('ok')])).toBe('ok')
    expect(aggregateStatus([a('ok'), a('dead')])).toBe('partial')
    expect(aggregateStatus([a('blocked'), a('blocked')])).toBe('blocked')
    expect(aggregateStatus([a('dead'), a('dead')])).toBe('dead')
    expect(aggregateStatus([a('blocked'), a('error')])).toBe('blocked')
  })

  it('preflight 不认平台时报 UNSUPPORTED；崩溃时按退出码分类', async () => {
    await expect(preflight('nope', fake(() => ok({})))).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    await expect(preflight('bilibili', fake(() => ({ args: [], code: 6, envelope: null, stderr: '' })))).rejects.toMatchObject({ code: 'NETWORK' })
  })

  it('runMode 不认平台/模式、不支持的模式分别报 USAGE / UNSUPPORTED', async () => {
    const client = fake(() => ok([]))
    await expect(runMode('nope', 'posts', {}, client)).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    await expect(runMode('bilibili', 'nope', {}, client)).rejects.toMatchObject({ code: 'USAGE' })
    await expect(runMode('weibo', 'hot', {}, client)).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })

  it('comments 的 limit 是每篇文章的上限，不是整批的上限', async () => {
    const calls: string[][] = []
    const client = fake((args) => {
      calls.push(args)
      // 两篇文章，各自返回 3 条根评论；limit=2 时每篇都应取到 2 条。
      return ok([
        { id: `${args[3]}-1`, text: 'a', author: { name: '甲' } },
        { id: `${args[3]}-2`, text: 'b', author: { name: '乙' } },
        { id: `${args[3]}-3`, text: 'c', author: { name: '丙' } },
      ])
    })
    const result = await runMode('weibo', 'comments', { urls: ['url-a', 'url-b'], comment_limit: 2 }, client)
    expect(result.rows).toHaveLength(4)
    expect(result.articles.map((a) => a.rows)).toEqual([2, 2])
    expect(calls.length).toBe(2)
  })
})

// ─── CLI 端到端：与 Python 桥接真正打交道的边界 ─────────────────────────────

interface FakeConfig {
  rules?: Array<{ any: string[]; data?: unknown; envelope?: CatbusEnvelope; code?: number; stderr?: string }>
  default?: unknown
}

interface AdapterResult {
  code: number
  stdout: string
  stderr: string
  summary: any
  rows: any[]
}

describe('适配器 CLI 端到端（假 catbus 子进程）', () => {
  let dir: string
  let bin: string
  let outSpy: ReturnType<typeof vi.spyOn>
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'catbus-cw-'))
    bin = join(dir, 'fake-catbus.mjs')
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ rules: [], default: [] } satisfies FakeConfig))
    // 假 catbus：记录每次调用的 argv，按 any 中的关键词匹配规则，输出 JSON 信封。
    writeFileSync(
      bin,
      `import { readFileSync, appendFileSync } from 'node:fs'\n` +
      `import { join } from 'node:path'\n` +
      `const dir = ${JSON.stringify(dir)}\n` +
      `const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))\n` +
      `const args = process.argv.slice(2)\n` +
      `appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n')\n` +
      `const rule = (cfg.rules || []).find((r) => (r.any || []).every((k) => args.includes(k)))\n` +
      `if (rule) {\n` +
      `  const env = rule.envelope || { ok: true, data: rule.data === undefined ? [] : rule.data }\n` +
      `  process.stdout.write(JSON.stringify(env) + '\\n')\n` +
      `  if (rule.stderr) process.stderr.write(rule.stderr + '\\n')\n` +
      `  process.exit(rule.code === undefined ? 0 : rule.code)\n` +
      `}\n` +
      `process.stdout.write(JSON.stringify({ ok: true, data: cfg.default === undefined ? [] : cfg.default }) + '\\n')\n`,
    )
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never)
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)
  })

  afterEach(() => {
    outSpy.mockRestore()
    errSpy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  const configure = (cfg: FakeConfig) => writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg))
  const calls = (): string[][] => {
    try {
      return readCalls(join(dir, 'calls.jsonl'))
    } catch {
      return []
    }
  }

  async function runAdapter(...argv: string[]): Promise<AdapterResult> {
    outSpy.mockClear()
    errSpy.mockClear()
    // 测试可以自己指定 --catbus-bin（例如故意给一个坏路径），否则用默认的假可执行文件。
    const withBin = argv.includes('--catbus-bin') ? argv : [...argv, '--catbus-bin', bin]
    const code = await main(withBin)
    const stdout = outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')
    const stderr = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')
    let summary: any = null
    const lines = stderr.trim().split('\n').filter(Boolean)
    try {
      summary = JSON.parse(lines[lines.length - 1] ?? '')
    } catch {}
    // capabilities / preflight 的 stdout 是一份漂亮打印的 JSON，只有 run 的 jsonl 才逐行是记录。
    const isRunJsonl = argv[0] === 'run' && !(argv.includes('-o') && argv[argv.indexOf('-o') + 1] === 'json')
    const rows = isRunJsonl && stdout.trim() ? stdout.trim().split('\n').map((l: string) => JSON.parse(l)) : []
    return { code, stdout, stderr, summary, rows }
  }

  it('capabilities 输出 Python 桥能解析的清单', async () => {
    const r = await runAdapter('capabilities')
    expect(r.code).toBe(0)
    const m = JSON.parse(r.stdout)
    expect(m.backend).toBe('catbus')
    expect(m.schema).toBe(1)
    expect(m.platforms.youtube.modes.posts.status).toBe('available')
  })

  it('run 逐行输出 jsonl，stderr 摘要带列、行数和后端', async () => {
    configure({
      default: [
        { id: '1', kind: 'video', title: '甲', url: 'u1', created_at: '2026-01-01T10:00:00+08:00', author: { name: 'A' }, stats: { likes: 1 } },
      ],
    })
    const r = await runAdapter('run', '--platform', 'kuaishou', '--mode', 'posts', '--keyword', '词')
    expect(r.code).toBe(0)
    expect(r.rows).toHaveLength(1)
    expect(Object.keys(r.rows[0])).toEqual(ITEM_COLUMNS)
    expect(r.summary).toMatchObject({ ok: true, backend: 'catbus', status: 'ok', rows: 1, platform: 'kuaishou' })
    expect(r.summary.columns).toEqual(ITEM_COLUMNS)
    expect(calls()[0]!.slice(0, 4)).toEqual(['kuaishou', 'item', 'search', '词'])
    expect(calls()[0]).toContain('-o')
  })

  it('-o json 输出一个数组；--provenance 追加采集方式列', async () => {
    configure({ default: [{ id: '1', text: 'x' }] })
    const json = await runAdapter('run', '--platform', 'kuaishou', '--mode', 'posts', '--keyword', 'k', '-o', 'json')
    expect(JSON.parse(json.stdout.trim())).toHaveLength(1)

    const prov = await runAdapter('run', '--platform', 'kuaishou', '--mode', 'posts', '--keyword', 'k', '--provenance')
    expect(Object.keys(prov.rows[0]).at(-1)).toBe('采集方式')
    expect(prov.rows[0].采集方式).toBe('catbus')
    expect(prov.summary.columns.at(-1)).toBe('采集方式')
  })

  it('--params @file 与快捷选项合并，账号只作为 -a 传给 catbus', async () => {
    const file = join(dir, 'params.json')
    writeFileSync(file, JSON.stringify({ keyword: '文件里的词', target_count: 3, account: 'selenium', catbus_account: 'catbus-work' }))
    configure({ default: [] })
    await runAdapter('run', '--platform', 'kuaishou', '--mode', 'posts', '--params', `@${file}`, '--keyword', '覆盖')
    const call = calls()[0]!
    expect(call.slice(0, 4)).toEqual(['kuaishou', 'item', 'search', '覆盖'])
    expect(call).toContain('3')
    expect(call).toContain('catbus-work')
    expect(call).not.toContain('selenium')
  })

  it('--params - 从 stdin 读参数：这是 Python 桥实际使用的传参方式', async () => {
    configure({ default: [{ id: '1', text: '甲' }] })
    const original = process.stdin
    const descriptor = Object.getOwnPropertyDescriptor(process, 'stdin')
    try {
      Object.defineProperty(process, 'stdin', {
        configurable: true,
        value: Readable.from([JSON.stringify({ keyword: '管道里的词', target_count: 1 })]),
      })
      const r = await runAdapter('run', '--platform', 'kuaishou', '--mode', 'posts', '--params', '-')
      expect(r.code).toBe(0)
      expect(r.rows).toHaveLength(1)
      expect(calls()[0]!.slice(0, 4)).toEqual(['kuaishou', 'item', 'search', '管道里的词'])
    } finally {
      if (descriptor) Object.defineProperty(process, 'stdin', descriptor)
      else Object.defineProperty(process, 'stdin', { configurable: true, value: original })
    }
  })

  it('catbus 可执行文件起不来时报 NETWORK 并提示检查路径', async () => {
    const missing = join(dir, 'not-there.exe')
    const r = await runAdapter('run', '--platform', 'kuaishou', '--mode', 'posts', '--keyword', 'k', '--catbus-bin', missing)
    expect(r.code).toBe(6)
    expect(r.summary.error.code).toBe('NETWORK')
    expect(r.summary.error.hint).toContain('CATBUS_BIN')
  })

  it('帮助与未知命令不启动子进程', async () => {
    const help = await runAdapter('--help')
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('catbus-crawler-workflow capabilities')
    const unknown = await runAdapter('nope')
    expect(unknown.code).toBe(2)
    expect(unknown.summary.error.code).toBe('USAGE')
    expect(calls()).toEqual([])
  })

  it('坏参数、未知平台/模式、坏输出格式都以 USAGE/UNSUPPORTED 退出', async () => {
    expect((await runAdapter('run', '--platform', 'kuaishou', '--mode', 'posts', '--keyword', 'k', '--output', 'xml')).code).toBe(2)
    expect((await runAdapter('run', '--platform', 'nope', '--mode', 'posts')).code).toBe(2)
    expect((await runAdapter('run', '--platform', 'bilibili', '--mode', 'nope')).code).toBe(2)
    expect((await runAdapter('run', '--platform', 'weibo', '--mode', 'hot')).code).toBe(2)
    const badJson = await runAdapter('run', '--platform', 'kuaishou', '--mode', 'posts', '--params', '{oops')
    expect(badJson.code).toBe(2)
    expect(badJson.summary.error.code).toBe('USAGE')
  })

  it('已写出的行不撤回：后面的链接登录墙时摘要报实际行数，退出码 3', async () => {
    configure({
      rules: [
        {
          any: ['url-a'],
          data: [{ id: 'c1', text: '评', author: { name: '甲' } }],
        },
        {
          any: ['url-b'],
          envelope: { ok: false, error: { code: 'AUTH_REQUIRED', message: '未登录', hint: 'catbus weibo auth login', detail: null } },
          code: 3,
        },
      ],
    })
    const r = await runAdapter('run', '--platform', 'weibo', '--mode', 'comments', '--url', 'url-a', '--url', 'url-b')
    expect(r.rows).toHaveLength(1)
    // 已经写出一行 + 后续文章被登录墙拦下 = partial，退出码 0；错误逐篇写在 articles 里，
    // Python 桥的 _summary_error 会读 articles[].error 并把提示交给用户。
    expect(r.code).toBe(0)
    expect(r.summary).toMatchObject({ rows: 1, status: 'partial' })
    expect(r.summary.articles.map((a: any) => a.status)).toEqual(['ok', 'blocked'])
    expect(r.summary.articles[1].error.code).toBe('AUTH_REQUIRED')
  })

  it('catbus 崩溃没有信封时按退出码分类', async () => {
    configure({ rules: [{ any: ['x'], code: 6, stderr: 'boom' }] })
    const r = await runAdapter('run', '--platform', 'kuaishou', '--mode', 'posts', '--keyword', 'x')
    expect(r.code).toBe(6)
    expect(r.summary.error.code).toBe('NETWORK')
  })

  it('preflight 未登录返回 3 和登录提示；已登录返回账号信息', async () => {
    configure({
      rules: [{
        any: ['auth', 'status'],
        envelope: { ok: true, account: 'default', data: { logged_in: false, user: null, method: null, expires_at: null } },
      }],
    })
    const no = await runAdapter('preflight', '--platform', 'bilibili')
    expect(no.code).toBe(3)
    expect(JSON.parse(no.stdout)).toMatchObject({ logged_in: false, error: { code: 'AUTH_REQUIRED' } })
    expect(JSON.parse(no.stdout).error.hint).toContain('catbus bilibili auth login')

    configure({
      rules: [{
        any: ['auth', 'status'],
        envelope: {
          ok: true, account: 'work',
          data: { logged_in: true, user: { id: '1', name: '甲' }, method: 'qrcode', expires_at: null },
        },
      }],
    })
    const yes = await runAdapter('preflight', '--platform', 'bilibili', '--account', 'work')
    expect(yes.code).toBe(0)
    expect(JSON.parse(yes.stdout)).toMatchObject({ logged_in: true, account: 'work', backend: 'catbus', endpoint: 'web' })
  })

  it('preflight 不认识的平台按错误信封返回，不启动子进程', async () => {
    const r = await runAdapter('preflight', '--platform', 'nope')
    expect(r.code).toBe(2)
    expect(calls()).toEqual([])
    expect(JSON.parse(r.stdout).error.code).toBe('UNSUPPORTED')
  })
})

// 把假 catbus 记录的 argv 读回来。
function readCalls(file: string): string[][] {
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[])
}
