# CLAUDE.md

@AGENTS.md

## Claude Code 补充

- 仓库根目录就是工作目录。Bash 里不要 `cd`，它会改变会话的工作目录；改用绝对路径或 `git -C <dir>`。
- `references/` 是上游的只读副本：可以读，也可以运行（生成对拍数据），但不能修改其中受版本控制的文件。
- 当前阶段与路线图见 `docs/roadmap.md`，真机验证记录见 `docs/trouble.md`：都是内部文档，只在本地、不进版本控制，没有时忽略。改规范时先改 AGENTS.md，再改代码。
- 仓库是公开的：面向内部的内容（路线图、真机记录、账号与配置状态）不写进受版本控制的文件。
- 移植或修改平台时，照 `src/platforms/bilibili/web/` 的结构写，并补对拍（AGENTS.md 7.5）。测试默认禁止联网（`tests/setup.ts`）。
- 贡献者文档在 `.github/`（CONTRIBUTING、TESTING），用户文档在 `docs/`，示例脚本在 `docs/examples/`。
