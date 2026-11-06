import { CatbusError, type ErrorCode } from '../../core/errors.js'
import { errorCodeForExit } from './errors.js'
import type { ArticleResult, CatbusCall, Row, RunParams, RunStatus } from './types.js'

/** 适配器各平台共用的取值、时间、参数与状态收敛工具。 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

export function asList(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new CatbusError('UPSTREAM', `${what} 返回的不是数组`, { detail: value })
  }
  return value
}

export function asString(value: unknown): string {
  return value == null ? '' : String(value).trim()
}

/** 评论表沿用 Python 的 str(value or '')，不做 trim；正文里的换行和缩进要保留。 */
export function textOrEmpty(value: unknown): string {
  return value ? String(value) : ''
}

/** Python 里 0 是假值；评论的 root / parent 为 0 时要落成空串，不能写成 "0"。 */
export function idOrEmpty(value: unknown): string {
  const text = asString(value)
  return text === '0' ? '' : text
}

/** 缺失就是空，不能把「接口没给」写成 0；真实 0 仍然写 0。 */
export function countOrBlank(value: unknown): number | '' {
  if (value == null || value === '') return ''
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : ''
}

/** 采析绘原来的 _as_int 把缺失写成 0；评论等级、回复数沿用这个语义。 */
export function intOrZero(value: unknown): number {
  if (value == null || value === '') return 0
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

const CST_OFFSET_MS = 8 * 60 * 60 * 1000

/** 平台时间统一按北京时间渲染，和采析绘的 _stamp / comments_base._stamp 一致。 */
export function formatCst(value: unknown): string {
  if (value == null || value === '') return ''
  const n = Number(value)
  if (!Number.isFinite(n)) return ''
  const seconds = Math.trunc(n)
  if (seconds <= 0) return ''
  const d = new Date(seconds * 1000 + CST_OFFSET_MS)
  if (!Number.isFinite(d.getTime())) return ''
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * CatBus 归一化时间（带时区的 ISO）→ 采析绘的北京时间 `YYYY-MM-DD HH:MM:SS`。
 *
 * 归一化层已经按北京时间解析过；这里只做展示形状的转换，绝不按运行机器的时区解释。
 */
export function localStamp(value: unknown): string {
  const text = asString(value)
  if (!text) return ''
  const d = new Date(text)
  if (!Number.isFinite(d.getTime())) return ''
  return formatCst(Math.floor(d.getTime() / 1000))
}

export function callError(call: CatbusCall): CatbusError {
  const e = call.envelope?.error
  if (e) {
    return new CatbusError(e.code as ErrorCode, e.message, {
      hint: e.hint,
      detail: e.detail,
    })
  }
  if (call.code !== 0) {
    return new CatbusError(
      errorCodeForExit(call.code),
      `catbus 退出码 ${call.code}${call.stderr ? `：${call.stderr.trim()}` : ''}`,
    )
  }
  return new CatbusError('UPSTREAM', 'catbus 没有返回 JSON 信封')
}

export function classifyThrown(err: unknown): CatbusError {
  return err instanceof CatbusError ? err : new CatbusError('ERROR', err instanceof Error ? err.message : String(err))
}

export function parseUrls(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value]
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of list) {
    for (const line of String(part ?? '').split(/\r?\n/)) {
      const url = line.trim()
      if (!url || seen.has(url)) continue
      seen.add(url)
      out.push(url)
    }
  }
  return out
}

export function parseTarget(value: unknown, key = 'target_count'): number {
  if (value == null || value === '') return 50
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new CatbusError('USAGE', `${key} 必须是正整数`, { hint: `例如 --params '{"${key}":50}'` })
  }
  return n
}

export function parseCommentLimit(value: unknown): number {
  if (value == null || value === '') return 0
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new CatbusError('USAGE', 'comment_limit 必须是非负整数', { hint: '0 表示取完全部评论' })
  }
  return n
}

export function aggregateStatus(articles: ArticleResult[]): RunStatus {
  if (articles.length === 0) return 'error'
  const statuses = articles.map((a) => a.status)
  if (statuses.every((s) => s === 'ok')) return 'ok'
  if (statuses.some((s) => s === 'ok')) return 'partial'
  if (statuses.every((s) => s === 'blocked')) return 'blocked'
  if (statuses.every((s) => s === 'dead')) return 'dead'
  if (statuses.includes('blocked')) return 'blocked'
  if (statuses.includes('dead')) return 'dead'
  return 'error'
}

/** CatBus 的错误码和采析绘的 OK / BLOCKED / DEAD 不是一一对应，这里显式收敛。 */
export function commentStatusOf(err: CatbusError): RunStatus {
  if (err.code === 'AUTH_REQUIRED' || err.code === 'AUTH_EXPIRED' || err.code === 'RISK_CONTROL') return 'blocked'
  if (err.code === 'NETWORK') return 'error'
  if (err.code === 'UPSTREAM') {
    const detail = err.detail as { code?: unknown; message?: unknown } | null
    const code = asString(detail?.code)
    const message = `${err.message} ${asString(detail?.message)}`
    if (code === '-404' || /404|啥都木有|not\s*found/i.test(message)) return 'dead'
    return 'blocked'
  }
  return 'error'
}

/** 一条命令拿到的 `envelope.data`：数组原样，单对象包成一项，空回答为空数组。 */
export function rowsOf(value: unknown): unknown[] {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

/** 这几种错误会让整批停下来：再请求只会加重风控或重复登录墙。 */
export function isStopError(err: CatbusError): boolean {
  return err.code === 'AUTH_REQUIRED' || err.code === 'AUTH_EXPIRED' || err.code === 'RISK_CONTROL'
}

/** 从正文里取话题标签（`#话题#` 与 `#话题`）：没有独立话题字段的平台的唯一诚实来源。 */
export function topicsOf(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/(?:^|\s)[#＃]([^\s#]{1,64})/g)) {
    const topic = m[1]?.trim()
    if (topic && !out.includes(topic)) out.push(topic)
  }
  return out
}

/** 通用处理器按模式键读参数；`user` 模式接受采析绘的 `author` 字段。 */
export function paramOf(params: RunParams, key: string): string {
  const value = params[key]
  return typeof value === 'string' ? value.trim() : ''
}
