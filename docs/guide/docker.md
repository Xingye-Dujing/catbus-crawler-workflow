# 用 Docker 运行

不想在本机装 Node 时，可以用仓库里的 [Dockerfile](../../Dockerfile) 构建镜像。镜像的打包方式和 npm 发布完全一样：先打出 `catbus-cli`、`@cv-cat/catbus-assets-jd`、`@cv-cat/catbus-assets-ocr` 三个包，再在 `node:24-bookworm-slim` 里全局安装，镜像里没有源码和开发依赖。

## 构建

```bash
git clone https://github.com/cv-cat/catbus.git && cd catbus
docker build -t catbus .
docker run --rm catbus doctor
```

构建时要联网：安装 npm 依赖，取回两个验证码模型（京东模型来自 GitHub 上的 cv-cat/JdApis，OCR 模型来自 PyPI 上的 ddddocr wheel，都校验 sha256）。本机已经跑过 `npm run assets:jd` / `npm run assets:ocr` 时，构建直接用已有的模型文件。镜像约 1.1 GB，其中两个模型约 115 MB。

## 登录态与数据

| 容器里的路径 | 用途 |
|---|---|
| `/data` | `CATBUS_HOME`：登录态、配置、二维码（对应本机的 `~/.catbus/`，见 [配置与数据目录](configuration.md)） |
| `/work` | 工作目录：`item download` 等命令默认写到这里 |

用一个命名卷保存登录态，下次运行还在：

```bash
docker run --rm -it -v catbus-data:/data catbus bilibili auth login          # 二维码画在终端里
docker run --rm -v catbus-data:/data catbus bilibili item search 猫 --limit 20
docker run --rm -v catbus-data:/data -v "$PWD:/work" catbus xhs item download "<笔记 URL>"
```

- 扫码登录要加 `-it`，二维码才能画在终端里；PNG 也会存到卷里的 `cache/<平台>/qrcode.png`。
- 导入 cookie 时从 stdin 读取，不用把 cookie 写进命令行：

  ```bash
  docker run --rm -i -v catbus-data:/data catbus weibo auth login --cookie - < weibo-cookie.txt
  ```

- 镜像默认以 root 运行，挂进来的任何目录都能写。Linux 上想让文件归自己所有，加 `--user "$(id -u):$(id -g)"`，同时把 `/data` 换成自己的目录，例如 `-v ~/.catbus:/data`（和本机的 catbus 共用登录态）。

## 代理与时区

catbus 不读取 `HTTP(S)_PROXY`（见 [配置](configuration.md#代理)），代理要写进卷里的 `config.toml`：

```bash
docker run --rm -v catbus-data:/data catbus config set proxy http://host.docker.internal:7890
```

镜像的时区默认是 `Asia/Shanghai`，可以用 `-e TZ=...` 覆盖。

## Docker Compose

仓库根目录的 [compose.yaml](../../compose.yaml) 提供两个服务，登录态放在命名卷 `catbus-data`，下载的文件落在 `./downloads`：

```bash
docker compose build
docker compose run --rm catbus bilibili auth login
docker compose run --rm catbus bilibili item search 猫 --limit 20
docker compose run --rm -T catbus weibo auth login --cookie - < weibo-cookie.txt
```

长时间监听直播弹幕，追加写到 `./downloads/live.jsonl`（每行一个 Event）：

```bash
ROOM=<直播间> docker compose --profile listen up live-listen
ROOM=<直播间> PLATFORM=douyin DURATION=2h docker compose --profile listen up live-listen
```

## 开发者

- `make docker` 构建镜像，`make docker-doctor` 在镜像里跑 `catbus doctor`（见 [Makefile](../../Makefile)）。
- CI 的 [docker.yml](../../.github/workflows/docker.yml) 在 x64 与 arm64 上构建镜像并跑 `version` / `doctor`，只构建，不推送到任何镜像仓库。
