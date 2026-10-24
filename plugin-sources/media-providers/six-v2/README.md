## 2026-10-17 当前接口参数入口（2.1.0）

当前生成链路为interface_contracts.py读取带摘要的请求文档→profiles.interfaces→插件meta.parameterInterfaces/编译codec→宿主参数投影及初始化。真实型号只来自获取/明确选择的ID，文档型号示例不生成新绑定、接口预设或目录。文档明确的型号限制保存为modelRules；未有对应文档限制的真实ID使用接口基线并保留待确认项。接口选择显示文档标题和路径，批量/单独配置消费同一份字段来源。单一权威流程见[既有渠道规则](../../../../juhefuwu/docs/operations/upstream-channel-troubleshooting.md#imported-parameter-policy)。

legacy-profiles.json为已部署2.0.2执行兼容快照，build-profiles.py核对固定摘要，保留旧任务、usageProfiles/routes/discovery；其中models和旧模板仅维持历史执行，不参与新参数预设/初始化。新配置继续复用protocol.templateModel字段保存稳定interface: ID；旧主机不认识此可选元数据，必须与新主机成对发布/回退。默认initial-configurations.json只有六份空草稿，不能应用；`--models-file`须提供实际获取的ID、明确类别/接口及确认状态，`--output`可生成独立可审阅草稿，维护命令prepare通过`--drafts <file>`读取该草稿而不改原始构建产物。初始化不会自动更改真实渠道、价格或启用新型号。

下方较早的型号表和交付记录只保留历史来源说明；与上述入口冲突的模板流程不再作为当前操作规则。当前实施/验证/部署事实见juhefuwu原任务25.16，不以生成产物本身声明已部署或供应商调用成功。

# Reviewed six-provider candidate build

## Authoritative workflow and implementation status (2026-10-17 final decision)

Follow the existing host [supplier parameter source rules and complete workflow](../../../../juhefuwu/docs/operations/upstream-channel-troubleshooting.md#imported-parameter-policy) for all future imports and changes. This is the single normative definition; the historical six-provider build and editor descriptions below are implementation evidence, not a separate playbook. The final decision supersedes any earlier requirement to derive parameter presets from model examples/enumerations or to select an old model template before a new real model can display interface parameters.

The earlier r7 generator/editor used model-named templates. That initialization path is replaced by the 2.1.0 endpoint contracts described above; retained legacy profiles serve execution compatibility only. Actual installation, activation and verification facts remain in the host task/release records.

Scope: Paisio, YuxiBox, XCM, ArtBox, LXMone and Zexapi only. This directory records generated artifacts; installation/activation and supplier success require separate evidence. The historical 2.0.2 candidate build publishes 217 canonical contract models and retains three explicit existing Zex gateway compatibility names privately (220 executable names in source, without case-colliding metadata). There are 40 pending catalog entries; 12 of them are currently configured old names whose exact current contracts remain unresolved. See `compatibility-review.json` for all 33 original gaps and individual evidence/reasons. Public documentation and snapshots are retained under `evidence/`; account prices remain unconfirmed unless explicitly reviewed. ArtBox final output URL contracts remain unresolved, so its runtime does not fabricate a completed artifact.

## Reproduce and check

From the repository root:

```powershell
python plugin-sources/media-providers/six-v2/build-profiles.py
python plugin-sources/media-providers/six-v2/build-catalog.py
node plugin-sources/media-providers/six-v2/build.mjs --check
node plugin-sources/media-providers/six-v2/build-initial-configurations.mjs --check
node --test plugin-sources/media-providers/six-v2/runtime.test.mjs
```

The source builders use retained public snapshots, not downloaded JavaScript execution. Rebuilding source profiles/catalog does not install or activate plugins. The generated initialization documents contain documented modes enabled for review; they are not active channel configuration. XCM configuration enablement is independent of its public opening status: every new v2 submission checks a fresh public catalog, including explicit accepting status. Preparing, unavailable, stale or contradictory availability blocks the new submission before charging or generation; existing tasks retain their original polling contract.

## Paisio video reference ordering

For reviewed Paisio video profiles with `mainImage: true`, the editor/plugin input is the ordered normalized `images` array. The plugin writes `images[0]` as the scalar `image_url`, and `images.slice(1)` as `extra_images` only when additional images exist. Thus `@Image1` / `@Img1` refers to `image_url`, `@Image2` / `@Img2` to `extra_images[0]`, and so on. Prompt text, duplicate references and input order are preserved. Video and audio references use `extra_videos` and `extra_audios` for the profiles that support them. This rule belongs to the reviewed video profile; Paisio image edits retain their separate `image` array contract, and unsupported reference modes are not enabled by this rule.

Keep the editor's normalized `images` mapping when using these profiles: the plugin performs the scalar/array split after configuration resolution. The simple field mapping editor is not an array-slicing language. `runtime.test.mjs` covers every reviewed main-image profile, zero/one/multiple images, normalized aliases, explicit vendor fields, decoded requests, manual protocol templates, and the image-edit/other-provider boundaries. These are offline payload checks, not successful supplier generation evidence.

## Deliberate maintenance entry

`go run ./cmd/six-channel-initialize` supports `prepare`, `discover`, `preview` (default), `apply`, and `restore`. It never installs plugins, loads `.env`, creates channels, reads channel keys, auto-migrates a database, or rewrites channel Models/Status. Deploying the reviewed host schema and installing matching v2 plugins are separate operations requiring their own authorization. Set `SIX_CHANNEL_INITIALIZATION_DSN` securely in the process environment; never put a DSN or key into a plan, command log or issue. Supported database arguments are sqlite, mysql and postgres. SQLite must already exist; discover/preview use read-only mode.

1. Run `go run ./cmd/six-channel-initialize --action discover --database <kind>` to inventory exact existing provider channel IDs and historical source proof. Resolve missing or ambiguous channels; do not invent keys.
2. Create a JSON object mapping exactly the six provider keys to six distinct verified positive channel IDs. Provider keys are `paisio_media`, `yuxibox_media`, `xcmapi_media`, `artbox_media`, `lxmone_media`, `zhangyuge_media`.
3. Run `go run ./cmd/six-channel-initialize --action prepare --channels <mapping.json> --plan <new-plan.json>`. This checks artifact hashes and computes canonical document fingerprints without opening a database. It writes a new file exclusively. Review all modes, account cost and selling billing before use. Prepared expectedRevision defaults to 0; if a channel already has configuration, inspect preview and explicitly set its actual expectedRevision in the plan. Editing configuration also requires recomputing its canonical document fingerprint through the reviewed preparation logic; do not bypass fingerprint validation.
4. Run `go run ./cmd/six-channel-initialize --action preview --database <kind> --plan <reviewed-plan.json>`. This only reads. Review blockers, exact channel scope, current revisions, active plugin version/source fingerprint and historical task safety. No provider key is returned.
5. Only after approved installation/scope review, `--action apply --database <kind> --plan <reviewed-plan.json> --actor <existing-active-admin-id> --receipt <new-receipt.json>` applies the six configuration revisions atomically. Any conflict rolls back the whole batch. The receipt is reserved before mutation and stored in the same DB transaction. Repeating the exact plan with a new receipt path returns the original receipt without new revisions, including after a local receipt write failure. A previously applied plan stays an idempotent replay after a restore; create and review a new plan with new expected revisions for a new operation.
6. `--action restore --database <kind> --receipt <receipt.json> --actor <id>` appends restoration revisions atomically. It never deletes history or modifies keys/Models/Status. Concurrent intervening revisions cause a conflict; repeated successful restore is a no-op.

## Task and cost boundaries

Six-provider version switching requires a historical inventory. Missing task execution snapshots block switching. Tasks with a pinned source digest require an exact match. Older version-only snapshots may use only the retained immutable database key/version source whose bytes rehash to its recorded SHA256; they cannot fall back to the current plugin or a same-version built-in. Referenced old versions cannot be deleted. No historical task is backfilled by initialization.

The editor's real-test action uses the ordinary submission, operator wallet, pinned channel/configuration/plugin snapshot, task persistence and settlement. It requires an explicit charge acknowledgement and positive estimated USD budget; unknown provider cost requires an additional acknowledgement. The estimate threshold is not a guaranteed final bill cap. Provider native-currency cost is separate from user USD selling billing, unknown cost is not zero, and missing actual usage remains pending. Contract fixtures and local mock HTTP are not paid supplier validation.


## Compatibility review addendum

Native XCM `h3` is rebuilt from the canonical QuickStart's separate protocol, not mapped to `minimax-h3`. Text, first/last frames, up to seven reference images, and documented preset voices eve/leo are source-backed candidates; custom audio and unverified 1080p references are rejected. Before reserving money the host reads `/v1/models` with this attempt's selected key, using the selected channel transport/proxy policy, bounded response/time and no redirects. An exact `h3` row is required; this proves key visibility, not successful supplier generation. Other XCM composite video models retain the fresh public status/accepting gate.

The three existing Zex gateway names are `MiniMax-H3` → `minimax-h3`, `gpt-image-2-2k` → `gpt-image-2-2K`, and `gpt-image-2-4k` → `gpt-image-2-4K`. Existing source explicitly recorded these mappings; only the current documented canonical target contract supplies parameters. The plugin advertises each canonical ID once and preserves the host's case-insensitive uniqueness rule. Private compatibility/configuration names do not claim vendor aliases, copy old costs, or expand account discovery results.

No old channel/model is removed. All 17 previously missing Paisio IDs are now rebuilt from the formally enumerated `/v1/contents/generations/tasks` contract and its matching query schema. The source explicitly states equivalence with `/v1/videos`; Grok and sd2 exceptions, prompt limit and six ratios are independently rebuilt, and no undocumented frame fields are inherited. Shared limits remain marked conservative; reference prices are not account costs. XCM's 12 remaining old IDs include three image directory entries without exact model contracts, one published pending-contract video model, one explicitly historical/deprecated audit ID, and seven names without a current mapping. ArtBox's fresh docs/examples still print the terminal object without defining its final artifact field. No key or channel was created and no paid request was made.


## Manual binding and local deployment (2026-10-16)

Model presets are optional once an operator explicitly selects and confirms an already implemented same-provider contract in the model configuration dialog. The host validates the selected mode, pins the private template in the execution snapshot and keeps it for polling. This reuses the compiled submit/upload/query/result code and its limits; JSON mappings cannot invent a new endpoint, upload protocol or output parser. Unknown models are not advertised as supplier-verified. XCM currently has reusable video contracts; its three pending image IDs still lack an implemented reusable image contract in v2.

Discovery only changes visibility. Saved, hand-entered and selected IDs stay editable when temporarily missing, and reappearance does not overwrite hand edits. XCM only explicit current preparing/maintenance/unavailable states block submission; missing/unknown is not a retirement decision. No daily monitor or paid test is created.

Saving configuration does not change channel Models by default. The separate unchecked routing confirmation may atomically append enabled, documented or explicitly confirmed bindings to that channel's Models and abilities. It never removes existing models or changes keys/status. It requires the active reviewed v2 plugin. While a legacy plugin stays active, manually bound configurations are staged and do not alter its existing requests or pricing; the UI says so.

The gateway public names MiniMax-H3 and gpt-image-2-2k/4k preserve existing Hailuo/Cangyuan spelling and the host's global case-insensitive uniqueness. Supplier request IDs remain minimax-h3 and gpt-image-2-2K/4K from their exact reviewed contracts. This is gateway identity handling, not a supplier alias claim. Full factory + seven legacy + six v2 coexistence is regression-tested.

The local host was deployed as local-7ed2b6b95899-six-config-20261016. Paisio, YuxiBox, LXM and Zex are active v2.0.0; XCM and ArtBox keep their previous active versions. No initial price plan, paid generation, XCM migration or ArtBox channel was applied. The actual deployment/restore evidence is in the task workspace local-six-deploy-20261016; artifacts still never install themselves.


## Current local deployment and discovery correction (2026-10-16)

This supersedes the preceding deployment/spelling-workaround status. Current host is local-7ed2b6b95899-six-routing-20261016. Paisio/YuxiBox/XCM/LXM/Zex are active 2.0.1. Original supplier model spelling is preserved; routing, parameters, billing and task snapshots are scoped to the selected channel/plugin. Hailuo/Cangyuan sources are unchanged. Global case renaming is no longer required.

All six generated 2.0.1 artifacts declare model discovery. Paisio/YuxiBox/XCM inherit the old source-backed declarations (historical_declaration), LXM/Zex retain endpoint_snapshot, ArtBox declares standard_unverified with no invented proof. ArtBox's active historical implementation receives only the discovery metadata/version patch 1.1.1; the 2.0.1 execution candidate is staged because the original channel/key and final output contract remain unverified.

Actual existing-channel GET results after deployment: Paisio 102, YuxiBox 22, XCM 12, LXM 56, Zex 32. ArtBox has no original channel/key and was not probed. These are live handler reads, not fixture/catalog counts. User-computer Edge also verified YuxiBox's dialog returned 22, showing 13 new and retaining 9 existing/selected IDs. No configuration was saved in the browser and no paid generation was performed. XCM's 12 pending configured IDs do not disable its two confirmed contracts or other confirmed modes.

Evidence: local-six-routing-20261016 in the Codex task workspace, and juhefuwu migration plan section 25.12. All old source versions, channel keys/models/status and protected business records were retained. An isolated PostgreSQL restore/upgrade/configuration/rollback rehearsal passed before the service switch.


## Channel configuration workflow preview (2026-10-16; not deployed)

The formal channel dialog now supports independent image/video/audio capabilities, capability-scoped fields, a separate per-model field/JSON override dialog, simple markup rules, preserved model-specific sample JSON, and human-readable model-level save review. The editor's normalized catalog exposes only reviewed reference schemas, optional references and documented billing units. Installed immutable 2.0.1 plugin sources are unchanged by these editor-schema changes.

New documented form configurations explicitly reject unknown unmapped inputs; disabled material classes are checked on request aliases, defaults and nested material roles. Existing legacy configuration documents do not silently acquire a new strict-policy flag. Valid input subsets retain configured validation, mapping and billing instead of bypassing overlays. Unknown costs, currencies and units do not become zero or get mixed implicitly; advanced formulas remain preserved.

The isolated page at http://127.0.0.1:13122/ imports the formal React dialog. Its discovery/save adapters use labeled in-memory fixtures. Its input check uses the real controller and immutable YuxiBox 2.0.1 conversion through a localhost-only helper backed by a dedicated test PostgreSQL database. No network fetcher, supplier generation route or real credential is present. Nine actual offline HTTP cases passed, including five legal input subsets and explicit reject/ignore/default diagnostics. Thirty-three formal component tests, backend regressions, type/lint checks, and both builds passed. User-computer Edge acceptance remains a separate final review; no production deployment was switched in this round.


### Final independent review follow-up

The real two-Seedance schema difference (reference-video maxima 3 versus 10) exposed a missing-field defect in the shared intersection editor. The main editor now renders model-specific documented fields alongside shared fields, with independent optional material limits bounded by original contract maxima. Capability switching preserves these edits. Human parameter comparison replaces default technical JSON; original paths remain in a closed advanced section. Thirty-four component regressions, types/lint and both builds passed; nine real offline API cases passed again. The preview is now served by a standalone hidden local Go process on 13122, alongside its offline checker on 13123, rather than a dev-server execution session. Business deployment remains unchanged; repeat user-computer Edge acceptance is pending.


## Historical parameter implementation (2026-10-17, 2.0.2; superseded where conflicting)

`parameter_contracts.py` extracts category, capability membership, supplier field paths, required/conditional/optional status and documented candidates from retained public sources under `evidence/parameters-20261017/`. `build-profiles.py` attaches this contract before `build-catalog.py` and `build-initial-configurations.mjs` derive the editor and review drafts. Required rules are automatic and read-only; optional fields follow selected capabilities. Unresolved document facts retain explicit manual confirmation rather than acquiring generic guessed fields. Duration aliases remain one normalized field with supplier names retained in metadata.

The editor defaults to all selected functions, preserves per-function conflicts, and starts individual edits from the effective public configuration. Optional exclusions differ from restoring inheritance. Save review validates documented choices, defaults, required rules and material alternatives without requiring runtime prompt/media values. Actual request construction remains authoritative for runtime checks.

This minor version contains reviewed parameter corrections only. Pricing schemas, routes and discovery declarations are checked against both the previous candidate and the five actually installed bound providers; all prior immutable plugin sources are retained. ArtBox's active legacy plugin is outside activation scope. Minimax-Meta, Cangyuan and Doubao retain their existing workflow. Source-backed profile support is not an account availability, effective price or paid generation result. Current local deployment and rollback evidence is maintained in the host repository's existing `docs/migration/new-api-channel-sync-20261011.md#parameter-workflow-20261017`; the normative workflow remains `docs/operations/upstream-channel-troubleshooting.md#imported-parameter-workflow`.


### 2026-10-18 · YuxiBox 视频参数识别 2.1.4

本次仅更新 YuxiBox 四份视频请求参数表及其十个文档明确型号的覆盖规则，接口 ID、图片接口、旧执行配置和其他供应商保持。实际渠道型号/保存参数/价格不会由生成器自动改写。参数来源和业务边界继续引用 juhefuwu 的 `docs/operations/upstream-channel-troubleshooting.md#imported-parameter-policy`，不在此重复定义。

使用限定供应商的可复跑入口，避免重生成其他供应商：

```powershell
python plugin-sources/media-providers/six-v2/build-profiles.py --provider=yuxibox_media
python plugin-sources/media-providers/six-v2/build-catalog.py --provider=yuxibox_media
node plugin-sources/media-providers/six-v2/build.mjs --provider=yuxibox_media
python plugin-sources/media-providers/six-v2/yuxibox_contracts_test.py
node --test plugin-sources/media-providers/six-v2/runtime.test.mjs
```

`yuxibox_contracts.py` 对锁定的公开文档快照只做静态解析，不执行下载的 JavaScript。字符串模板、条件表达式必须完整解析；未知表达式、参数表歧义、文档/公开目录型号覆盖变化均中止并要求复核，禁止静默漏字段。JSON 参数与 multipart 上传替代项分别保留；模型约束进入现有 modelRules，不创建模型/路由/计费设置。文档默认值仅为 documentedDefault，沿用既有显式设置流程。

来源与五项待确认冲突在 `evidence/yuxibox-video-20261018/sources.json` 和 `conflicts.json`。两项时长下限冲突不选择新下限覆盖已有设置；三项价格冲突只作证据展示，不导入价格。新版本仅本地发布，原 2.1.3 插件保留供回退与旧任务使用；完整验证/发布续写 juhefuwu 原任务 `docs/migration/new-api-channel-sync-20261011.md#yuxibox-video-recognition-20261018`。


### 2026-10-20 · 统一入口可选参数过滤候选 2.1.5

六家共享文档协议运行时更新：配合既有modelconfig有效渠道型号解析，先过滤不支持可选项，再执行受支持值校验和上游转换。参数来源、明确拒绝及独立限制语义仅引用juhefuwu `docs/operations/upstream-channel-troubleshooting.md#newapi-optional-filtering-20261020`，此处不维护副本。此候选未安装到业务环境，不改保存配置、价格、旧插件或任务；使用保存PI42配置、实际失败字段及本地HTTP接收器隔离验证，不调用收费生成。实现、验证与后续部署状态续写juhefuwu原任务 `docs/migration/new-api-channel-sync-20261011.md#newapi-optional-filtering-20261020`。


同日后续用户授权安装：本地宿主new-api已保留r33功能升级r34，六家2.1.5经管理后台安装并激活。后台源码编辑器统一CRLF为LF，安装hash与原生成字节hash分别记录，后续同版本以实际已装LF产物核对，不能用不同hash覆盖不可变版本。实际安装源码及保存PI42配置的免费隔离Handler检查、最新请求字段无网络回放和浏览器注册状态通过；未调用收费生成或部署正式环境。完整状态、历史来源保留及回退只续写juhefuwu原任务 `docs/migration/new-api-channel-sync-20261011.md#newapi-215-local-install-r34-20261020`。


## 2026-10-23 Paisio artifact download candidate 2.1.6

Paisio prefers its saved public video URL without credentials; absent URLs retain the authenticated content endpoint. Only Paisio is regenerated; selective manifests verify retained file hashes without changing other plugin bytes. The separately authorized generic proxy fix strips credentials/body on GET/HEAD cross-origin redirects and retains SSRF, loop and HTTPS-downgrade checks. Existing tasks keep their original plugin identity. Scope, evidence, validation, deployment state and rollback remain in the [original host task](../../../../juhefuwu/docs/delivery/video-poll-fix-20261012/README.md#assistant-video-download-redirect-20261023). Candidate only; no activation or paid generation.

## XCM video transport identity (2026-10-24, candidate 2.1.6)

XCM video JSON submissions use the existing host-generated `ctx.publicTaskId` as `client_request_id` inside the plugin, for both documented interfaces and legacy profiles. The plugin ignores caller-supplied values and does not generate a new UUID on retries. This supplier-specific transport field is outside optional model parameter policy; other provider artifacts are unchanged. The per-HTTP logging request ID is not the task identity. See the [authoritative host rule and original verification/install status](../../../../juhefuwu/docs/operations/upstream-channel-troubleshooting.md#xcm-generated-request-id-20261024). Build only this candidate with `node plugin-sources/media-providers/six-v2/build.mjs --provider=xcmapi_media`; installation is separate and has not occurred in this task.

## XCM parameter document refresh (2026-10-24, candidate 2.1.6)

`xcm_contracts.py` reads the hash-locked QuickStart, video contract and OpenAPI snapshots in `evidence/xcm-video-20261024/`. Eighteen executable model parameter records become per-model rules on both existing interface IDs; two upstream-reference records do not create rules or bindings. Actual native `h3` retains its independent fields. `xcm-runtime.js` covers documented material combinations after unsupported optional fields are removed. The publisher's conflicting `minimax-h3` resolution table (768p) and prose (2k) is retained as a visible `sourceConflicts` item, with the previous reviewed 2k value unchanged pending clarification.

Refresh only this provider with `python -B plugin-sources/media-providers/six-v2/build-profiles.py --provider=xcmapi_media`, `python -B plugin-sources/media-providers/six-v2/build-catalog.py --provider=xcmapi_media`, then `node plugin-sources/media-providers/six-v2/build.mjs --provider=xcmapi_media`. Other suppliers, legacy models, saved configuration and prices are preserved. The default full legacy import has a pre-existing fixed-hash mismatch and was not repaired by this task; do not bypass that guard. Source/isolated validation is complete; installation, UI checks and paid supplier verification are separate and have not occurred. See the [original host task](../../../../juhefuwu/docs/migration/new-api-channel-sync-20261011.md#xcm-video-parameters-20261024).

## Local installation status (2026-10-25)

XCM 2.1.6 and Paisio 2.1.6 are now installed and active in the local r39 new-api instance. XCM output is canonical LF so its immutable installed-source hash matches the manifest; other supplier artifacts are unchanged. This is a dynamic-plugin deployment, with no binary replacement or channel/price reset. Four actual-engine sandbox checks and source/configuration hashes passed; supplier generation was not called. The minimax-h3 resolution conflict remains pending. Exact versions, hashes, backup and rollback are in the [original local deployment record](../../../../juhefuwu/docs/migration/new-api-channel-sync-20261011.md#media-plugins-local-install-20261025).


## minimax-h3 resolution decision (2026-10-25; candidate only)

The user selected the structured table's exact `768p` value for XCM `minimax-h3`. Both saved document-interface IDs now use it for their model rule and wire enum. The previous 2k override was removed; `sourceResolutions` records the user decision and `sourceConflicts` no longer lists it as pending. Locked publisher snapshots remain unchanged. This supersedes the earlier pending local resolution described above, without claiming that the publisher has corrected its conflicting prose.

XCM 2.1.7 is a new candidate, preserving immutable installed 2.1.6. All 32 offline tests and the selective generator check pass. H3 is not newly bound, enabled, initialized or installed by this change. Other supplier artifacts, legacy execution records, native `h3`, discovery and billing definitions remain unchanged. The active local plugin remains 2.1.6. Decision, scoped diff proof and rollback are in the [original task](../../../../juhefuwu/docs/migration/new-api-channel-sync-20261011.md#xcm-h3-resolution-decision-20261025).


### Local activation of 2.1.7 (2026-10-25)

Following explicit user authorization, XCM 2.1.7 is now installed and active (row 77) in local new-api r39; its source matches the manifest SHA256 `ec812b1357d4bbd0561106f3bf58db9742640224bbd242f113010b570b78caf7`. The management page reports registered. This supersedes the candidate-only status above; candidate manifests themselves remain build metadata. Old 2.1.6 is retained for activation rollback. Channels, model configuration, prices, options, abilities, other plugins and all 16 containers are unchanged. No H3 binding, initialization or enablement was added; no supplier generation or production operation occurred. The [original installation receipt](../../../../juhefuwu/docs/migration/new-api-channel-sync-20261011.md#xcm-h3-resolution-local-install-20261025) contains backup, exact verification and rollback evidence.


### Host routing verification and local r40 (2026-10-25)

The previous plugin load check did not cover the saved-interface routing gate: the running r39 host only reviewed plugin versions through 2.1.5. A real G3-D1 request therefore returned protocol_unsupported before reaching the installed XCM 2.1.7. The user explicitly authorized the minimal host exception; local r40 now registers reviewed 2.1.6 and 2.1.7, while future/prerelease versions stay blocked. Plugin bytes, channel bindings and prices remain unchanged.

Both affected Go packages pass their full regressions. In a restored, internal-network candidate, the same channel/model POST reached XCM 2.1.7 buildSubmitRequest and deliberately failed required-prompt validation without provider transport. The exact tested image is deployed locally; old runtime and data are retained for rollback. Subsequent plugin updates must check the running host's saved-interface routing eligibility as well as plugin registration. Exact source, image, preservation and verification limits are in the [original host task](../../../../juhefuwu/docs/migration/new-api-channel-sync-20261011.md#reviewed-plugin-routing-20261025).
