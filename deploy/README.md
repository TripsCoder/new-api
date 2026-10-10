# new-api 分拆部署（待审查，尚未部署）

本方案以 [TripsCoder/new-api](https://github.com/TripsCoder/new-api) 的 `main` 提交
`0f38a14a5e8e322ea741478b0e49878be3130e1d` 为基线（2026-10-11 核对）。
`deploy` 分支保存两套 Compose：`compose.db.yml` 部署数据库/Redis，`compose.app.yml` 部署官方后端/前端。
直接使用该版本原有 Dockerfile 构建 Go 后端和官方 Web 前端产物；Web 产物放进现网原 Nginx 镜像，保持其配置和启动脚本原样。
镜像名 `tripscoder/new-api:deploy-0f38a14a5e8e` 是本机构建标签，不依赖该名称已经发布到镜像仓库。

**当前只准备分支和命令，以下服务器写文件、构建、停服、备份、启动命令均须在用户审查通过后执行。**
迁移兼容性、现有账号登录、旧 Key 和余额扣费尚未经过候选副本验证，不能把 Compose 校验当成上线验收。

## 部署边界

| 部分 | 当前生产 | 此方案 |
| --- | --- | --- |
| PostgreSQL | `postgres:15`，容器 `postgres`，卷 `new-api_pg_data`，`127.0.0.1:5432` | 沿用原容器、原卷、原密码、原数据库 |
| Redis | 容器 `redis`，当前 `redis:latest`，`127.0.0.1:6379`，无挂载卷 | 沿用正在运行的原容器，不拉取 latest、不重建、不清缓存 |
| 基础设施 Compose | `/home/ubuntu/code/new-api/docker-compose-db.yml`，project `new-api` | 分支中的 `deploy/compose.db.yml` 保留原服务定义，仍使用 project `new-api` |
| 网络 | `new-api-network` | DB Compose 保留原网络定义；应用通过 external 引用 |
| new-api | `new-api-dev`，旧定制镜像，`127.0.0.1:5000` | `new-api-official`，前后端一起构建，仍使用本机 5000 |
| 公网入口 | `new-api-frontend` 内的 Nginx，静态前端 + `switcher-api:8080` API 上游 | `new-api-official-frontend` 只替换官方静态前端产物，保留原 Nginx 全部配置及环境值 |
| Switcher | API/UI 和业务库 | 审查通过后仅停止旧应用；保留旧容器、镜像、文件和业务库供归档/恢复 |

服务器没有独立宿主机 Nginx；现网 Nginx 在 `new-api-frontend` 容器中。
上一版自行新增的 `nginx.conf` 和 gateway 服务已删除。
本版不重写 Nginx 配置：保留全部 location、静态缓存规则、80/443 端口、域名、上传限制、超时、转发头、证书路径及 TLS/HSTS 设置。
**现网 SSL 为 false，443 只有映射、没有 TLS 监听；本方案照此保留，没有新增 HTTPS 或证书设置。**
如公网 HTTPS 由外部代理承载，切换后仍须核验其完整访问链。

原 Nginx API 上游字符串 `http://switcher-api:8080` 也保持不变。
新后端通过 `--port 8080` 和 `switcher-api` 网络别名接续此地址，主机端口仍为 `127.0.0.1:5000`。
此别名只是兼容旧入口，不运行 Switcher；旧 `switcher-api` 必须先停，禁止新旧后端同时占用该 DNS 别名。
最新前端替换静态产物需要切换前端容器，但不会编辑服务器原 `.env` 或 Nginx 文件。

应用挂载继续使用 `/home/ubuntu/code/new-api/data` 和 `/home/ubuntu/code/new-api/logs`。
Compose 拒绝自动创建缺失的挂载目录，防止路径写错后启动成新实例。

## 环境配置一致性与保密

本次不新增任何 env 文件到 Git，包括示例文件。仓库已有的上游 `.env.example` 是上游文件，本次不修改。
新增忽略规则同时保护 `.env.*`、`*.env`、`*.env.*`，并从 Docker 构建上下文排除这些文件和 `deploy/`。

服务器原 `/home/ubuntu/code/new-api/.env`、`/home/ubuntu/code/switcher/.env` 已重新只读核对，保持文件内容原样。
DB Compose 直接通过 `--env-file /home/ubuntu/code/new-api/.env` 读取原密码；不另写密码示例或替换 env。
`prepare_env.py` 以 **运行容器的 Config.Env** 保全实际生效值，仅去除镜像自身的 `PATH`。
默认提取后端；`--component frontend` 原样保全现网前端全部环境值，包括全部 `NGINX_*`、`NEW_API_UPSTREAM` 和 `VITE_REACT_APP_SERVER_URL`。
从实际 DSN/Redis URI 原样复制用户、密码、端口、库名、参数及 Redis DB 编号，不拼装新密码、不使用默认值。
它只读取 Docker 元数据，不连接/修改数据库，不生成 SESSION_SECRET 或 CRYPTO_SECRET，不启动/停止容器。

2026-10-11 只读核对结果：

| 配置 | 迁移方式 |
| --- | --- |
| `SQL_DSN` | 原值保留，目标 `postgres:5432/new-api`；完整值仅保存在仓库外 |
| `REDIS_CONN_STRING` | 原值保留，目标 `redis:6379`；完整值仅保存在仓库外 |
| `TZ` | 原值 `Asia/Shanghai` |
| `ERROR_LOG_ENABLED` | 原值 `true` |
| `BATCH_UPDATE_ENABLED` | 原值 `true` |
| `SESSION_SECRET` / `CRYPTO_SECRET` | 当前没有配置，脚本不擅自新增；网页登录态不能承诺继承 |
| 旧文件中的 `STREAMING_TIMEOUT=300`、两个 `LINUX_DO_*_ENDPOINT` | 未注入运行容器，也没有挂载给应用；因此不自动激活。新版本未配置项采用其默认值，需要在候选验证中检查 |
| `POSTGRES_PASSWORD`、`REDIS_PASSWORD` | 原基础设施继续使用；应用通过原 DSN/URI 使用同一凭据 |
| 原前端 `NGINX_*`、`NEW_API_UPSTREAM`、`VITE_REACT_APP_SERVER_URL` | 复制原运行值到仓库外 frontend.env，保持原 Nginx 行为；原 switcher/.env 不修改 |
| Switcher API 签名密钥、连接串等 | 留在原 switcher/.env，退出的 API 不注入新后端 |
| 域名、渠道、分组、价格、支付等 `options` | 保留在原 new-api 数据库；不通过新 env 重建或覆盖 |

使用 Compose `env_file.format: raw`，避免密码中的 `$`、`#`、引号被插值或重新解释。
最低 Compose 版本 2.30，现网为 2.40.3；格式依据见 [Docker 官方说明](https://docs.docker.com/reference/compose-file/services/#format)。
派生的生效值保全文件放 `/home/ubuntu/.config/new-api-deploy/new-api.env` 和 `frontend.env`，父目录 0700、文件 0600；它们不替换服务器原 `.env`。
不要把它复制进仓库，不要 `source` 它，不要在共享终端执行完整 `docker compose config` 或打印 `docker inspect`。

## 审查后：准备文件和镜像

现网 `ubuntu` 用户不能直接访问 Docker socket。先单独执行 `sudo -i` 进入 root Bash，再在该 shell 从仓库根目录执行下面各段；环境文件由 root 保管。
`deploy` 分支发布到远端后，可独立检出到
`/home/ubuntu/code/new-api-deploy`；不要覆盖线上 `/home/ubuntu/code/new-api` 或 Switcher 工作区。
本次仅创建本地分支，没有推送远端，所以当前不能直接从 GitHub 克隆 `deploy`。

```bash
set -euo pipefail
cd /home/ubuntu/code/new-api-deploy
test "$(git -c safe.directory="$PWD" branch --show-current)" = deploy
git -c safe.directory="$PWD" merge-base --is-ancestor 0f38a14a5e8e322ea741478b0e49878be3130e1d HEAD
docker compose version

# 只读检查来源容器和目标地址；输出只有变量名称，没有值。
python3 deploy/prepare_env.py
python3 deploy/prepare_env.py --component frontend

# 仅审查通过后执行；若已存在则停止，避免覆盖此前保存的配置。
umask 077
export NEW_API_ENV_FILE=/home/ubuntu/.config/new-api-deploy/new-api.env
export FRONTEND_ENV_FILE=/home/ubuntu/.config/new-api-deploy/frontend.env
python3 deploy/prepare_env.py --write "$NEW_API_ENV_FILE"
python3 deploy/prepare_env.py --component frontend --write "$FRONTEND_ENV_FILE"

# 后续命令均显式指定这个应用文件；不要在根目录直接 docker compose up。
app() { docker compose --env-file /dev/null -p new-api-app -f deploy/compose.app.yml "$@"; }
db() { docker compose --env-file /home/ubuntu/code/new-api/.env -p new-api -f deploy/compose.db.yml "$@"; }
db config --quiet
db config --services  # postgres 和 redis
app config --quiet
app config --services  # new-api 和 frontend

# 固定现网原 Nginx 运行镜像，不换镜像版本、不改配置或启动脚本。
NGINX_BASE_ID=sha256:647e477c2905ae5ab3631a846faf31b9c949899dc8dd46d5ef27b3cb607e15ac
test "$(docker inspect --format '{{.Image}}' new-api-frontend)" = "$NGINX_BASE_ID"
docker tag "$NGINX_BASE_ID" new-api-nginx-base:production-647e477c2905

# 从同一提交的原 Dockerfile 取得最新官方前端构建产物。
docker build --target builder -t tripscoder/new-api-web:deploy-0f38a14a5e8e .
app build new-api frontend  # 构建镜像，不启动容器；不要添加 --pull
```

基础设施现网复用：先核对同名卷和网络确实存在，再使用独立 DB Compose。
`--no-recreate --pull never` 防止重建已有容器或更新 `redis:latest`；不执行 `--remove-orphans`。

```bash
db ps
docker network inspect new-api-network --format '{{.Name}}'
docker volume inspect new-api_pg_data --format '{{.Name}}'
# 仅审查通过后执行；已有且运行中的 postgres/redis 会保持原样。
db up -d --no-recreate --pull never postgres redis
```

这份 DB Compose 也能独立创建数据库/Redis，网络名和卷名固定，不随目录名变化。
如果是灾备或新主机，先复制原私有 env、导入已保存的原 PostgreSQL/Redis 镜像并恢复 `new-api_pg_data` 数据，再执行同一命令；空卷会初始化空库，不能当成现网用户迁移。
原 Nginx 基底镜像也须通过 `docker image save/load` 保留，不能用新拉取的 Nginx 镜像代替本方案的原配置。

## 审查后：副本验证、切换及回退

1. 先备份并恢复到隔离的 PostgreSQL/Redis/网络副本，验证新镜像连续启动两次后的迁移幂等性、账号/密码哈希/模型 Key/额度保留及已有测试账号和 Key。
   候选环境必须改为副本 DSN/Redis、独立挂载目录、仅本机测试端口；禁止直接用本生产 Compose 启动候选。
   同时关闭副本的主动探测、支付回调、异步轮询等外部任务。尚未完成此项，不进入切换命令。
2. 现网 old new-api 启用了批量更新。先停止旧入口接受请求并排空现有流式请求，确认无在途任务，等待至少两轮实际批量刷新间隔，再停 API/后端并做最终备份。
   默认间隔为 5 秒时可等待至少 10 秒，但须先核对运行日志；若存在长请求，不能只靠固定等待时间。
3. 只有在旧入口已排空、写入已落库后，按下面命令停旧写入端、备份、启动新后端。先单独验收本机 5000，再启动新公网网关。

```bash
# 仍在上述 root Bash 会话，两份环境文件路径和 app/db 函数已设置。
# 入口停止可能造成维护窗口；执行前已完成用户审查、副本验收及排空安排。
umask 077
BACKUP_DIR="/home/ubuntu/backups/new-api-cutover/$(date +%Y%m%d-%H%M%S)"
install -d -m 700 "$BACKUP_DIR"
# 旧前端停止后不能 docker exec，所以先保存其完整配置与原镜像。
docker exec new-api-frontend nginx -T > "$BACKUP_DIR/nginx-old.txt" 2>&1
docker image save new-api-nginx-base:production-647e477c2905 > "$BACKUP_DIR/nginx-base.tar"
docker compose -p switcher -f /home/ubuntu/code/switcher/docker-compose.yml \
  stop --timeout 660 new-api-frontend
# 此处核对请求已完成、批量刷新已落库，再执行下面两条。
docker compose -p switcher -f /home/ubuntu/code/switcher/docker-compose.yml \
  stop --timeout 150 api
docker compose -p new-api -f /home/ubuntu/code/new-api/docker-compose.dev.local.yml \
  stop --timeout 150 new-api

docker inspect new-api-dev switcher-api new-api-frontend postgres redis > "$BACKUP_DIR/containers.json"
docker exec postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d new-api -Fc' > "$BACKUP_DIR/new-api.dump"
docker exec postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d switcher -Fc' > "$BACKUP_DIR/switcher.dump"
docker exec -i postgres pg_restore --list < "$BACKUP_DIR/new-api.dump" > "$BACKUP_DIR/new-api.contents"
docker exec -i postgres pg_restore --list < "$BACKUP_DIR/switcher.dump" > "$BACKUP_DIR/switcher.contents"
cp -a /home/ubuntu/code/new-api/docker-compose-db.yml \
  /home/ubuntu/code/new-api/docker-compose.dev.local.yml "$BACKUP_DIR/"
cp -a /home/ubuntu/code/switcher/docker-compose.yml "$BACKUP_DIR/switcher-compose.yml"
cp -a /home/ubuntu/code/new-api/.env "$BACKUP_DIR/old-new-api.env"
cp -a /home/ubuntu/code/switcher/.env "$BACKUP_DIR/old-switcher.env"
cp -a "$NEW_API_ENV_FILE" "$BACKUP_DIR/new-api.env"
cp -a "$FRONTEND_ENV_FILE" "$BACKUP_DIR/frontend.env"
tar -C /home/ubuntu/code/new-api -czf "$BACKUP_DIR/data.tar.gz" data
sha256sum "$BACKUP_DIR"/*.dump > "$BACKUP_DIR/SHA256SUMS"
# 列表可读不等于恢复成功：副本恢复和资产校验必须已通过。

app up -d --no-build --wait --wait-timeout 300 new-api
curl --fail --silent http://127.0.0.1:5000/api/status
# 此处核对迁移结果、资产校验值，以及已有测试账号/Key；通过后才开放网关。
app up -d --no-build frontend
docker exec new-api-official-frontend nginx -t
# 对比原/新容器 nginx -T 的完整输出，预期配置逐字一致；不要公开其中的私有配置。
docker exec new-api-official-frontend nginx -T > "$BACKUP_DIR/nginx-new.txt" 2>&1
cmp "$BACKUP_DIR/nginx-old.txt" "$BACKUP_DIR/nginx-new.txt"
curl --fail --silent --output /dev/null http://127.0.0.1/
app ps
```

切换后核验原域名、Web 登录、已有 Key 鉴权和代表性请求、余额读取/实际扣费、流式响应，并比较 PostgreSQL/Redis 的容器 ID、镜像 ID、卷与端口仍未变化。
SSH 密码、用户密码、API Key、DSN 都不写进命令历史或验收报告。

生产库还存在两条旧 Switcher 触发器，用户/订阅写入仍可能追加旧 outbox；本方案不自动执行退役 SQL，也不删除历史表。
用户已允许退出旧功能，但具体触发器备份/依赖核验/退役脚本在正式部署阶段单独核对，不能只删 outbox 表。

**回退以数据库状态为界，不能只换回镜像：**

- 若新后端尚未启动，原数据库未被迁移，可直接用 `docker start new-api-dev switcher-api new-api-frontend` 恢复原容器。
- 新后端一旦启动，就可能执行 schema/数据迁移。先 `app stop` 关闭新写入、保存失败现场及最新数据库备份；只有副本证明旧版本能读写此数据库时，才能启动旧容器。
- 若必须恢复切换前快照，先在临时库恢复并验证，再安排受控数据库切换；新版本产生的任何充值、消费和用户改动必须先保留/对账，不能覆盖丢失。这里不提供自动覆盖生产库的回滚命令。
- 全程不执行 `down -v`、`docker volume rm`、Redis `FLUSH*`、数据库重建或旧镜像清理。

## 本次验证记录

2026-10-11 已完成：

- 服务器 Compose 2.40.3 只读解析 `compose.db.yml`，使用原 `.env` 后的完整结果与现网原 DB Compose 完全一致；PostgreSQL/Redis 密码与运行容器逐项一致。
- 通过内存文件和 stdin 解析应用 Compose，后端 5 个、前端 21 个生效变量逐项一致，Nginx 原上游地址保持不变；没有落盘 env、创建容器或执行数据库写入。
- 本地断网临时容器已实测 raw env 中 `$`、`#`、单/双引号、空格和 `=` 保持原值；测试只使用合成数据。
- `python3 -B -m unittest discover -s deploy -p test_prepare_env.py -v`：Linux 临时容器内 5 项测试全通过，包括前端 Nginx 变量保全、0700/0600 权限、原值往返、拒绝覆盖、拒绝符号链接和仓库内保存。
- 文档命令经 `bash -n` 语法检查通过；Git 忽略规则和 `git diff --check` 通过。

未执行：两种应用镜像完整构建、重建前端后的 `nginx -T` 逐字比对、候选数据库迁移与回滚演练、真实登录/Key/计费验收，以及任何服务器部署。
