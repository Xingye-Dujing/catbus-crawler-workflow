import type { CatbusError } from '../../core/errors.js'

/**
 * 采析绘的四种共享采集模式：posts / author / hot / comments。
 *
 * 清单里还会出现 CatBus 独有的只读模式（``user.followers`` 等），所以模式键是字符串；
 * 这四种只是「和 Selenium 版同名、同一个执行入口」的那一小批。
 */
export type CrawlerMode = string

/** 与 Selenium 版同名、走同一套处理器的模式。 */
export const SHARED_MODES = ['posts', 'author', 'hot', 'comments'] as const

/** 与 CatBus 有交集的采析绘平台 id；CatBus 的规范 id 由 platformCapability 映射过去。 */
export type CrawlerPlatform = string

export type ModeStatus = 'available' | 'partial' | 'planned' | 'unavailable'

export type RunStatus = 'ok' | 'partial' | 'blocked' | 'dead' | 'error'

/** 一行采析绘表格。键的顺序就是 CSV 列的顺序。 */
export type Row = Record<string, string | number | boolean | null>

/**
 * 逐行回调：一行产出来就交出去，不等到进程结束。
 *
 * 采析绘把每行写进它自己的账本（一行一个事务），所以「批次结束才给数据」意味着
 * 中途 停止 会丢掉已经抓到的每一条。回调允许是异步的，写管道时用它压住背压。
 */
export type RowSink = (row: Row) => void | Promise<void>

export interface CatbusEnvelope {
  ok: boolean
  platform?: string | null
  endpoint?: string | null
  resource?: string | null
  action?: string | null
  account?: string | null
  data?: unknown
  page?: unknown
  error?: ReturnType<CatbusError['toJSON']> | null
}

export interface CatbusCall {
  args: string[]
  code: number
  envelope: CatbusEnvelope | null
  stderr: string
}

/** 只暴露调用一个 CatBus 命令的接口，测试里换成假实现即可。 */
export interface CatbusRunner {
  call(args: string[]): Promise<CatbusCall>
}

export interface ArticleResult {
  url: string
  status: RunStatus
  rows: number
  error: ReturnType<CatbusError['toJSON']> | null
}

export interface RunResult {
  rows: Row[]
  status: RunStatus
  warnings: string[]
  articles: ArticleResult[]
}

export interface ModeCapability {
  status: ModeStatus
  /** 已经实现的处理器名称；CatBus 独有模式为空。 */
  handler?: 'posts' | 'author' | 'hot' | 'comments'
  /** CatBus 命令路径（``user followers``）；共享模式也写，便于 UI 与文档展示。 */
  command?: string
  /** 命令的位置参数，按参数名列出；适配器按它把采析绘字段拼成 argv。 */
  args?: string[]
  /** 可省略的位置参数与省略时的取值（命令声明里的 ArgSpec.default）。 */
  optional?: Record<string, string>
  /** 命令是否分页（分页命令接受 --limit <target_count>）。 */
  paged?: boolean
  /** 输出的归一化类型（Item / User / Comment / Keyword / Topic / Live / …）。 */
  output?: string
  /** CatBus 命令，按 argv 拆开，便于以后在 UI 里展示。 */
  catbus: string[]
  /** 采析绘节点里可直接透传的字段。 */
  params: string[]
  /** 输出列，顺序与 CSV 表头一致。 */
  columns: string[]
  /** 去重账本使用的身份列；切换后端时采析绘要把它和 backend 一起写进指纹。 */
  identity?: string[]
  /** 需要登录的端：CatBus 使用自己的账号文件，和 Selenium cookie 不共用。 */
  auth: 'required' | 'optional'
  note?: string
  /** status 不是 available 时，必须说明原因；UI 直接展示这句话。 */
  reason?: string
}

export interface PlatformCapability {
  /** CatBus 的规范平台 id。 */
  catbus_platform: string
  /** 采析绘里该平台的展示名，仅用于文档与日志。 */
  label: string
  modes: Record<CrawlerMode, ModeCapability>
}

export interface BackendManifest {
  schema: 1
  backend: 'catbus'
  label: 'CatBus'
  endpoint: 'web'
  /** 与 CatBus 有交集的采析绘平台 id -> 能力；没有交集的平台不出现在这里。 */
  platforms: Record<string, PlatformCapability>
  requirements: {
    node: string
    catbus: string
    auth: string
  }
  deployment: {
    /** 服务器 / Docker 可以先装固定版本。 */
    server: boolean
    /** Windows 桌面安装包默认不打包 CatBus。 */
    desktop: boolean
  }
}

export interface RunParams {
  /** comments 模式的文章链接；字符串里可以换行分隔。 */
  urls?: string | string[]
  /** posts 模式的关键词。 */
  keyword?: string
  /** author 模式的用户（UID、空间链接或 me）。 */
  author?: string
  /** posts / author / hot 目标条数，默认 50。 */
  target_count?: number | string
  /** comments 每篇文章的目标条数，0 表示全部。 */
  comment_limit?: number | string
  /** hot 榜单固定为 popular；ranking 暂未适配。 */
  board?: string
  /** CatBus 独有模式的输入：用户 / 直播间 / 收藏夹 / 合集 / 会话 / 搜索前缀 / 商品 / 评论。 */
  user?: string
  room?: string
  folder?: string
  series?: string
  conversation?: string
  prefix?: string
  product?: string
  comment_id?: string
  /** 采析绘的账号名（Selenium 侧）；适配器不消费，绝不拿它去匹配 CatBus 账号。 */
  account?: string
  /** CatBus 自己的账号名；不传时用 CatBus 的当前账号。 */
  catbus_account?: string
  /** 采析绘还可能传 recrawl / format / part_size 等执行层字段，适配器不消费。 */
  [key: string]: unknown
}
