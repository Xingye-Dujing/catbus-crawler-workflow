#!/usr/bin/env node
/**
 * 把发行文件传到 Gitee Release（国内镜像）。
 *
 * Gitee 单附件 100 MB，所以调用方应先把大文件分卷。脚本会：
 *   1. 按 tag 找 Release，没有就创建；
 *   2. 如果给了 --notes，把说明追加到 Release 正文（带 marker，重复运行不会重复追加）；
 *   3. 跳过 Gitee 上已存在的同名附件，上传其余文件。
 *
 * 用法：
 *   GITEE_ACCESS_TOKEN=... node scripts/gitee-release.mjs \
 *     --tag crawler-workflow-v0.3.0 --version 0.3.0 \
 *     --dir gitee-assets --notes notes.md
 *
 * 环境变量：
 *   GITEE_ACCESS_TOKEN   Gitee 私人令牌（需要 projects 读写权限）
 *   GITEE_OWNER          默认 Xingye-Dujing
 *   GITEE_REPO           默认 catbus-crawler-workflow
 */
import { openAsBlob } from 'node:fs'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const API = 'https://gitee.com/api/v5'
const token = process.env.GITEE_ACCESS_TOKEN || ''
const owner = process.env.GITEE_OWNER || 'Xingye-Dujing'
const repo = process.env.GITEE_REPO || 'catbus-crawler-workflow'

const argv = process.argv.slice(2)
const value = (flag, fallback = '') => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const tag = value('--tag')
const version = value('--version')
const dir = resolve(value('--dir', 'gitee-assets'))
const notesFile = value('--notes')
const marker = value('--marker', '<!-- catbus-macos -->')

if (!token) {
  console.error('缺少 GITEE_ACCESS_TOKEN。请在仓库 Settings → Secrets 里配置 Gitee 私人令牌（需要 projects 读写权限）。')
  process.exit(2)
}
if (!tag) {
  console.error('缺少 --tag（Gitee Release 的 tag，例如 crawler-workflow-v0.3.0）')
  process.exit(2)
}

const auth = `access_token=${encodeURIComponent(token)}`
const jsonHeaders = { Authorization: `token ${token}`, 'Content-Type': 'application/json' }

async function api(path, init = {}) {
  const url = `${API}${path}${path.includes('?') ? '&' : '?'}${auth}`
  const res = await fetch(url, init)
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { res, body, text }
}

function fail(action, result) {
  const detail = typeof result.text === 'string' ? result.text.slice(0, 2000) : JSON.stringify(result.body)
  throw new Error(`${action} 失败：HTTP ${result.res.status}\n${detail}`)
}

const notes = notesFile ? readFileSync(notesFile, 'utf8').trim() : ''
const releaseBody = [notes].filter(Boolean).join('\n\n')

let release = null
const found = await api(`/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`)
if (found.res.ok && found.body?.id) {
  release = found.body
  console.log(`[gitee] 找到 Release ${tag}（id ${release.id}）`)
} else if (found.res.status === 404) {
  console.log(`[gitee] Release ${tag} 不存在，创建`)
  const created = await api(`/repos/${owner}/${repo}/releases`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      tag_name: tag,
      name: `CatBus 采析绘适配版（${version || tag}）`,
      body: releaseBody,
      target_commitish: 'master',
      prerelease: false,
    }),
  })
  if (!created.res.ok) fail('创建 Release', created)
  release = created.body
} else {
  fail('查询 Release', found)
}

// 已有 Release 时把 macOS 说明追加进去（marker 保证幂等）。
if (notes && !String(release.body || '').includes(marker)) {
  const body = `${String(release.body || '').trim()}\n\n${notes}`.trim()
  const updated = await api(`/repos/${owner}/${repo}/releases/${release.id}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ tag_name: tag, name: release.name, body, prerelease: false }),
  })
  if (!updated.res.ok) fail('更新 Release 说明', updated)
  console.log('[gitee] Release 说明已更新')
}

const existing = new Set()
const attachments = await api(`/repos/${owner}/${repo}/releases/${release.id}/attach_files?per_page=100`)
if (attachments.res.ok && Array.isArray(attachments.body)) {
  for (const item of attachments.body) existing.add(item.name)
} else if (!attachments.res.ok) {
  console.warn(`[gitee] 读取附件列表失败（HTTP ${attachments.res.status}），按无附件处理`)
}

const files = readdirSync(dir)
  .filter((name) => !name.startsWith('.'))
  .map((name) => join(dir, name))
  .filter((path) => statSync(path).isFile())
  .sort()

let uploaded = 0
let skipped = 0
for (const path of files) {
  const name = basename(path)
  if (existing.has(name)) {
    console.log(`[gitee] 已存在，跳过：${name}`)
    skipped += 1
    continue
  }
  const form = new FormData()
  form.append('file', await openAsBlob(path), name)
  const res = await api(`/repos/${owner}/${repo}/releases/${release.id}/attach_files`, {
    method: 'POST',
    body: form,
  })
  if (!res.res.ok) fail(`上传 ${name}`, res)
  uploaded += 1
  console.log(`[gitee] 已上传：${name}（${(statSync(path).size / 1024 / 1024).toFixed(1)} MB）`)
}

console.log(`[gitee] 完成：上传 ${uploaded} 个，跳过 ${skipped} 个`)
console.log(`[gitee] https://gitee.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tag)}`)
