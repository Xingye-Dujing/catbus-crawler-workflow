#!/usr/bin/env node
import { once } from 'node:events'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { text as readStdin } from 'node:stream/consumers'
import { CatbusError, toCatbusError } from '../../core/errors.js'
import { jsonLoads } from '../../core/py.js'
import { platformCapability } from './manifest.js'
import { CatbusClient, preflight, runMode } from './runner.js'
import type { Row, RowSink, RunParams, RunResult } from './types.js'

const HELP = `catbus-crawler-workflow — 采析绘的 CatBus 后端适配器

用法:
  catbus-crawler-workflow capabilities
  catbus-crawler-workflow preflight --platform <平台> [--account <name>]
  catbus-crawler-workflow run --platform <平台> --mode <模式> --params <json|@file|->
  catbus-crawler-workflow run --platform bilibili --mode comments --url <链接> [--url <链接>...]
  catbus-crawler-workflow run --platform bilibili --mode posts --keyword <关键词>
  catbus-crawler-workflow run --platform bilibili --mode author --author <UID或链接>
  catbus-crawler-workflow run --platform bilibili --mode hot [--board popular]

说明:
  run 的 stdout 每行一条采析绘表格行（-o json 时是一个数组）；stderr 最后一行是运行摘要。
  默认 jsonl：产出一条就写一条，中途被停止或后面失败都不撤回已经写出的行，摘要里的 rows 是实际写出的条数。
  capabilities 输出 平台 × 模式 的 CatBus 支持矩阵，未支持的组合带原因。
  preflight 的 stdout 是单个 JSON，单独检查 CatBus 登录态；未登录时退出码 3，不碰 Selenium cookie。
  CatBus 使用自己的账号：catbus bilibili auth login；和 Selenium cookie 不共用。

模式:
  posts     关键词搜索（B站已适配）
  author    作者投稿（B站已适配）
  hot       热门榜（B站 popular 已适配，ranking 未适配）
  comments  文章评论（B站已适配）

选项:
  --platform <id>        bilibili / weibo / xiaohongshu / douyin / twitter（也接受 CatBus 别名）
  --mode <mode>          posts / author / hot / comments
  --params <json|@file|-> 采析绘节点参数；和下面的快捷选项可混用
  --url <链接>            comments 模式可重复
  --keyword <词>          posts 模式
  --author <用户>         author 模式
  --target-count <N>     posts / author / hot 目标条数，默认 50
  --comment-limit <N>    comments 每篇目标条数，0 表示全部
  --board <popular>      hot 榜；目前只支持 popular
  -a, --account <name>   CatBus 账号名，覆盖 params.catbus_account；和采析绘账号无关
  --catbus-bin <path>    catbus 可执行文件或 dist/cli/main.js
  -o, --output json|jsonl  默认 jsonl
  --provenance           追加一列 采集方式=catbus
  -h, --help             显示本帮助
`

interface CliOptions {
  platform?: string
  mode?: string
  params?: string
  url?: string[]
  keyword?: string
  author?: string
  targetCount?: string
  commentLimit?: string
  board?: string
  account?: string
  catbusBin?: string
  output?: string
  provenance?: boolean
  help?: boolean
}

function parseCli(argv: string[]): { command: string; options: CliOptions; positionals: string[] } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      platform: { type: 'string' },
      mode: { type: 'string' },
      params: { type: 'string' },
      url: { type: 'string', multiple: true },
      keyword: { type: 'string' },
      author: { type: 'string' },
      'target-count': { type: 'string' },
      'comment-limit': { type: 'string' },
      board: { type: 'string' },
      account: { type: 'string', short: 'a' },
      'catbus-bin': { type: 'string' },
      output: { type: 'string', short: 'o' },
      provenance: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  return {
    command: positionals[0] ?? '',
    positionals: positionals.slice(1),
    options: {
      platform: values.platform,
      mode: values.mode,
      params: values.params,
      url: values.url,
      keyword: values.keyword,
      author: values.author,
      targetCount: values['target-count'],
      commentLimit: values['comment-limit'],
      board: values.board,
      account: values.account,
      catbusBin: values['catbus-bin'],
      output: values.output,
      provenance: values.provenance,
      help: values.help,
    },
  }
}

async function readParams(raw: string | undefined): Promise<RunParams> {
  if (!raw) return {}
  let text = raw
  if (raw.startsWith('@')) {
    const file = resolve(raw.slice(1))
    try {
      text = await readFile(file, 'utf8')
    } catch (err) {
      throw new CatbusError('USAGE', `读不到 --params 文件 ${file}：${err instanceof Error ? err.message : String(err)}`)
    }
  } else if (raw === '-') {
    text = await readStdin(process.stdin)
  }
  let parsed: unknown
  try {
    parsed = jsonLoads<unknown>(text)
  } catch (err) {
    throw new CatbusError('USAGE', `--params 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`, {
      hint: '传 JSON 对象，例如 {"urls":["https://www.bilibili.com/video/BV..."]}',
    })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CatbusError('USAGE', '--params 必须是 JSON 对象')
  }
  return parsed as RunParams
}

function mergeOptions(params: RunParams, options: CliOptions): RunParams {
  const out: RunParams = { ...params }
  if (options.url?.length) out.urls = options.url
  if (options.keyword != null) out.keyword = options.keyword
  if (options.author != null) out.author = options.author
  if (options.targetCount != null) out.target_count = options.targetCount
  if (options.commentLimit != null) out.comment_limit = options.commentLimit
  if (options.board != null) out.board = options.board
  if (options.account != null) out.catbus_account = options.account
  return out
}

function withProvenance(row: Row): Row {
  return { ...row, 采集方式: 'catbus' }
}

/** 管道满了就等它腾空：调用方按行读 stdout，把背压换成内存增长不是解决它。 */
async function defaultWrite(line: string): Promise<void> {
  if (!process.stdout.write(line)) await once(process.stdout, 'drain')
}

export interface RowWriter {
  /** 交给 runMode 的逐行回调。 */
  onRow: RowSink
  /** 已经交出去的行数。失败时摘要按它报，不能再说 0。 */
  readonly written: number
  /** 收尾：json 格式在这里把缓冲的行作为数组写出。 */
  finish: () => Promise<void>
}

/**
 * `jsonl` 产出一行写一行——采析绘把每行写成一个事务，所以中途停止保住已经落地的每一条；
 * `json` 的格式本身是一个数组，只能缓冲到结束再整体写出。
 */
export function createRowWriter(options: {
  output: 'json' | 'jsonl'
  provenance: boolean
  write?: (line: string) => void | Promise<void>
}): RowWriter {
  const write = options.write ?? defaultWrite
  const rows: Row[] = []
  let written = 0
  return {
    onRow: async (row) => {
      const line = options.provenance ? withProvenance(row) : row
      rows.push(line)
      written += 1
      if (options.output === 'jsonl') await write(`${JSON.stringify(line)}\n`)
    },
    get written() {
      return written
    },
    finish: async () => {
      if (options.output === 'json') await write(`${JSON.stringify(rows, null, 2)}\n`)
    },
  }
}

function columnsFor(platform: string, mode: string, provenance: boolean): string[] {
  const cap = platformCapability(platform)
  if (!cap) return provenance ? ['采集方式'] : []
  const modeCap = cap.modes[mode as keyof typeof cap.modes]
  const columns = modeCap?.columns ?? []
  return provenance ? [...columns, '采集方式'] : columns
}

function catbusAccount(params: RunParams): string | null {
  const value = params.catbus_account
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function summary(
  result: RunResult,
  meta: { platform: string; mode: string; params: RunParams; provenance: boolean },
) {
  const cap = platformCapability(meta.platform)
  return {
    ok: result.status === 'ok' || result.status === 'partial',
    backend: 'catbus',
    endpoint: 'web',
    platform: cap?.catbus_platform ?? meta.platform,
    platform_input: meta.platform,
    mode: meta.mode,
    status: result.status,
    rows: result.rows.length,
    columns: columnsFor(meta.platform, meta.mode, meta.provenance),
    account: catbusAccount(meta.params),
    warnings: result.warnings,
    articles: result.articles,
    error: null,
  }
}

function errorSummary(
  err: CatbusError,
  meta: { platform: string; mode: string; params: RunParams; provenance: boolean },
  rows = 0,
) {
  const cap = platformCapability(meta.platform)
  return {
    ok: false,
    backend: 'catbus',
    endpoint: 'web',
    platform: cap?.catbus_platform ?? meta.platform,
    platform_input: meta.platform,
    mode: meta.mode,
    status: 'error',
    rows,
    columns: columnsFor(meta.platform, meta.mode, meta.provenance),
    account: catbusAccount(meta.params),
    warnings: [],
    articles: [],
    error: err.toJSON(),
  }
}

function exitForResult(result: RunResult): number {
  if (result.status === 'ok' || result.status === 'partial') return 0
  const codes = result.articles.map((a) => a.error?.code).filter((x): x is NonNullable<typeof x> => Boolean(x))
  if (codes.includes('USAGE') || codes.includes('UNSUPPORTED') || codes.includes('CONFIRM_REQUIRED')) return 2
  if (codes.includes('NOT_IMPLEMENTED')) return 4
  if (result.status === 'blocked') {
    if (codes.includes('RISK_CONTROL')) return 5
    return 3
  }
  if (result.status === 'dead') return 7
  if (codes.includes('RISK_CONTROL')) return 5
  if (codes.includes('NETWORK')) return 6
  if (codes.includes('ERROR')) return 1
  return 7
}

function preflightError(err: CatbusError, platform: string, account?: string) {
  const cap = platformCapability(platform)
  return {
    ok: false,
    backend: 'catbus',
    endpoint: 'web',
    platform: cap?.catbus_platform ?? platform,
    account: account?.trim() || null,
    logged_in: false,
    user: null,
    method: null,
    expires_at: null,
    error: err.toJSON(),
  }
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function printSummary(value: unknown): void {
  process.stderr.write(`${JSON.stringify(value)}\n`)
}

async function runCommand(
  platform: string,
  mode: string,
  params: RunParams,
  options: CliOptions,
): Promise<number> {
  const output = options.output ?? 'jsonl'
  if (output !== 'json' && output !== 'jsonl') {
    throw new CatbusError('USAGE', `--output 只能是 json 或 jsonl，收到 ${output}`)
  }
  const provenance = Boolean(options.provenance)
  const meta = { platform, mode, params, provenance }
  const client = new CatbusClient({ bin: options.catbusBin })
  const writer = createRowWriter({ output, provenance })
  const onSignal = () => {
    client.close()
    process.exit(130)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    const result = await runMode(platform, mode, params, client, writer.onRow)
    await writer.finish()
    printSummary(summary(result, meta))
    return exitForResult(result)
  } catch (err) {
    // 已经写出去的行不撤回：采析绘一行一个事务存下了它们，摘要就说实际写出的行数。
    const e = toCatbusError(err)
    printSummary(errorSummary(e, meta, writer.written))
    return e.exitCode
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    client.close()
  }
}

async function preflightCommand(platform: string, options: CliOptions): Promise<number> {
  const client = new CatbusClient({ bin: options.catbusBin })
  try {
    const result = await preflight(platform, client, options.account)
    printJson(result)
    return result.logged_in ? 0 : 3
  } finally {
    client.close()
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed: ReturnType<typeof parseCli>
  try {
    parsed = parseCli(argv)
  } catch (err) {
    const e = new CatbusError('USAGE', err instanceof Error ? err.message : String(err), { hint: '见 --help' })
    printSummary(errorSummary(e, { platform: '', mode: '', params: {}, provenance: false }))
    return e.exitCode
  }

  const { command, options } = parsed
  if (options.help || !command || command === 'help') {
    process.stdout.write(HELP)
    return 0
  }
  if (command === 'capabilities') {
    const { manifest } = await import('./manifest.js')
    printJson(manifest())
    return 0
  }
  if (command === 'preflight') {
    const platform = options.platform?.trim() ?? ''
    try {
      if (!platform) throw new CatbusError('USAGE', 'preflight 需要 --platform')
      return await preflightCommand(platform, options)
    } catch (err) {
      const e = toCatbusError(err)
      printJson(preflightError(e, platform, options.account))
      return e.exitCode
    }
  }
  if (command !== 'run') {
    const e = new CatbusError('USAGE', `不认识的命令 ${command}`, { hint: 'capabilities / preflight / run' })
    printSummary(errorSummary(e, { platform: '', mode: '', params: {}, provenance: false }))
    return e.exitCode
  }

  const platform = options.platform?.trim() ?? ''
  const mode = options.mode?.trim() ?? ''
  const meta = { platform, mode, params: {} as RunParams, provenance: Boolean(options.provenance) }
  try {
    if (!platform) throw new CatbusError('USAGE', 'run 需要 --platform')
    if (!mode) throw new CatbusError('USAGE', 'run 需要 --mode')
    const params = mergeOptions(await readParams(options.params), options)
    meta.params = params
    return await runCommand(platform, mode, params, options)
  } catch (err) {
    const e = toCatbusError(err)
    printSummary(errorSummary(e, { ...meta, params: meta.params }))
    return e.exitCode
  }
}

function invokedAsScript(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedAsScript()) {
  main().then((code) => {
    process.exitCode = code
  })
}
