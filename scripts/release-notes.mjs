// 从 CHANGELOG.md 取出某个版本的说明，作为 GitHub Release 的正文写到 stdout：开头是安装命令，相对链接换成仓库里的绝对地址。
// 用法：node scripts/release-notes.mjs <版本号>。CHANGELOG 里没有这个版本时退出码 1，release.yml 在发布前用它检查。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BLOB = 'https://github.com/cv-cat/catbus/blob/master/'

const version = process.argv[2]
if (!version) {
  console.error('用法：node scripts/release-notes.mjs <版本号>')
  process.exit(2)
}

const changelog = readFileSync(fileURLToPath(new URL('../CHANGELOG.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
const section = changelog.split(/^## /m).find((s) => s.startsWith(`[${version}]`))
if (!section) {
  console.error(`CHANGELOG.md 里没有 ## [${version}]，先写好这个版本的更新日志再打 tag`)
  process.exit(1)
}

const body = section
  .split('\n')
  .slice(1)
  .filter((line) => !/^\[[^\]]+\]: /.test(line))
  .join('\n')
  .replace(/^### /gm, '## ')
  .replace(/\]\((?!https?:|#)([^)]+)\)/g, (_, path) => `](${BLOB}${path})`)
  .trim()

process.stdout.write(`\`\`\`bash\nnpm i -g catbus-cli@${version}\n\`\`\`\n\n${body}\n\n完整的更新日志见 [CHANGELOG.md](${BLOB}CHANGELOG.md)。\n`)
