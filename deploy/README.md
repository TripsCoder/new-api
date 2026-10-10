# new-api 原生前后端与数据库分拆部署

部署源为 [TripsCoder/new-api](https://github.com/TripsCoder/new-api)，本分支基线是 2026-10-11 核对的
`main` 提交 `0f38a14a5e8e322ea741478b0e49878be3130e1d`。
直接用仓库原 Dockerfile 构建一个 new-api 镜像，同时提供 Go 后端和内嵌的原生 Web 前端。
不另行构建前端，不依赖 Switcher 的程序、网络别名、前端产物或镜像。

**本次只准备本地 deploy 分支和命令，未推送、未部署。以下服务器写入、构建、备份和切换命令须在用户审查通过后执行。**

## 两套 Compose

| 文件 | 服务 | 部署方式 |
| --- | --- | --- |
| `compose.db.yml` | `postgres`、`redis` | 原 project `new-api`，读取服务器原 `/home/ubuntu/code/new-api/.env` |
| `compose.app.yml` | `new-api`、`gateway` | project `new-api-app`，原生前后端 + Nginx 入口 |

数据库/Redis 沿用现网配置：PostgreSQL 15、Redis 当前镜像、原密码、容器名 `postgres` / `redis`、卷 `new-api_pg_data`、网络 `new-api-network`。
端口仍为 `127.0.0.1:5432` / `127.0.0.1:6379`。Redis 当前无挂载卷，本方案不改其持久化方式。
DB Compose 已与现网原 `/home/ubuntu/code/new-api/docker-compose-db.yml` 完整解析结果比对一致。

应用继续挂载 `/home/ubuntu/code/new-api/data`、`/home/ubuntu/code/new-api/logs`，使用原数据库和缓存。
new-api 默认监听 3000，主机仍映射 `127.0.0.1:5000:3000`。Nginx 通过服务名 `http://new-api:3000` 访问它，无额外别名。

## 原生前端与 Nginx

现网 Nginx 在原 `new-api-frontend` 容器内，没有宿主机 Nginx 服务。新入口使用同版本/发行系列
`nginx:1.31.2-trixie-perl`，固定镜像摘要，完全独立于旧前端镜像。

保留服务器现有 Nginx 的域名、80/443 端口、证书路径、TLS/HSTS、上传限制、读写超时、转发头、WebSocket、流式缓冲和 `/assets/` 缓存策略。
`nginx/templates/default.conf.template` 和 `nginx/15-frontend-ssl.sh` 保留原模板与 TLS 生成逻辑。

为移除 Switcher，必要变化只有入口接线：上游改为 `http://new-api:3000`，首页、静态资源和 API 统一转发给 new-api。
Nginx 不再读取旧前端静态文件，也不保留只转发旧 API 前缀的路由限制。官方原生前端完全由 new-api 提供。

现网 `NGINX_SSL_ENABLED=false`，443 虽有端口映射但没有 TLS 监听；此状态保持不变。
如果后续发现证书挂载或 SSL 已调整，须按当时现场补齐挂载并重新校验，本配置不会自行启用 HTTPS。

## 环境配置

服务器原 `/home/ubuntu/code/new-api/.env` 和 `/home/ubuntu/code/switcher/.env` 已只读核对，均不改写、不提交 Git。
本分支不新增任何 env 文件，连示例文件也不新增；上游已有 `.env.example` 未修改。
`.gitignore` 和 `.dockerignore` 已排除 `.env.*`、`*.env`、`*.env.*` 等私有文件。

一次性迁移准备使用 `prepare_env.py`，默认只读，只输出变量名、不输出密码或完整 DSN：

| 来源/配置 | 处理 |
| --- | --- |
| 原 DB `.env` | DB Compose 直接读取，原密码和文件不变 |
| 原 `new-api-dev` 的 `SQL_DSN`、`REDIS_CONN_STRING` | 原值复制到仓库外 `new-api.env`，包含全部连接参数 |
| `TZ`、`ERROR_LOG_ENABLED`、`BATCH_UPDATE_ENABLED` | 保留实际生效值 `Asia/Shanghai`、`true`、`true` |
| 原前端容器的 13 项 Nginx 设置 | 原值复制到仓库外 `gateway.env`，不替换域名、TLS、证书、HSTS、上传大小或超时 |
| `NEW_API_UPSTREAM` | 新网关设为 `http://new-api:3000`，不修改原 `.env` |
| 原前端 `VITE_*`、镜像包版本变量 | 不导入新网关；原生前端由 new-api 原 Dockerfile 构建 |
| 旧文件中未生效的 `STREAMING_TIMEOUT=300`、两个 `LINUX_DO_*_ENDPOINT` | 原文件保留，不在此次切换时擅自启用 |
| `SESSION_SECRET` / `CRYPTO_SECRET` | 当前未配置，脚本不自动生成或替换；网页登录态不保证沿用 |
| 域名、渠道、价格、分组、支付等 `options` | 继续保留在原 new-api 数据库，不以新 env 重建 |

导出的两个文件只用于保全生效配置，不替换服务器原 `.env`。父目录 0700、文件 0600，拒绝覆盖、符号链接或保存进 Git 工作区。
后续正常维护直接复用这些私有文件，不再依赖旧容器或 Switcher。
使用 [Compose `env_file.format: raw`](https://docs.docker.com/reference/compose-file/services/#format) 保留密码中的 `$`、`#`、引号和空格；最低 Compose 2.30，现网为 2.40.3。
不要 `source` 这些文件，也不要公开完整 `docker compose config` / `docker inspect` 输出。

## 审查后执行：配置和构建

`ubuntu` 无 Docker socket 权限，先单独执行 `sudo -i`，再在 root Bash 中运行下列命令。
分支尚未推送，需先将审查通过的 `deploy` 分支检出到 `/home/ubuntu/code/new-api-deploy`；保留原两个项目目录。

```bash
set -euo pipefail
cd /home/ubuntu/code/new-api-deploy
test "$(git -c safe.directory="$PWD" branch --show-current)" = deploy
git -c safe.directory="$PWD" merge-base --is-ancestor 0f38a14a5e8e322ea741478b0e49878be3130e1d HEAD
docker compose version

# 首次迁移才从旧容器提取；默认只读。
python3 deploy/prepare_env.py
python3 deploy/prepare_env.py --component gateway

umask 077
export NEW_API_ENV_FILE=/home/ubuntu/.config/new-api-deploy/new-api.env
export GATEWAY_ENV_FILE=/home/ubuntu/.config/new-api-deploy/gateway.env
# 仅首次生成；已有文件时停止，不覆盖。
python3 deploy/prepare_env.py --write "$NEW_API_ENV_FILE"
python3 deploy/prepare_env.py --component gateway --write "$GATEWAY_ENV_FILE"

db() { docker compose --env-file /home/ubuntu/code/new-api/.env -p new-api -f deploy/compose.db.yml "$@"; }
app() { docker compose --env-file /dev/null -p new-api-app -f deploy/compose.app.yml "$@"; }
db config --quiet
app config --quiet
db config --services   # postgres、redis
app config --services  # new-api、gateway

app build new-api      # 原 Dockerfile 一次构建官方前后端，不启动应用
app pull gateway       # 只拉取固定摘要的 Nginx，不拉取数据库/Redis
```

## 审查后执行：数据库与 Redis

以下命令使用本分支的 DB Compose，保持原 project、卷和网络名称。
`--no-recreate --pull never` 保持正在运行的旧容器，不更新 `redis:latest`。不要加 `--remove-orphans`。

```bash
db ps
docker network inspect new-api-network --format '{{.Name}}'
docker volume inspect new-api_pg_data --format '{{.Name}}'
db up -d --no-recreate --pull never postgres redis
```

此 Compose 也能独立创建数据库/Redis。若是灾备或新主机，先复制原私有 env、导入原镜像并恢复 PostgreSQL 数据，再启动；空卷会初始化空库，不能当作现网用户迁移。

## 审查后执行：副本验收、备份和切换

先把生产备份恢复到独立 PostgreSQL/Redis/网络副本，使用独立挂载和本机测试端口，验证迁移两次启动幂等性以及账号、密码哈希、模型 Key、额度保留。
副本不得连接生产 Redis，也不得执行支付回调、主动探测或异步外部任务；不要直接用本生产 Compose 启动候选。
验证现有测试账号登录、旧 Key 和代表性调用后，才能安排维护窗口。

原后端启用了批量更新。先停止入口接收请求、排空流式请求并确认无在途任务，再等至少两轮实际批量刷新间隔落库。
当前默认间隔 5 秒时至少等待 10 秒；实际以运行日志及在途请求为准，不能只靠固定等待时间。

```bash
# 已完成用户审查和副本验收；仍在前述 root Bash，会话变量和 app/db 函数已设置。
umask 077
BACKUP_DIR="/home/ubuntu/backups/new-api-cutover/$(date +%Y%m%d-%H%M%S)"
install -d -m 700 "$BACKUP_DIR"
docker exec new-api-frontend nginx -T > "$BACKUP_DIR/nginx-old.txt" 2>&1
docker compose -p switcher -f /home/ubuntu/code/switcher/docker-compose.yml stop --timeout 660 new-api-frontend
# 此处确认请求排空、批量刷新完成后，停止旧写入端。
docker compose -p switcher -f /home/ubuntu/code/switcher/docker-compose.yml stop --timeout 150 api
docker compose -p new-api -f /home/ubuntu/code/new-api/docker-compose.dev.local.yml stop --timeout 150 new-api

docker inspect new-api-dev switcher-api new-api-frontend postgres redis > "$BACKUP_DIR/containers.json"
docker exec postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d new-api -Fc' > "$BACKUP_DIR/new-api.dump"
docker exec postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d switcher -Fc' > "$BACKUP_DIR/switcher.dump"
docker exec -i postgres pg_restore --list < "$BACKUP_DIR/new-api.dump" > "$BACKUP_DIR/new-api.contents"
docker exec -i postgres pg_restore --list < "$BACKUP_DIR/switcher.dump" > "$BACKUP_DIR/switcher.contents"
cp -a /home/ubuntu/code/new-api/docker-compose-db.yml /home/ubuntu/code/new-api/docker-compose.dev.local.yml "$BACKUP_DIR/"
cp -a /home/ubuntu/code/switcher/docker-compose.yml "$BACKUP_DIR/switcher-compose.yml"
cp -a /home/ubuntu/code/new-api/.env "$BACKUP_DIR/old-new-api.env"
cp -a /home/ubuntu/code/switcher/.env "$BACKUP_DIR/old-switcher.env"
cp -a "$NEW_API_ENV_FILE" "$BACKUP_DIR/new-api.env"
cp -a "$GATEWAY_ENV_FILE" "$BACKUP_DIR/gateway.env"
tar -C /home/ubuntu/code/new-api -czf "$BACKUP_DIR/data.tar.gz" data
sha256sum "$BACKUP_DIR"/*.dump > "$BACKUP_DIR/SHA256SUMS"
# pg_restore --list 可读不等于已恢复验证；副本恢复必须已完成。

app up -d --no-build --wait --wait-timeout 300 new-api
curl --fail --silent http://127.0.0.1:5000/api/status
curl --fail --silent --output /dev/null http://127.0.0.1:5000/
# 核对迁移、资产和原生前端后，再开放 Nginx。
app up -d --no-build gateway
docker exec new-api-gateway nginx -t
docker exec new-api-gateway nginx -T > "$BACKUP_DIR/nginx-new.txt" 2>&1
curl --fail --silent --output /dev/null http://127.0.0.1/
app ps
```

比较新旧 Nginx 配置时，允许上游及页面/资源路由转发变化；域名、端口、TLS、证书、HSTS、缓存策略、上传限制、代理头和超时不得意外变化。
再验证原域名、原生 Web 页面与登录、原模型 Key 鉴权、实际扣费和流式响应；确认数据库/Redis 容器 ID、镜像、卷和端口未改变。

上述命令中的旧 Switcher 名称仅用于退出和备份，不属于新系统的运行依赖。
正式验收后可移除旧 Switcher 容器/部署，历史数据库与镜像归档按回退需要保留；不在切换时删除账务历史。
原数据库仍有两条旧 Switcher 触发器，退役时须备份并核对依赖，不能只删 outbox 表。此分支不自动执行退役 SQL。

## 回退

- 新后端尚未启动、数据库未迁移时，可以 `docker start new-api-dev switcher-api new-api-frontend` 恢复原容器。
- 新后端一旦启动，可能已修改 schema/数据。先 `app stop` 关闭新写入，备份最新数据库和失败现场；只有副本证明旧版本兼容时才能直接启动旧应用。
- 若必须恢复切换前快照，先在临时库验证，再受控切换；保留并对账新系统产生的充值、消费和用户改动，不覆盖丢失。这里不提供自动覆盖生产库的命令。
- 不执行 `down -v`、卷删除、Redis `FLUSH*` 或数据库重建。

## 验证记录

2026-10-11 已完成：

- DB/Redis Compose 与服务器原配置完整解析结果一致，原密码比对通过。
- 服务器内存中使用 Compose 2.40.3 解析新应用配置，后端 5 项生效变量与 Nginx 13 项设置逐项一致；仅网关上游按设计改为 `http://new-api:3000`。未写入远端文件。
- 主 Nginx 模板与 TLS 生成脚本和服务器原文件一致。新应用 Compose 只含 `new-api`、`gateway`，无 Switcher 别名或旧前端镜像依赖。
- 本地 Linux 隔离容器的 5 项环境保全测试通过，包括秘密字符、文件权限、拒绝覆盖/符号链接、禁止写入 Git 工作区及网关变量筛选。
- 使用固定摘要的 Nginx 镜像与合成上游，在本地内部网络验证配置加载、首页、`/assets/`、`/api/status`、`/v1/models` 和新页面路径转发；缓存、上传限制、超时及现网 SSL 关闭状态符合预期。此项验证代理接线，不替代真实 new-api 应用验收。
- 文档 Bash 命令语法检查、Compose 必填环境文件检查和 Git whitespace 检查通过。服务器原两份 `.env`、Nginx 源文件及 5 个容器的 ID/启动时间均未改变。

尚未执行 new-api 完整镜像构建、数据库副本升级、真实登录/Key/计费验收或任何服务器部署。
