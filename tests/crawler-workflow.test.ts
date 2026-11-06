import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CatbusError } from '../src/core/errors.js'
import { VOCAB } from '../src/core/vocab.js'
import { PLATFORMS } from '../src/platforms/index.js'
import {
  BILIBILI_COMMENT_COLUMNS,
  BILIBILI_VIDEO_COLUMNS,
  formatCst,
  mapBilibiliCommentThread,
  mapBilibiliVideo,
} from '../src/integrations/crawler-workflow/bilibili.js'
import { createRowWriter } from '../src/integrations/crawler-workflow/cli.js'
import {
  DOUYIN_COMMENT_COLUMNS,
  DOUYIN_VIDEO_COLUMNS,
  KEYWORD_COLUMNS,
  USER_COLUMNS,
  WEIBO_COMMENT_COLUMNS,
  WEIBO_POST_COLUMNS,
} from '../src/integrations/crawler-workflow/columns.js'
import { manifest, platformCapability } from '../src/integrations/crawler-workflow/manifest.js'
import { mapDouyinComment, mapDouyinItem, mapTwitterItem, mapWeiboComment, mapWeiboItem, mapXhsComment } from '../src/integrations/crawler-workflow/normalized.js'
import { preflight, runMode } from '../src/integrations/crawler-workflow/runner.js'
import type { CatbusCall, CatbusRunner } from '../src/integrations/crawler-workflow/types.js'

const VIDEO = {
  bvid: 'BV1GJ411x7h7',
  aid: 80433022,
  title: '测试 & 视频',
  desc: '简介',
  pubdate: 1577835803,
  duration: 213,
  videos: 2,
  owner: { mid: 10001, name: 'UP' },
  stat: { view: 1000, danmaku: 3, reply: 5, favorite: 7, coin: 9, share: 11, like: 13 },
  ugc_season: { title: '合集' },
}

const ROOT = {
  rpid: 100,
  root: 0,
  parent: 0,
  ctime: 1577835803,
  like: 4,
  count: 9,
  rcount: 3,
  member: { mid: 200, uname: '用户', level_info: { current_level: 5 } },
  content: { message: '根评论' },
  card_label: [{ text_content: 'UP主觉得很赞' }],
  replies: [
    {
      rpid: 101,
      root: 100,
      parent: 100,
      ctime: 1577835903,
      like: 1,
      count: 0,
      rcount: 0,
      member: { mid: 201, uname: '回复者', level_info: { current_level: 2 } },
      content: { message: '子回复' },
    },
  ],
}

function ok(data: unknown, args: string[] = []): CatbusCall {
  return { args, code: 0, envelope: { ok: true, data }, stderr: '' }
}

function fakeClient(handler: (args: string[]) => CatbusCall | Promise<CatbusCall>): CatbusRunner {
  return { call: async (args) => handler(args) }
}

describe('采析绘 CatBus 适配器', () => {
  it('B站视频 raw 映射到采析绘的 18 列，缺失计数留空而不是 0', () => {
    const row = mapBilibiliVideo(VIDEO)
    expect(Object.keys(row)).toEqual(BILIBILI_VIDEO_COLUMNS)
    expect(row).toMatchObject({
      标题: '测试 & 视频',
      UP主: 'UP',
      UP主ID: '10001',
      正文: '简介',
      发布时间: '2020-01-01 07:43:23',
      BV号: 'BV1GJ411x7h7',
      稿件ID: '80433022',
      合集: '合集',
      分P数: 2,
      时长秒: 213,
      播放数: 1000,
      点赞数: 13,
      投币数: 9,
      收藏数: 7,
      转发数: 11,
      弹幕数: 3,
      评论数: 5,
      链接: 'https://www.bilibili.com/video/BV1GJ411x7h7/',
    })

    const missing = mapBilibiliVideo({ bvid: 'BV1', title: 't', stat: {} })
    expect(missing.播放数).toBe('')
    expect(missing.点赞数).toBe('')
    expect(missing.评论数).toBe('')
  })

  it('B站评论展开预览子回复，楼层、父评论、等级和 UP主态与 Selenium 版一致', () => {
    const rows = mapBilibiliCommentThread([ROOT], 'https://www.bilibili.com/video/BV1GJ411x7h7/')
    expect(rows).toHaveLength(2)
    expect(Object.keys(rows[0]!)).toEqual(BILIBILI_COMMENT_COLUMNS)
    expect(rows[0]).toMatchObject({
      平台: 'bilibili',
      文章URL: 'https://www.bilibili.com/video/BV1GJ411x7h7/',
      评论者: '用户',
      评论者主页: 'https://space.bilibili.com/200',
      用户等级: 5,
      评论内容: '根评论',
      评论时间: '2020-01-01 07:43:23',
      点赞数: 4,
      楼层: 1,
      评论ID: '100',
      父评论ID: '',
      子回复数: 3,
      回复数: 9,
      UP主态: '点赞',
    })
    expect(rows[1]).toMatchObject({
      评论者: '回复者',
      楼层: 2,
      评论ID: '101',
      父评论ID: '100',
      子回复数: 0,
      回复数: 0,
      UP主态: '',
    })

    expect(mapBilibiliCommentThread([ROOT], 'u', 1)).toHaveLength(1)
    expect(mapBilibiliCommentThread([ROOT, ROOT], 'u')).toHaveLength(4)

    const spaced = mapBilibiliCommentThread(
      [{ ...ROOT, replies: [], content: { message: '  多行\n' }, member: { ...ROOT.member, uname: ' 用户 ' } }],
      'u',
    )
    expect(spaced[0]!.评论内容).toBe('  多行\n')
    expect(spaced[0]!.评论者).toBe(' 用户 ')
  })

  it('平台 × 模式清单按采析绘的 id 给出可用性和原因', () => {
    const m = manifest()
    expect(m.backend).toBe('catbus')
    expect(m.platforms.bilibili.modes.comments.status).toBe('available')
    expect(m.platforms.bilibili.modes.posts.status).toBe('available')
    expect(m.platforms.bilibili.modes.hot.status).toBe('partial')
    expect(m.platforms.bilibili.modes.posts.identity).toEqual(['链接'])
    expect(m.platforms.bilibili.modes.comments.identity).toEqual(['平台', '评论ID'])
    expect(m.platforms.weibo.modes.hot.status).toBe('unavailable')
    expect(m.platforms.xiaohongshu.catbus_platform).toBe('xhs')
    expect(m.platforms.twitter.catbus_platform).toBe('x')
    expect(platformCapability('xhs')?.catbus_platform).toBe('xhs')
    expect(platformCapability('twitter')?.catbus_platform).toBe('x')
    expect(platformCapability('unknown')).toBeNull()
  })

  it('B站评论通过 CatBus comment list --all 调用并输出行', async () => {
    const calls: string[][] = []
    const client = fakeClient((args) => {
      calls.push(args)
      return ok([ROOT], args)
    })
    const result = await runMode('bilibili', 'comments', { urls: ['https://www.bilibili.com/video/BV1'] }, client)
    expect(result.status).toBe('ok')
    expect(result.rows).toHaveLength(2)
    expect(calls[0]).toEqual([
      'bilibili',
      'comment',
      'list',
      'https://www.bilibili.com/video/BV1',
      '--all',
      '-o',
      'json',
      '--raw',
      '-q',
    ])
  })

  it('采析绘账号不会被当成 CatBus 账号；只有 catbus_account 才传 -a', async () => {
    const calls: string[][] = []
    const client = fakeClient((args) => {
      calls.push(args)
      return ok([])
    })
    await runMode('bilibili', 'comments', { urls: ['u'], account: 'selenium-work' }, client)
    expect(calls[0]).not.toContain('-a')
    await runMode('bilibili', 'comments', { urls: ['u'], catbus_account: 'catbus-work' }, client)
    expect(calls[1]).toContain('-a')
    expect(calls[1]).toContain('catbus-work')
  })

  it('B站 hot 明确拒绝 ranking，不会悄悄换成 popular', async () => {
    const client = fakeClient(() => ok([]))
    await expect(runMode('bilibili', 'hot', { board: 'ranking' }, client)).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    })
  })

  it('B站 posts 先搜索卡片，再逐条 item get 补详情', async () => {
    const calls: string[][] = []
    const client = fakeClient((args) => {
      calls.push(args)
      if (args.includes('search')) return ok([{ bvid: 'BV1GJ411x7h7' }], args)
      if (args.includes('get')) return ok(VIDEO, args)
      return ok([], args)
    })
    const result = await runMode('bilibili', 'posts', { keyword: '测试', target_count: 1 }, client)
    expect(result.status).toBe('ok')
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]!.BV号).toBe('BV1GJ411x7h7')
    expect(calls.some((args) => args.includes('search'))).toBe(true)
    expect(calls.some((args) => args.includes('get'))).toBe(true)
  })

  it('B站 author 走 user items，再逐条补详情', async () => {
    const calls: string[][] = []
    const client = fakeClient((args) => {
      calls.push(args)
      if (args.includes('user')) return ok([{ bvid: 'BV1GJ411x7h7' }], args)
      if (args.includes('get')) return ok(VIDEO, args)
      return ok([], args)
    })
    const result = await runMode('bilibili', 'author', { author: '2', target_count: 1 }, client)
    expect(result.status).toBe('ok')
    expect(result.rows).toHaveLength(1)
    expect(calls[0]!.slice(0, 4)).toEqual(['bilibili', 'user', 'items', '2'])
    expect(calls.some((args) => args.includes('get'))).toBe(true)
  })

  it('B站 hot 只走 popular 的 feed list', async () => {
    const calls: string[][] = []
    const client = fakeClient((args) => {
      calls.push(args)
      return ok([VIDEO], args)
    })
    const result = await runMode('bilibili', 'hot', { board: 'popular', target_count: 1 }, client)
    expect(result.status).toBe('ok')
    expect(result.rows).toHaveLength(1)
    expect(calls[0]!.slice(0, 6)).toEqual(['bilibili', 'feed', 'list', '--kind', 'hot', '--limit'])
  })

  it('未适配的微博热榜返回可展示的原因', async () => {
    const client = fakeClient(() => ok([]))
    await expect(runMode('weibo', 'hot', {}, client)).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      message: expect.stringContaining('热搜'),
    })
  })

  it('评论错误按采析绘状态收敛', async () => {
    const client = fakeClient((args) => ({
      args,
      code: 3,
      envelope: {
        ok: false,
        error: { code: 'AUTH_REQUIRED', message: '未登录', hint: 'catbus bilibili auth login', detail: null },
      },
      stderr: '',
    }))
    const result = await runMode('bilibili', 'comments', { urls: ['https://www.bilibili.com/video/BV1'] }, client)
    expect(result.status).toBe('blocked')
    expect(result.articles[0]?.status).toBe('blocked')
  })

  it('CatBus 崩溃没有信封时按退出码映射错误', async () => {
    const network = fakeClient((args) => ({ args, code: 6, envelope: null, stderr: 'boom' }))
    await expect(runMode('bilibili', 'posts', { keyword: 'x' }, network)).rejects.toMatchObject({
      code: 'NETWORK',
    })
    const auth = fakeClient((args) => ({ args, code: 3, envelope: null, stderr: 'login' }))
    await expect(runMode('bilibili', 'posts', { keyword: 'x' }, auth)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    })
  })

  it('预检单独检查 CatBus 登录态，未登录时给出登录命令', async () => {
    const calls: string[][] = []
    const client = fakeClient((args) => {
      calls.push(args)
      return {
        args,
        code: 0,
        envelope: {
          ok: true,
          account: 'default',
          data: { logged_in: false, user: null, method: null, expires_at: null },
        },
        stderr: '',
      }
    })
    const result = await preflight('bilibili', client, 'default')
    expect(result.logged_in).toBe(false)
    expect(result.error?.code).toBe('AUTH_REQUIRED')
    expect(result.error?.hint).toContain('catbus bilibili auth login')
    expect(calls[0]).toEqual(['bilibili', 'auth', 'status', '-o', 'json', '-q', '-a', 'default'])
  })

  it('预检已登录时返回 CatBus 账号和 endpoint', async () => {
    const calls: string[][] = []
    const client = fakeClient((args) => {
      calls.push(args)
      return {
        args,
        code: 0,
        envelope: {
          ok: true,
          account: 'catbus-work',
          data: { logged_in: true, user: { id: '1', name: 'catbus' }, method: 'qrcode', expires_at: null },
        },
        stderr: '',
      }
    })
    const result = await preflight('bilibili', client, ' catbus-work ')
    expect(result).toMatchObject({
      ok: true,
      backend: 'catbus',
      endpoint: 'web',
      platform: 'bilibili',
      account: 'catbus-work',
      logged_in: true,
      error: null,
    })
    expect(calls[0]).toEqual(['bilibili', 'auth', 'status', '-o', 'json', '-q', '-a', 'catbus-work'])
  })

  it('预检在 CatBus 崩溃时也按退出码分类', async () => {
    const client = fakeClient((args) => ({ args, code: 3, envelope: null, stderr: 'login' }))
    await expect(preflight('bilibili', client)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
  })

  it('北京时间格式化固定加 8 小时，不受运行机器时区影响', () => {
    expect(formatCst(1577835803)).toBe('2020-01-01 07:43:23')
    expect(formatCst(null)).toBe('')
    expect(formatCst(0)).toBe('')
  })

  it('B站详情失败时保留其余行并给出 warning', async () => {
    const client = fakeClient((args) => {
      if (args.includes('search')) return ok([{ bvid: 'BV1' }, { bvid: 'BV2' }], args)
      if (args.includes('BV1')) {
        return {
          args,
          code: 7,
          envelope: { ok: false, error: { code: 'UPSTREAM', message: '404', hint: null, detail: null } },
          stderr: '',
        }
      }
      return ok({ ...VIDEO, bvid: 'BV2' }, args)
    })
    const result = await runMode('bilibili', 'posts', { keyword: '测试', target_count: 2 }, client)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]!.BV号).toBe('BV2')
    expect(result.status).toBe('partial')
    expect(result.warnings[0]).toContain('BV1')
  })

  it('逐条详情：第一条在第二条请求发出前就交给调用方', async () => {
    const events: string[] = []
    const client = fakeClient((args) => {
      if (args.includes('search')) {
        events.push('search')
        return ok([{ bvid: 'BV1' }, { bvid: 'BV2' }], args)
      }
      events.push(`get ${args[3]}`)
      return ok({ ...VIDEO, bvid: args[3] }, args)
    })
    await runMode('bilibili', 'posts', { keyword: '测试', target_count: 2 }, client, (row) => {
      events.push(`row ${row.BV号}`)
    })
    expect(events).toEqual(['search', 'get BV1', 'row BV1', 'get BV2', 'row BV2'])
  })

  it('评论按链接交接：上一条的行在下一条请求发出前全部交出', async () => {
    const events: string[] = []
    const client = fakeClient((args) => {
      events.push(`call ${args[3]}`)
      return ok([ROOT], args)
    })
    await runMode(
      'bilibili',
      'comments',
      { urls: ['https://www.bilibili.com/video/BV1', 'https://www.bilibili.com/video/BV2'] },
      client,
      (row) => {
        events.push(`row ${row.文章URL}`)
      },
    )
    expect(events).toEqual([
      'call https://www.bilibili.com/video/BV1',
      'row https://www.bilibili.com/video/BV1',
      'row https://www.bilibili.com/video/BV1',
      'call https://www.bilibili.com/video/BV2',
      'row https://www.bilibili.com/video/BV2',
      'row https://www.bilibili.com/video/BV2',
    ])
  })

  it('jsonl 一行一写、json 缓冲到结束，写出的行数供失败摘要引用', async () => {
    const lines: string[] = []
    const jsonl = createRowWriter({
      output: 'jsonl',
      provenance: true,
      write: (line) => {
        lines.push(line)
      },
    })
    await jsonl.onRow({ 标题: '甲' })
    expect(lines).toEqual([`{"标题":"甲","采集方式":"catbus"}\n`])
    expect(jsonl.written).toBe(1)
    await jsonl.onRow({ 标题: '乙' })
    await jsonl.finish()
    // finish 只在 json 格式下补写整个数组；jsonl 已经在过程中写完。
    expect(lines).toHaveLength(2)

    const buffered: string[] = []
    const json = createRowWriter({
      output: 'json',
      provenance: false,
      write: (line) => {
        buffered.push(line)
      },
    })
    await json.onRow({ 标题: '甲' })
    expect(buffered).toEqual([])
    expect(json.written).toBe(1)
    await json.finish()
    expect(JSON.parse(buffered.join(''))).toEqual([{ 标题: '甲' }])
  })

  it('CatbusError 的 exitCode 保持 CatBus 的退出码约定', () => {
    expect(new CatbusError('AUTH_REQUIRED', 'x').exitCode).toBe(3)
    expect(new CatbusError('UNSUPPORTED', 'x').exitCode).toBe(2)
  })
})

describe('CatBus 读能力扩面', () => {
  it('原先 planned 的格子现在有真实处理器，抖音热榜按上游事实仍拒绝', () => {
    const m = manifest()
    const status = (platform: string, mode: string) => m.platforms[platform]?.modes[mode]?.status
    expect(status('weibo', 'posts')).toBe('partial')
    expect(status('weibo', 'author')).toBe('available')
    expect(status('weibo', 'comments')).toBe('partial')
    expect(status('xiaohongshu', 'posts')).toBe('available')
    expect(status('xiaohongshu', 'author')).toBe('available')
    expect(status('xiaohongshu', 'comments')).toBe('available')
    expect(status('douyin', 'posts')).toBe('available')
    expect(status('douyin', 'author')).toBe('available')
    expect(status('douyin', 'comments')).toBe('available')
    expect(status('twitter', 'posts')).toBe('available')
    expect(status('twitter', 'author')).toBe('available')
    expect(status('twitter', 'comments')).toBe('available')
    // 上游 feedList 对 hot 直接 NOT_IMPLEMENTED：这里必须是拒绝，不能假装采到空表。
    expect(status('douyin', 'hot')).toBe('unavailable')
    expect(m.platforms.douyin.modes.hot.reason).toContain('NOT_IMPLEMENTED')
  })

  it('CatBus 独有的平台也进清单，且只列真实实现的读命令', () => {
    const m = manifest()
    expect(m.platforms.kuaishou.label).toBe('快手')
    expect(m.platforms.tiktok.label).toBe('TikTok')
    expect(m.platforms.kuaishou.modes.posts.status).toBe('partial')
    expect(m.platforms.tiktok.modes.comments.status).toBe('available')
    expect(m.platforms.jd.modes['item.search']?.command).toBe('item search')
    expect(m.platforms.jd.modes['item.search']?.columns).toEqual([
      '平台',
      '作品ID',
      '类型',
      '标题',
      '正文',
      '作者',
      '作者ID',
      '作者主页',
      '发布时间',
      '链接',
      '播放数',
      '点赞数',
      '评论数',
      '收藏数',
      '转发数',
      '图片数',
      '视频数',
    ])
    // 淘宝的 item search 上游没实现（none），所以没有 posts，也没有 item.search。
    expect(m.platforms.taobao.modes.posts).toBeUndefined()
    expect(m.platforms.taobao.modes['item.search']).toBeUndefined()
  })

  it('写命令从不进清单：write() 声明的都带 mutating，清单里没有一条 mutating 命令', () => {
    const source = readFileSync(new URL('../src/core/vocab.ts', import.meta.url), 'utf8')
    const declared = new Set([...source.matchAll(/'([a-z]+ [a-z]+)':\s*write\(/g)].map((m) => m[1]!))
    expect(declared.size).toBeGreaterThan(20)
    const mutating = new Set(Object.keys(VOCAB).filter((key) => VOCAB[key]!.mutating))
    expect([...mutating].sort()).toEqual([...declared].sort())
    for (const cap of Object.values(manifest().platforms)) {
      for (const [mode, cell] of Object.entries(cap.modes)) {
        if (!cell.command) continue
        expect(VOCAB[cell.command]?.mutating, `${mode} -> ${cell.command}`).toBeFalsy()
      }
    }
  })

  it('没有漏标的写命令：写动作结尾的命令必须 mutating 或 confirm', () => {
    // `write()` 自动带 mutating，但平台扩展里手写的写命令（bilibili item edit / comment pin、
    // tiktok folder add……）不会经过它。上游每次加读命令也可能顺手加写命令，这里按命令词收口：
    // 漏一个就会作为「读模式」出现在采析绘面板上，并且真的改平台状态。
    const writes = new Set([
      'add',
      'create',
      'update',
      'delete',
      'remove',
      'publish',
      'edit',
      'send',
      'reply',
      'follow',
      'unfollow',
      'like',
      'unlike',
      'collect',
      'uncollect',
      'coin',
      'triple',
      'pin',
      'unpin',
      'upload',
      'post',
      'save',
    ])
    const missing: string[] = []
    for (const platform of PLATFORMS) {
      for (const endpoint of Object.values(platform.endpoints)) {
        if (!endpoint || typeof endpoint !== 'object' || !(endpoint.commands instanceof Map)) continue
        for (const [key, command] of endpoint.commands) {
          if (!writes.has(key.split(' ').pop() ?? '')) continue
          if (command.mutating || command.confirm) continue
          missing.push(`${platform.id}:${key}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('微博归一化行与 Selenium 同列，接口没给的来源留空', () => {
    const row = mapWeiboItem({
      id: '123',
      url: 'https://weibo.com/1/abc',
      text: '正文 #话题#',
      created_at: '2026-10-01T10:00:00+08:00',
      author: { id: '1', name: '作者', url: 'https://weibo.com/u/1' },
      media: [{ type: 'image', url: 'https://img/1.jpg' }],
      stats: { likes: 3, comments: 4, shares: 5 },
    })
    expect(Object.keys(row)).toEqual(WEIBO_POST_COLUMNS)
    expect(row).toMatchObject({
      发布者: '作者',
      发布时间: '2026-10-01 10:00:00',
      发布来源: '',
      正文: '正文 #话题#',
      转发数: 5,
      评论数: 4,
      点赞数: 3,
      图片链接: 'https://img/1.jpg',
      图片数: 1,
      话题: '话题',
      视频数: 0,
      用户链接: 'https://weibo.com/u/1',
      链接: 'https://weibo.com/1/abc',
      微博ID: '123',
    })
    expect(mapWeiboComment({ id: 'c1', text: '评', author: { name: '甲' }, stats: { likes: 2 } }, 'u', 1)).toMatchObject({
      平台: 'weibo',
      文章URL: 'u',
      评论者: '甲',
      评论内容: '评',
      点赞数: 2,
      楼层: 1,
      评论ID: 'c1',
    })
  })

  it('小红书/抖音/推文的归一化映射各自套自己的列', () => {
    const xhs = mapXhsComment({ id: 'c2', text: '根', author: { name: 'A', url: 'https://xhs/u' }, stats: { likes: 1, replies: 3 } }, 'u', 2, 'root')
    expect(xhs).toMatchObject({ 平台: 'xiaohongshu', 楼层: 2, 父评论ID: 'root', 子回复数: 3, 评论ID: 'c2' })
    const dy = mapDouyinItem({ id: 'v1', text: '正文', author: { name: '作者' }, stats: { likes: 1, comments: 2, collects: 3, shares: 4 } })
    expect(Object.keys(dy)).toEqual(DOUYIN_VIDEO_COLUMNS)
    expect(dy).toMatchObject({ 标题: '正文', 视频ID: 'v1', 点赞数: 1, 评论数: 2, 收藏数: 3, 转发数: 4, 链接: 'https://www.douyin.com/video/v1' })
    const dyComment = mapDouyinComment({ id: 'c3', text: 'r', author: { name: 'B' } }, 'u', 3, 'c1')
    expect(Object.keys(dyComment)).toEqual(DOUYIN_COMMENT_COLUMNS)
    expect(dyComment).toMatchObject({ 楼层: 3, 父楼层: 'c1', 父评论ID: 'c1', 评论地区: '' })
    const tw = mapTwitterItem({ id: 't1', url: 'https://x.com/a/status/t1', text: 'hello #tag', author: { id: '9', name: '甲', url: 'https://x.com/a' }, stats: { likes: 5 } })
    expect(tw).toMatchObject({ 发布者ID: 'a', 用户链接: 'https://x.com/a', 话题: 'tag', 推文ID: 't1', 点赞数: 5, 是否引用: '' })
  })

  it('小红书评论根 + 子回复逐一展开，评论 ID 进账本', async () => {
    const calls: string[][] = []
    const client = fakeClient((args) => {
      calls.push(args)
      if (args.includes('replies')) return ok([{ id: 'r1', text: '回复', author: { name: 'B' }, stats: { likes: 1 } }], args)
      return ok([{ id: 'c1', text: '根', author: { name: 'A' }, stats: { likes: 2, replies: 1 } }], args)
    })
    const result = await runMode('xiaohongshu', 'comments', { urls: ['https://www.xiaohongshu.com/explore/1'], comment_limit: 0 }, client)
    expect(result.status).toBe('ok')
    expect(result.rows.map((row) => row.评论ID)).toEqual(['c1', 'r1'])
    expect(result.rows[1]).toMatchObject({ 父评论ID: 'c1', 楼层: 2 })
    const replyCall = calls.find((args) => args.includes('replies'))!
    expect(replyCall.slice(0, 5)).toEqual(['xhs', 'comment', 'replies', 'https://www.xiaohongshu.com/explore/1', 'c1'])
    expect(replyCall).toContain('--all')
  })

  it('微博 posts 走 item search，第一页就是它的全部，不把短表当错误', async () => {
    const calls: string[][] = []
    const client = fakeClient((args) => {
      calls.push(args)
      return ok([{ id: '1', text: 'a', author: { name: 'x' }, stats: { likes: 1 } }], args)
    })
    const result = await runMode('weibo', 'posts', { keyword: '测试', target_count: 50 }, client)
    expect(result.rows).toHaveLength(1)
    expect(result.status).toBe('ok')
    expect(calls[0]!.slice(0, 4)).toEqual(['weibo', 'item', 'search', '测试'])
    expect(calls[0]).toContain('--limit')
    expect(calls[0]).toContain('50')
  })

  it('CatBus 独有的粉丝列表走 user followers，列是通用用户表', async () => {
    const calls: string[][] = []
    const client = fakeClient((args) => {
      calls.push(args)
      return ok([{ id: 'u1', name: '粉', handle: 'f', stats: { followers: 7 } }], args)
    })
    const result = await runMode('kuaishou', 'user.followers', { author: 'me', target_count: 1 }, client)
    expect(result.rows[0]).toMatchObject({ 平台: 'kuaishou', 用户ID: 'u1', 昵称: '粉', 账号: 'f', 粉丝数: 7 })
    expect(Object.keys(result.rows[0]!)).toEqual(USER_COLUMNS)
    expect(calls[0]!.slice(0, 4)).toEqual(['kuaishou', 'user', 'followers', 'me'])
  })

  it('热搜词输出关键词表，排名按返回顺序，不需要任何输入', async () => {
    const client = fakeClient((args) => ok([{ text: '甲', heat: 100 }, { text: '乙', heat: 90 }], args))
    const result = await runMode('xiaohongshu', 'keyword.hot', {}, client)
    expect(result.rows.map((row) => [row.关键词, row.热度, row.排名])).toEqual([
      ['甲', 100, 1],
      ['乙', 90, 2],
    ])
    expect(Object.keys(result.rows[0]!)).toEqual(KEYWORD_COLUMNS)
  })

  it('相关推荐按每条输入各跑一次，单条失败保留其余并给出 warning', async () => {
    const client = fakeClient((args) => {
      if (args[3] === 'bad') {
        return {
          args,
          code: 7,
          envelope: { ok: false, error: { code: 'UPSTREAM', message: 'boom', hint: null, detail: null } },
          stderr: '',
        }
      }
      return ok([{ id: 'i1', kind: 'video' }], args)
    })
    const result = await runMode('tiktok', 'item.related', { urls: ['good', 'bad'], target_count: 5 }, client)
    expect(result.rows).toHaveLength(1)
    expect(result.status).toBe('partial')
    expect(result.warnings[0]).toContain('bad')
  })

  it('抖音热榜按上游事实拒绝，返回的不是一张空表', async () => {
    await expect(runMode('douyin', 'hot', {}, fakeClient(() => ok([])))).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      message: expect.stringContaining('NOT_IMPLEMENTED'),
    })
  })
})
