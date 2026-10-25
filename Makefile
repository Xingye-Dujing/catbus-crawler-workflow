# 常用开发命令的快捷方式，都是对 npm scripts 和 docker 的包装（Windows 上直接用对应的 npm 命令）。
# make help 列出全部目标。

.DEFAULT_GOAL := help
.PHONY: help install assets build typecheck test e2e check gen link docker docker-doctor clean

IMAGE ?= catbus:local

help: ## 列出全部目标
	@grep -hE '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "} {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## 安装依赖并取回验证码模型（npm ci + assets）
	npm ci
	$(MAKE) assets

assets: ## 取回京东验证码模型与 OCR 模型（校验 sha256，已有时跳过）
	npm run assets:jd
	npm run assets:ocr

build: ## 编译到 dist/
	npm run build

typecheck: ## 类型检查（含测试）
	npm run typecheck

test: ## 离线测试（单元 + 对拍，禁止联网）
	npm test

e2e: ## 在线只读测试（本机 ~/.catbus 的登录态）；只跑一个平台：make e2e P=bilibili
	npm run test:e2e $(if $(P),-- -t '^$(P) ',)

check: typecheck test ## 提交前检查：类型检查 + 离线测试

gen: ## 改了注册表后重新生成 docs/capabilities.md
	npm run gen:capabilities

link: build ## 把 catbus 命令链接到全局
	npm link

docker: ## 构建 Docker 镜像（IMAGE=catbus:local）
	docker build -t $(IMAGE) .

docker-doctor: ## 在镜像里跑 catbus doctor
	docker run --rm $(IMAGE) doctor

clean: ## 删除 dist/ 和打包出的 tarball
	rm -rf dist *.tgz packages/*/*.tgz
