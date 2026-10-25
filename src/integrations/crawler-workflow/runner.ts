import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CatbusError, type ErrorCode } from '../../core/errors.js'
import { jsonLoads } from '../../core/py.js'
import { BilibiliAdapter } from './bilibili.js'
import { errorCodeForExit } from './errors.js'
import { CRAWLER_MODES, platformCapability } from './manifest.js'
import type {
  CatbusCall,
  CatbusEnvelope,
  CatbusRunner,
  CrawlerMode,
  RunParams,
  RunResult,
} from './types.js'

export interface CatbusClientOptions {
  /** 显式指定 catbus 可执行文件（或 dist/cli/main.js）。 */
  bin?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
}

interface Command {
  command: string
  prefix: string[]
}

function resolveCommand(options: CatbusClientOptions): Command {
  const configured = options.bin ?? process.env.CATBUS_BIN
  if (configured) {
    return /\.(?:js|mjs|cjs)$/i.test(configured)
      ? { command: process.execPath, prefix: [configured] }
      : { command: configured, prefix: [] }
  }
  // 编译后本文件在 dist/integrations/crawler-workflow/，主入口在 dist/cli/main.js。
  const local = fileURLToPath(new URL('../../cli/main.js', import.meta.url))
  if (existsSync(local)) return { command: process.execPath, prefix: [local] }
  return { command: 'catbus', prefix: [] }
}

/**
 * Windows 上 child.kill() 只结束直接子进程；CatBus 有些平台会再起 node 子进程。
 * 适配器被采析绘停止时，必须把整棵树带走，否则会留下继续抓取的孤儿进程。
 */
function killTree(child: ChildProcess): void {
  if (!child.pid || child.killed) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    return
  }
  child.kill('SIGTERM')
}

/** 通过子进程调用 CatBus，保持与 Python 侧同一条 JSONL / 信封边界。 */
export class CatbusClient implements CatbusRunner {
  private readonly command: Command
  private readonly cwd?: string
  private readonly env?: NodeJS.ProcessEnv
  private readonly active = new Set<ChildProcess>()

  constructor(options: CatbusClientOptions = {}) {
    this.command = resolveCommand(options)
    this.cwd = options.cwd
    this.env = options.env
  }

  /** 结束当前所有 CatBus 子进程；Windows 下连整棵进程树一起结束。 */
  close(): void {
    for (const child of this.active) killTree(child)
    this.active.clear()
  }

  call(args: string[]): Promise<CatbusCall> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command.command, [...this.command.prefix, ...args], {
        cwd: this.cwd,
        env: this.env ?? process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.active.add(child)
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
      child.on('error', (err) => {
        this.active.delete(child)
        reject(new CatbusError('NETWORK', `无法启动 catbus：${err.message}`, { hint: '检查 CATBUS_BIN 或 catbus 是否在 PATH 里' }))
      })
      child.on('close', (code) => {
        this.active.delete(child)
        let envelope: CatbusEnvelope | null = null
        const text = stdout.trim()
        if (text) {
          try {
            const parsed = jsonLoads<unknown>(text)
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) envelope = parsed as CatbusEnvelope
          } catch {
            // 保留 null，由上层报协议错误；stdout 只在 -o json 时应该是一行信封。
          }
        }
        resolve({ args, code: code ?? 1, envelope, stderr })
      })
    })
  }
}

export function isCrawlerMode(value: string): value is CrawlerMode {
  return (CRAWLER_MODES as string[]).includes(value)
}

export interface PreflightResult {
  ok: boolean
  backend: 'catbus'
  endpoint: 'web'
  platform: string
  account: string | null
  logged_in: boolean
  user: unknown
  method: string | null
  expires_at: string | null
  error: ReturnType<CatbusError['toJSON']> | null
}

/**
 * 后端预检：CatBus 的登录态和 Selenium cookie 是两套东西，节点开跑前必须单独问一次。
 * 返回 logged_in=false 而不是抛异常，让调用方能把「未登录」和「命令坏了」分开显示。
 */
export async function preflight(
  platform: string,
  client: CatbusRunner,
  account?: string,
): Promise<PreflightResult> {
  const cap = platformCapability(platform)
  if (!cap) {
    throw new CatbusError('UNSUPPORTED', `CatBus 适配器不认识平台 ${platform}`, {
      hint: '支持：bilibili、weibo、xiaohongshu、douyin、twitter',
    })
  }
  const accountName = typeof account === 'string' ? account.trim() : ''
  const suffix = ['-o', 'json', '-q']
  if (accountName) suffix.push('-a', accountName)
  const call = await client.call([cap.catbus_platform, 'auth', 'status', ...suffix])
  if (call.code !== 0 || !call.envelope?.ok) {
    const e = call.envelope?.error
    throw e
      ? new CatbusError(e.code as ErrorCode, e.message, { hint: e.hint, detail: e.detail })
      : new CatbusError(
          errorCodeForExit(call.code),
          `catbus 退出码 ${call.code}${call.stderr ? `：${call.stderr.trim()}` : ''}`,
        )
  }
  const data = (call.envelope.data ?? {}) as Record<string, unknown>
  const loggedIn = data.logged_in === true
  const envelopeAccount = typeof call.envelope.account === 'string' ? call.envelope.account.trim() : ''
  return {
    ok: loggedIn,
    backend: 'catbus',
    endpoint: 'web',
    platform: cap.catbus_platform,
    account: envelopeAccount || accountName || null,
    logged_in: loggedIn,
    user: data.user ?? null,
    method: typeof data.method === 'string' ? data.method : null,
    expires_at: typeof data.expires_at === 'string' ? data.expires_at : null,
    error: loggedIn
      ? null
      : {
          code: 'AUTH_REQUIRED' as const,
          message: `CatBus 未登录 ${cap.label} (web)`,
          hint: `catbus ${cap.catbus_platform} auth login${accountName ? ` -a ${accountName}` : ''}`,
          detail: null,
        },
  }
}

export async function runMode(
  platform: string,
  mode: string,
  params: RunParams,
  client: CatbusRunner,
): Promise<RunResult> {
  const cap = platformCapability(platform)
  if (!cap) {
    throw new CatbusError('UNSUPPORTED', `CatBus 适配器不认识平台 ${platform}`, {
      hint: '支持：bilibili、weibo、xiaohongshu、douyin、twitter（别名见 capabilities）',
    })
  }
  if (!isCrawlerMode(mode)) {
    throw new CatbusError('USAGE', `不认识的采集模式 ${mode}`, { hint: 'posts / author / hot / comments' })
  }
  const modeCap = cap.modes[mode]
  if (modeCap.status !== 'available' && modeCap.status !== 'partial') {
    throw new CatbusError('UNSUPPORTED', modeCap.reason ?? `${cap.label} 的 ${mode} 尚未适配 CatBus`, {
      hint: '用 capabilities 查看哪些 平台 × 模式 已经可用',
    })
  }
  if (cap.catbus_platform !== 'bilibili') {
    throw new CatbusError('UNSUPPORTED', modeCap.reason ?? `${cap.label} 的 ${mode} 尚未实现`, {
      hint: '目前只完成 bilibili（B站）的适配',
    })
  }
  const account = typeof params.catbus_account === 'string' && params.catbus_account.trim()
    ? params.catbus_account.trim()
    : undefined
  return new BilibiliAdapter(client, account).run(mode, params)
}
