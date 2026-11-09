#!/usr/bin/env node
/**
 * 打「便携包」：dist + 生产依赖 + 验证码模型 + 启动脚本，解压即可用，不依赖本仓库。
 *
 * 和 Dockerfile 走同一条路径：先 npm pack 三个包，再把它们装进一个干净目录，
 * 避免把开发依赖或 workspace 软链接带进发行包。
 *
 * 用法：
 *   npm run build
 *   npm run assets:jd && npm run assets:ocr
 *   node scripts/package-portable.mjs [--platform darwin-arm64] [--out build/portable]
 *
 * 输出：<out>/<platform>/catbus-crawler-workflow/
 * 压缩与分卷由 CI 负责（Gitee 单附件 100 MB）。
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Windows 上直接 spawn npm.cmd 会 EINVAL（Node 的安全限制）；优先用 npm-cli.js。
function npmCommand() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const candidate of candidates) {
    if (candidate && candidate.endsWith('.js') && existsSync(candidate)) {
      return { command: process.execPath, prefix: [candidate] }
    }
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [] }
}
const NPM = npmCommand()

const argv = process.argv.slice(2)
const value = (flag, fallback = '') => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const platform = value('--platform', `${process.platform}-${process.arch}`)
const outRoot = resolve(ROOT, value('--out', 'build/portable'))
const stage = join(outRoot, platform, 'catbus-crawler-workflow')
const tarballs = join(outRoot, platform, 'tarballs')

function run(command, args, options = {}) {
  const full = command === 'npm' ? [NPM.command, [...NPM.prefix, ...args]] : [command, args]
  return execFileSync(full[0], full[1], { cwd: ROOT, stdio: 'inherit', ...options })
}

function requirePath(rel, hint) {
  if (!existsSync(join(ROOT, rel))) throw new Error(`缺少 ${rel}。${hint}`)
}

function totalSize(dir) {
  let bytes = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    bytes += entry.isDirectory() ? totalSize(path) : statSync(path).size
  }
  return bytes
}

requirePath('dist/cli/main.js', '先跑 npm run build')
requirePath('packages/assets-jd/models', '先跑 npm run assets:jd')
requirePath('packages/assets-ocr/models', '先跑 npm run assets:ocr')

rmSync(join(outRoot, platform), { recursive: true, force: true })
mkdirSync(tarballs, { recursive: true })

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
console.log(`[portable] 打包 catbus ${version}（${platform}）`)

console.log('[portable] npm pack 三个包')
run('npm', ['pack', '--silent', '--pack-destination', tarballs])
run('npm', ['pack', '--silent', '-w', 'packages/assets-jd', '--pack-destination', tarballs])
run('npm', ['pack', '--silent', '-w', 'packages/assets-ocr', '--pack-destination', tarballs])

const packs = readdirSync(tarballs)
  .filter((name) => name.endsWith('.tgz'))
  .map((name) => join(tarballs, name))
if (packs.length < 3) throw new Error(`npm pack 只得到 ${packs.length} 个 tarball：${packs.join(', ')}`)

console.log('[portable] 安装生产依赖到干净目录')
mkdirSync(stage, { recursive: true })
writeFileSync(
  join(stage, 'package.json'),
  `${JSON.stringify(
    {
      name: 'catbus-crawler-workflow',
      version,
      private: true,
      type: 'module',
      description: 'catbus 采析绘适配版便携包（解压即用，需要 Node）',
    },
    null,
    2,
  )}\n`,
)
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts', '--no-save', ...packs], {
  cwd: stage,
})

const installed = join(stage, 'node_modules', 'catbus-cli')
if (!existsSync(installed)) throw new Error('安装后找不到 node_modules/catbus-cli')

console.log('[portable] 复制 dist / static / 资源 / 许可证')
cpSync(join(installed, 'dist'), join(stage, 'dist'), { recursive: true })
if (existsSync(join(installed, 'static'))) cpSync(join(installed, 'static'), join(stage, 'static'), { recursive: true })
if (existsSync(join(installed, 'assets'))) cpSync(join(installed, 'assets'), join(stage, 'assets'), { recursive: true })
cpSync(join(ROOT, 'LICENSE'), join(stage, 'LICENSE'))
if (existsSync(join(ROOT, 'README.md'))) cpSync(join(ROOT, 'README.md'), join(stage, 'README.md'))

// 启动脚本：Windows 用 .cmd，macOS / Linux 用 sh；都从包根目录解析 dist。
mkdirSync(join(stage, 'bin'), { recursive: true })
const shLauncher = (entry) => `#!/bin/sh
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$DIR/${entry}" "$@"
`
const cmdLauncher = (entry) => `@echo off\r\nnode "%~dp0\\..\\${entry.replaceAll('/', '\\')}" %*\r\n`

for (const [name, entry] of [
  ['catbus', 'dist/cli/main.js'],
  ['catbus-crawler-workflow', 'dist/integrations/crawler-workflow/cli.js'],
]) {
  const sh = join(stage, 'bin', name)
  writeFileSync(sh, shLauncher(entry))
  chmodSync(sh, 0o755)
  writeFileSync(join(stage, 'bin', `${name}.cmd`), cmdLauncher(entry))
}

writeFileSync(
  join(stage, 'README-PORTABLE.md'),
  `# catbus 采析绘适配版（${platform} 便携包）

版本：${version}

- 解压后即可使用，但需要本机有 Node（\`^22.22.2 || ^24.15.0 || >=26.0.0\`）。
- 采析绘适配器入口：\`bin/catbus-crawler-workflow\`（或 \`node dist/integrations/crawler-workflow/cli.js\`）。
- 命令行入口：\`bin/catbus\`（或 \`node dist/cli/main.js\`）。
- 登录态默认在 \`~/.catbus\`；可用 \`CATBUS_HOME\` 指向别处。
- macOS 从网络下载后如被 Gatekeeper 拦截，可执行一次：
  \`xattr -dr com.apple.quarantine <解压目录>\`
- 适配器只暴露只读能力；写命令不在清单里。
- 许可证见 \`LICENSE\`（MIT）。
`,
)

const size = totalSize(stage)
console.log(`[portable] 完成：${stage}`)
console.log(`[portable] 未压缩大小：${(size / 1024 / 1024).toFixed(1)} MB`)
