# catbus 的容器镜像：与 npm 发布同一条路径，先打出三个包（catbus-cli、@cv-cat/catbus-assets-jd、@cv-cat/catbus-assets-ocr），
# 再在运行镜像里全局安装这三个 tarball（AGENTS 7.2）。运行镜像里没有源码和开发依赖。
#
#   docker build -t catbus .
#   docker run --rm -it -v catbus-data:/data catbus bilibili auth login
#   docker run --rm -v catbus-data:/data catbus bilibili item search 猫
#
# 构建时要联网：安装 npm 依赖、取回验证码模型（京东模型来自 GitHub 上的 cv-cat/JdApis，OCR 模型来自 PyPI 上的 ddddocr wheel，
# 都校验 sha256）。构建上下文里已经有模型文件（本机跑过 npm run assets:jd / assets:ocr）时直接用，不再下载。

ARG NODE_VERSION=24

# ---------------------------------------------------------------- 打包
FROM node:${NODE_VERSION}-bookworm-slim AS pack
WORKDIR /src

# 先装依赖，源码变了也能复用这一层
COPY package.json package-lock.json ./
COPY packages/assets-jd/package.json packages/assets-jd/
COPY packages/assets-ocr/package.json packages/assets-ocr/
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run assets:jd && npm run assets:ocr \
 && npm pack --silent \
 && npm pack --silent -w packages/assets-jd \
 && npm pack --silent -w packages/assets-ocr \
 && mkdir /out && mv ./*.tgz /out/

# ---------------------------------------------------------------- 运行
FROM node:${NODE_VERSION}-bookworm-slim

LABEL org.opencontainers.image.title="catbus" \
      org.opencontainers.image.description="catbus（猫巴士）：一个命令操作小红书、抖音、TikTok、B 站、快手、微博、闲鱼、淘宝、京东、X" \
      org.opencontainers.image.source="https://github.com/cv-cat/catbus" \
      org.opencontainers.image.licenses="MIT"

COPY --from=pack /out/ /tmp/pkgs/
RUN npm install -g --no-audit --no-fund /tmp/pkgs/cv-cat-catbus-assets-jd-*.tgz /tmp/pkgs/cv-cat-catbus-assets-ocr-*.tgz /tmp/pkgs/catbus-cli-*.tgz \
 && rm -rf /tmp/pkgs /root/.npm \
 && mkdir -p /data /work && chmod 700 /data

# 登录态、配置、二维码都在 /data（AGENTS 5.1 的 ~/.catbus），挂一个卷保存；下载的文件默认写到工作目录 /work。
# 默认以 root 运行，挂进来的任何目录都能写。Linux 上想让文件归自己所有，加 --user "$(id -u):$(id -g)"，
# 同时把 /data 换成自己的目录（例如 -v ~/.catbus:/data，和本机的 catbus 共用登录态）。
ENV CATBUS_HOME=/data \
    TZ=Asia/Shanghai
VOLUME ["/data"]
WORKDIR /work

ENTRYPOINT ["catbus"]
CMD ["--help"]
