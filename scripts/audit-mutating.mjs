#!/usr/bin/env node
/**
 * 上线前的写命令体检：任何会改平台状态的命令都不许被采析绘当成「读能力」。
 *
 * 两个来源各查一遍：
 * 1. 平台注册表里以写动作结尾的命令（item publish / comment pin / folder add ……）必须带
 *    `mutating` 或 `confirm`。`write()` 会自动带 mutating，但平台扩展是手写的，上游每加一条
 *    写命令就多一个漏标的机会——漏了它就会出现在采析绘面板上并真的改用户账号的状态。
 * 2. 适配器自己的清单里不能出现任何 mutating / confirm 命令（manifest() 的排除规则还在）。
 *
 * 用法：node scripts/audit-mutating.mjs（需要先 npm run build）。
 */
import { existsSync } from 'node:fs'

const dist = new URL('../dist/', import.meta.url)
if (!existsSync(new URL('platforms/index.js', dist))) {
  console.error('先构建：npm run build')
  process.exit(2)
}

const { PLATFORMS } = await import(new URL('platforms/index.js', dist))
const { manifest } = await import(new URL('integrations/crawler-workflow/manifest.js', dist))

/** 命令键的最后一个词是写动作，才按写命令检查；`user likes` 这种复数读列表不在其中。 */
const WRITE_VERBS = new Set([
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

const missing = []
const flags = new Map()
let writeCommands = 0
for (const platform of PLATFORMS) {
  for (const endpoint of Object.values(platform.endpoints)) {
    if (!endpoint || typeof endpoint !== 'object' || !(endpoint.commands instanceof Map)) continue
    for (const [key, command] of endpoint.commands) {
      flags.set(`${platform.id}:${key}`, command)
      if (!WRITE_VERBS.has(key.split(' ').pop() ?? '')) continue
      if (command.mutating || command.confirm) {
        writeCommands += 1
        continue
      }
      missing.push(`${platform.id}:${key}`)
    }
  }
}

const exposed = []
for (const [platform, capability] of Object.entries(manifest().platforms)) {
  for (const [mode, cell] of Object.entries(capability.modes ?? {})) {
    const command = cell.command ? flags.get(`${platform}:${cell.command}`) : undefined
    if (command?.mutating || command?.confirm) exposed.push(`${platform}/${mode} -> ${cell.command}`)
  }
}

let failed = false
if (missing.length) {
  failed = true
  console.error('漏标的写命令（补 mutating: true）：')
  for (const item of missing) console.error(`  - ${item}`)
}
if (exposed.length) {
  failed = true
  console.error('清单里出现了写命令：')
  for (const item of exposed) console.error(`  - ${item}`)
}
if (failed) process.exit(1)
console.log(`写命令体检通过：${writeCommands} 条写命令全部带 mutating/confirm，清单里没有写命令`)
