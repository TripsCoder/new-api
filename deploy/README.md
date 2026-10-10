# new-api 应用独立部署（待审查，尚未部署）

本方案以 [TripsCoder/new-api](https://github.com/TripsCoder/new-api) 的 `main` 提交
`0f38a14a5e8e322ea741478b0e49878be3130e1d` 为基线（2026-10-11 核对）。
`deploy` 分支只追加部署文件，直接使用该版本原有 Dockerfile 构建 Go 后端和内嵌官方 Web 前端。
镜像名 `tripscoder/new-api:deploy-0f38a14a5e8e` 是本机构建标签，不依赖该名称已经发布到镜像仓库。

**当前只准备分支和命令，以下服务器写文件、构建、停服、备份、启动命令均须在用户审查通过后执行。**
迁移兼容性、现有账号登录、旧 Key 和余额扣费尚未经过候选副本验证，不能把 Compose 校验当成上线验收。

## 部署边界

| 部分 | 当前生产 | 此方案 |
| --- | --- | --- |
| PostgreSQL | `postgres:15`，容器 `postgres`，卷 `new-api_pg_data`，`127.0.0.1:5432` | 沿用原容器、原卷、原密码、原数据库 |
| Redis | 容器 `redis`，当前 `redis:latest`，`127.0.0.1:6379`，无挂载卷 | 沿用正在运行的原容器，不拉取 latest、不重建、不清缓存 |
| 基础设施 Compose | `/home/ubuntu/code/new-api/docker-compose-db.yml`，project `new-api` | 保留在原位置 |
| 网络 | `new-api-network` | 作为 external 网络引用，不创建新网络 |
| new-api | `new-api-dev`，旧定制镜像，`127.0.0.1:5000` | `new-api-official`，前后端一起构建，仍使用本机 5000 |
| 公网入口 | `new-api-frontend` → `switcher-api:8080` | `new-api-gateway` → `new-api-official:3000`，所有路径包括前端静态资源均由 new-api 提供 |
| Switcher | API/UI 和业务库 | 审查通过后仅停止旧应用；保留旧容器、镜像、文件和业务库供归档/恢复 |

新入口保留现网 80/443 端口映射、`server_name _`、100m 上传限制、600s 读写超时、HTTP/1.1、WebSocket 和关闭代理缓冲。
**现网 SSL 为 false，443 只有映射、没有 TLS 监听；本方案照此保留，没有新增 HTTPS 或证书设置。**
如公网 HTTPS 由外部代理承载，切换后仍须核验其完整访问链。

应用挂载继续使用 `/home/ubuntu/code/new-api/data` 和 `/home/ubuntu/code/new-api/logs`。
Compose 拒绝自动创建缺失的挂载目录，防止路径写错后启动成新实例。

## 环境配置一致性与保密

本次不新增任何 env 文件到 Git，包括示例文件。仓库已有的上游 `.env.example` 是上游文件，本次不修改。
新增忽略规则同时保护 `.env.*`、`*.env`、`*.env.*`，并从 Docker 构建上下文排除这些文件和 `deploy/`。

`prepare_env.py` 以 **运行容器的 Config.Env** 为权威，复制全部应用变量，仅去除镜像自身的 `PATH`。
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
| Switcher 签名密钥、连接串、`NEW_API_UPSTREAM`、`VITE_*` 等 | 属于退出的组件，不注入官方应用；网关直接转发到 new-api |
| 域名、渠道、分组、价格、支付等 `options` | 保留在原 new-api 数据库；不通过新 env 重建或覆盖 |

使用 Compose `env_file.format: raw`，避免密码中的 `$`、`#`、引号被插值或重新解释。
最低 Compose 版本 2.30，现网为 2.40.3；格式依据见 [Docker 官方说明](https://docs.docker.com/reference/compose-file/services/#format)。
真实环境文件建议放 `/home/ubuntu/.config/new-api-deploy/new-api.env`，父目录 0700、文件 0600。
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

# 仅审查通过后执行；若已存在则停止，避免覆盖此前保存的配置。
umask 077
export NEW_API_ENV_FILE=/home/ubuntu/.config/new-api-deploy/new-api.env
python3 deploy/prepare_env.py --write "$NEW_API_ENV_FILE"

# 后续命令均显式指定这个应用文件；不要在根目录直接 docker compose up。
app() { docker compose --env-file /dev/null -p new-api-app -f deploy/compose.app.yml "$@"; }
app config --quiet
app config --services  # 只能看到 new-api 和 gateway
app build new-api     # 构建本分支的官方前后端，不启动容器
app pull gateway     # 只拉取固定摘要的 Nginx
```

基础设施只需核对；这些命令不会重建 PostgreSQL/Redis：

```bash
docker compose --project-directory /home/ubuntu/code/new-api \
  -p new-api -f /home/ubuntu/code/new-api/docker-compose-db.yml ps
docker network inspect new-api-network --format '{{.Name}}'
docker volume inspect new-api_pg_data --format '{{.Name}}'
```

## 审查后：副本验证、切换及回退

1. 先备份并恢复到隔离的 PostgreSQL/Redis/网络副本，验证新镜像连续启动两次后的迁移幂等性、账号/密码哈希/模型 Key/额度保留及已有测试账号和 Key。
   候选环境必须改为副本 DSN/Redis、独立挂载目录、仅本机测试端口；禁止直接用本生产 Compose 启动候选。
   同时关闭副本的主动探测、支付回调、异步轮询等外部任务。尚未完成此项，不进入切换命令。
2. 现网 old new-api 启用了批量更新。先停止旧入口接受请求并排空现有流式请求，确认无在途任务，等待至少两轮实际批量刷新间隔，再停 API/后端并做最终备份。
   默认间隔为 5 秒时可等待至少 10 秒，但须先核对运行日志；若存在长请求，不能只靠固定等待时间。
3. 只有在旧入口已排空、写入已落库后，按下面命令停旧写入端、备份、启动新后端。先单独验收本机 5000，再启动新公网网关。

```bash
# 仍在上述 Bash 会话，NEW_API_ENV_FILE 和 app 函数已设置。
# 入口停止可能造成维护窗口；执行前已完成用户审查、副本验收及排空安排。
docker compose -p switcher -f /home/ubuntu/code/switcher/docker-compose.yml \
  stop --timeout 660 new-api-frontend
# 此处核对请求已完成、批量刷新已落库，再执行下面两条。
docker compose -p switcher -f /home/ubuntu/code/switcher/docker-compose.yml \
  stop --timeout 150 api
docker compose -p new-api -f /home/ubuntu/code/new-api/docker-compose.dev.local.yml \
  stop --timeout 150 new-api

umask 077
BACKUP_DIR="/home/ubuntu/backups/new-api-cutover/$(date +%Y%m%d-%H%M%S)"
install -d -m 700 "$BACKUP_DIR"
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
tar -C /home/ubuntu/code/new-api -czf "$BACKUP_DIR/data.tar.gz" data
sha256sum "$BACKUP_DIR"/*.dump > "$BACKUP_DIR/SHA256SUMS"
# 列表可读不等于恢复成功：副本恢复和资产校验必须已通过。

app up -d --no-build --wait --wait-timeout 300 new-api
curl --fail --silent http://127.0.0.1:5000/api/status
# 此处核对迁移结果、资产校验值，以及已有测试账号/Key；通过后才开放网关。
app up -d --no-build gateway
docker exec new-api-gateway nginx -t
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

- 服务器只读提取预检通过；用内存文件和 stdin 在服务器 Compose 2.40.3 解析本配置，5 个实际生效变量逐项一致；没有落盘 env、创建容器或执行数据库写入。
- 本地 Compose 5.1.4 解析通过：仅有 new-api/gateway 两个服务，网络为 external，没有受管理的数据卷；缺失私有 env 时拒绝解析，gateway 没有接收应用密钥。
- 本地断网临时容器实测 raw env 中 `$`、`#`、单/双引号、空格和 `=` 保持原值；测试只使用合成数据。
- `python3 -B -m unittest discover -s deploy -p test_prepare_env.py -v`：Linux 临时容器内 4 项测试全通过，包括 0700/0600 权限、原值往返、拒绝覆盖、拒绝符号链接和仓库内保存。
- 固定摘要的 Nginx 1.31.2-alpine 在本地执行 `nginx -t` 通过；文档命令经 `bash -n` 语法检查通过。
- Git 忽略规则和 `git diff --check` 通过。

未执行：new-api 完整镜像构建、候选数据库迁移与回滚演练、真实登录/Key/计费验收，以及任何服务器部署。
