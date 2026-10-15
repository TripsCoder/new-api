# 本地运行功能保留（2026-10-13）

## 当前开发决定（2026-10-15，未安装/部署）

用户确认在 `dev@184bfcb52` 上继续原生 API Key + `X-New-Api-Channel-Id` 方案，保留旧语音；以下 2026-10-13 回退说明是历史记录，不代表本轮源码状态。

- `media-providers/{profiles.json,runtime.js,build.mjs,sources.lock.json}` 是恢复后维护的七家源码，`dist/` 是 1.1.0 **候选**，193 个型号条目；不自动替换 `installed/` 或数据库。
- 本轮文档的 URL、SHA256、旧来源与未确认范围在 `sources.lock.json`。XCM、paisio、沧源、Yuxibox 声明已确认的 `/v1/models` Bearer/OpenAI 列表；其余未声明，获取时明确不支持。所有真实 Key 获取及付费请求均未执行。
- 受控 `meta.modelDiscovery` 是本地最小扩展，需要当前修改后的宿主；旧宿主会拒绝未知字段。不是官方既有能力。`/api/status.data.channel_selection` 宣告 Header 版本，客户端核验后才可使用，不在失败时移除 Header 重试。
- `node plugin-sources/media-providers/build.mjs` 生成候选；同命令加 `--check` 核验可复现输出；`node --test plugin-sources/media-providers/runtime.test.mjs` 离线验证参数。安装快照及其原 manifest 的校验仍独立保留。
- 价格未知、来源未确认、新发现但尚未适配的型号不因此自动启用。文档差距及完整实施/验证记录续写 juhefuwu `docs/migration/new-api-channel-sync-20261011.md` 第 19 节。

## 2026-10-15 秘塔 MiniMax-H3 独立候选

- `minimax-meta/plugin.js` 是独立维护的 1.2.0 候选，以 `installed/minimax-meta/plugin.js` 官方 1.1.0 精确快照为基线；安装快照、七家源码和运行库均不由该目录改写。
- 官方下载/文档 URL、原 SHA256、影策 `f368e63090534bcc1af354406c3d938a819fbfca` 来源及用户确认记录在 `minimax-meta/sources.lock.json`。公开旧插件仍限制 4–15 秒；本候选依据用户 2026-10-15 确认及影策源码支持 H3 的 4–30 秒，不宣称官方旧插件已更新。
- 只保留 `minimax-meta` / `MiniMax-H3`；统一 `seconds`（兼容 `duration`）、`aspect_ratio`、分辨率和参考数组在插件内部转换。根 Base URL 和已有 `/api/` 前缀均可使用；不修改已存渠道或 Key。
- 保留旧 `content` / `metadata.metaso_content`、multipart、Responses、查询、产物及原用量字段。参考素材在合并后按影策数量限制校验；只去除新旧字段别名间的重复映射，显式列表中的重复项、旧字段顺序和计费用量不变；首尾帧与多模态参考互斥。`profiles.json` 仍保守声明 `maxVideos=0`、`maxAudios=0`，不自动打开前台参考入口或额外计费配置。不增加模型发现、H3-Max 或价格。
- 离线验证：`node --test plugin-sources/minimax-meta/plugin.test.mjs` 14/14 通过；原有完整 new-api 镜像的 `plugin lint` 通过，`plugin test /candidate/plugin.js --fixture /candidate/fixture.json` 6/6 通过（隔离只读、无网络运行）。候选源码 SHA256 为 `2eead5a52f8853441e441dd2251f2acafda473c45f06c324edab8d5a0026ab1e`。只有模拟请求/响应，没有付费调用、安装、启用或部署；宿主桥接与回退记录续写 juhefuwu 原任务第 21 节。完成用量沿用原 `task.duration`，未宣称实测产物时长。

## 2026-10-13 历史决定：官方程序加语音接入

用户于 2026-10-13 要求除语音接入外恢复官方实现，并更新本地镜像。
当前应用源码以官方提交 `0f38a14a5e8e322ea741478b0e49878be3130e1d` 为基线：

- 保留豆包音频插件、40 项 fixture、音频回归，以及 `large-submit-json@1` 必需的运行时和契约声明。
- 大响应插件的成功响应解析失败继续禁止重复提交；普通 JSON 插件恢复官方重试行为。
- 渠道 Pin 分发、视频任务查询、后台模型获取及其前端均已恢复上述官方源码；对应两份本地中间件补丁测试已撤下。
- `installed/` 和 `manifest.json` 是之前的只读安装快照，保留作证据，不参与程序内置、不自动安装，也不表示这些二开已保留在网关内核。
- 部署配置与镜像发布工作流保留。已有渠道、价格、插件安装记录和业务数据不清空。
- 以下段落为回退前的历史记录；原镜像和旧源码均已留存，可恢复。

### 回退前记录

本目录属于 `TripsCoder/new-api`（本地 `new-api-deploy`）的开发分支，
用于保留当前本地运行功能，不是数据库初始化包，也不会自动修改渠道或启用插件。

## 来源与边界

- 开发基线：`deploy` 的 `8de42ad304b3013587553b837aff85c0bc7d2961`。
- 运行源码基线：`c6741c36a9a1a729554ad94ee99f21602a214a23`，叠加现有音频、视频查询和原生渠道补丁。
- 冻结源码来自本地 `yc-original-channel-20261012/source-new-api`；对应二进制与运行容器 `/new-api` 的 SHA-256 一致。
- 精确镜像、二进制哈希和 8 个已安装插件的版本、源码哈希见 `manifest.json`。
- 不包含渠道 Key、账号、价格配置、任务数据、数据库导出或 `.env`；不复制旧仓库分支历史。
- `Dockerfile`、`deploy/`、工作流和现有 Docker 容器、挂载卷均不因本次源码保留而变更。

## 保留的功能

1. `plugins/tasks/doubao-audio/plugin.js`：内置豆包音频插件，保留原生音频路由和 Responses 同步/后台模式。插件报告用量，价格仍由管理员配置。
2. `large-submit-json@1`：插件显式声明后允许最大 64 MiB 普通提交响应；任务持久化 JSON 仍限制为 1 MiB。上游接受请求后解析失败不重复提交。
3. 视频任务查询：从当前用户拥有的任务记录恢复原模型及插件身份；拒绝与任务渠道冲突的令牌固定渠道。
4. 原生渠道：已有合法令牌固定渠道时，其他供应商插件不得仅因端点和模型重名接管请求。未新增 YC 专用协议或固定渠道编号。
5. 模型获取：任务插件显示获取入口；尚无已验证实时接口时明确提示手动配置，不把静态 `meta.models` 宣称为上游获取结果。前端复用已有按钮、加载、错误和空状态组件。

## 插件源码的使用方式

`installed/<key>/plugin.js` 是 2026-10-13 从本地数据库已启用记录只读提取的 8 个源码，
逐字节 SHA-256 与数据库记录一致。它们不放入 `plugins/tasks/`，因此不会因构建镜像而自动启用、
改变现有安装优先级或覆盖数据库里的版本。

- 已有安装：继续使用原数据库记录；本目录只保留可审查、可恢复的源码。
- 全新安装：需要对应功能时，由管理员在任务插件管理页面上传相应 `plugin.js`，核验模型、用量和价格后配置渠道。
- 豆包音频随程序内置；仍需手动配置真实渠道凭据与价格。
- 将来修改这些保留源码时，应显式更新版本与清单，不再将修改后文件描述为原始数据库快照。

## 回归与回退

已有 Go 测试覆盖豆包 40 项 hook fixture、原生渠道选择、视频任务所有权/渠道一致性、
提交与持久化大小上限、禁止重复重试，以及 8 个源码哈希和与全部内置插件共同注册。
在 Go 1.26 环境从仓库根目录运行：

```sh
go test ./pkg/jsplugin ./plugins ./middleware ./relay/channel/task/jsplugin
go test ./controller -run 'Test(TaskPluginDiscovery|FetchModels|FetchAdvancedCustom|FetchOrdinaryOpenAI|FetchNewAPI|DetectAllChannelUpstream)'
go vet ./pkg/jsplugin ./plugins ./middleware ./controller ./relay/channel/task/jsplugin
```

前端使用 `web/bun.lock` 冻结依赖，运行渠道配置测试、typecheck、涉及文件 lint/格式检查和生产构建。
所有检查均为本地离线/模拟上游验证，不代表重新进行过供应商付费调用。

2026-10-13 验证结果：上述四个后端包及任务结算/退款定向测试通过，受影响包 `go vet` 通过；
Windows/amd64 与 Linux/amd64 完整程序构建通过。新构建程序的插件 CLI 验证 8/8 源码通过，
豆包 fixture 回放 40/40 通过。渠道配置页面 89/89 测试、typecheck、定向 lint/格式检查及生产构建通过。

本次完整 `controller` 包测试在 5 分钟上限超时；`channel_upstream_update_test.go` 的全部定向测试通过。
不把完整后端测试声明为通过，也不据此发布或替换运行镜像。

本次只提交开发分支，不合并 `main`/`deploy`/`release`，不部署。
回退源码可从上述开发基线另建分支或反向提交本次变更；运行环境无需回滚，因为未切换镜像或写入数据库。
