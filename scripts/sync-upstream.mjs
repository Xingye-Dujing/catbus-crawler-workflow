#!/usr/bin/env node
/**
 * 把上游 cv-cat/catbus 的最新「CI 全绿」提交同步进这个采析绘适配分支。
 *
 * 规则（与仓库维护者的约定一致）：
 * - 只看上游默认分支（默认 upstream/master）最近 N 个提交；CI 有失败 / 取消 / 还在跑的，
 *   一律忽略，取最新的「全部 workflow 都完成且没有失败」的那一个。
 * - 合并用 --no-commit：先合并、再装依赖、构建、跑上游测试、跑写命令体检，最后（可选）跑
 *   采析绘自己的 CatBus 集成测试。任何一步失败就 git merge --abort，不在坏树上留提交。
 * - 全部通过才提交；`--push` 才推送。默认只给出下一步要执行的命令。
 *
 * 用法：
 *   npm run sync:upstream                     # 同步并验证，不推送
 *   npm run sync:upstream -- --push           # 验证通过后推送 origin 当前分支
 *   npm run sync:upstream -- --crawler-workflow F:\python_project\crawls\crawler_workflow
 *   npm run sync:upstream -- --max-commits 80
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const UPSTREAM_URL = 'https://github.com/cv-cat/catbus.git'
const UPSTREAM_REPO = 'cv-cat/catbus'
const GREEN = new Set(['success', 'neutral', 'skipped'])
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const value = (flag, fallback = '') => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

function run(command, args, { allowFailure = false, env } = {}) {
  const shown = [command, ...args].join(' ')
  console.log(`\n$ ${shown}`)
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    env: env ? { ...process.env, ...env } : process.env,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`命令失败（${result.status}）：${shown}`)
  }
  return result
}

function capture(command, args) {
  return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8' }).trim()
}

function git(...args) {
  return capture('git', args)
}

function workflows(sha) {
  const raw = run(
    'gh',
    ['run', 'list', '--repo', UPSTREAM_REPO, '--commit', sha, '--limit', '30', '--json', 'workflowName,status,conclusion'],
    { allowFailure: true },
  )
  if (raw.status !== 0) throw new Error(`gh run list 失败：${sha}`)
  return JSON.parse(raw.stdout || '[]')
}

/** 这个提交的每一条 CI 都完成且没有失败，并且至少有一条真的跑过（不是全 skipped）。 */
function allGreen(sha) {
  const runs = workflows(sha)
  if (!runs.length) return { green: false, why: '没有 CI 记录' }
  if (runs.some((item) => item.status !== 'completed')) return { green: false, why: 'CI 还在跑' }
  const bad = runs.filter((item) => !GREEN.has(item.conclusion))
  if (bad.length) return { green: false, why: `CI 未通过：${bad.map((item) => `${item.workflowName}=${item.conclusion}`).join(', ')}` }
  if (!runs.some((item) => item.conclusion === 'success')) return { green: false, why: 'CI 全部被跳过' }
  return { green: true, why: runs.map((item) => `${item.workflowName}=${item.conclusion}`).join(', ') }
}

function ensureUpstream() {
  const remotes = git('remote').split(/\r?\n/)
  if (!remotes.includes('upstream')) {
    run('git', ['remote', 'add', 'upstream', UPSTREAM_URL])
  }
  run('git', ['fetch', 'upstream', '--tags', '--prune'])
}

function latestGreen(branch, maxCommits) {
  const log = git('log', '--format=%H %s', `--max-count=${maxCommits}`, `upstream/${branch}`).split(/\r?\n/)
  for (const line of log) {
    const [sha, ...subject] = line.split(' ')
    const verdict = allGreen(sha)
    if (verdict.green) {
      console.log(`\n选中上游提交 ${sha.slice(0, 8)}（${verdict.why}）：${subject.join(' ')}`)
      return sha
    }
    console.log(`跳过 ${sha.slice(0, 8)}：${verdict.why}`)
  }
  throw new Error(`upstream/${branch} 最近 ${maxCommits} 个提交里没有 CI 全绿的版本`)
}

function crawlerWorkflowTests(directory) {
  if (!directory) {
    console.log('\n未指定 --crawler-workflow，跳过采析绘集成测试（可用 --crawler-workflow <目录> 打开）')
    return
  }
  const python =
    process.platform === 'win32'
      ? resolve(directory, '.venv/Scripts/python.exe')
      : resolve(directory, '.venv/bin/python')
  run(python, ['-m', 'pytest', 'tests/integration/test_catbus_adapter.py', '-q', '-m', 'integration'], {
    env: { CATBUS_HOME: ROOT, CIXI_REQUIRE_CATBUS: '1', PYTHONIOENCODING: 'utf-8' },
  })
}

function main() {
  if (git('status', '--porcelain')) throw new Error('工作区不干净：先提交或 stash 再同步')
  ensureUpstream()

  const branch = value('--upstream-branch', 'master')
  const maxCommits = Number(value('--max-commits', '60'))
  const localBranch = git('rev-parse', '--abbrev-ref', 'HEAD')
  const sha = latestGreen(branch, maxCommits)

  if (run('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { allowFailure: true }).status === 0) {
    console.log(`\n已经包含 ${sha.slice(0, 8)}，无需同步`)
    return
  }

  run('git', ['merge', '--no-commit', '--no-ff', sha])
  try {
    run(NPM, ['ci'])
    run(NPM, ['run', 'build'])
    run(NPM, ['test'])
    run('node', ['scripts/audit-mutating.mjs'])
    crawlerWorkflowTests(value('--crawler-workflow', process.env.CRAWLER_WORKFLOW_DIR || ''))
  } catch (error) {
    console.error('\n验证失败，回滚这次合并：' + error.message)
    run('git', ['merge', '--abort'], { allowFailure: true })
    process.exit(1)
  }

  const version = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version
  run('git', ['commit', '-m', `功能更新：同步上游 ${version}（cv-cat/catbus ${sha.slice(0, 7)}，CI 全绿）`])
  console.log(`\n同步完成。推送：git push origin ${localBranch}`)
  if (has('--push')) run('git', ['push', 'origin', localBranch])
}

try {
  main()
} catch (error) {
  console.error(`\n同步中止：${error.message}`)
  process.exit(1)
}
