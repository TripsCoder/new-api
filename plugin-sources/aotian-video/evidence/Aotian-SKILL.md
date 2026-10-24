---
name: aotian-video-api
description: 对接 AoTian 视频生成 API 的通用技能。用于创建、查询、轮询、下载视频任务，提交图片/视频/音频参考素材，处理模型列表、任务状态、结果 URL、鉴权和常见错误。适用于需要通过 https://aotianzz.xyz 接入视频生成能力的客户端、脚本或应用。
---

# AoTian 视频 API

使用公共 New API 视频接口完成视频生成。所有请求都发往统一 API 地址。

## 连接信息

- API 基础地址：`https://aotianzz.xyz`
- 鉴权：`Authorization: Bearer <NEW_API_TOKEN>`
- 请求格式：JSON；仅在需要上传单张本地图片时使用 `multipart/form-data`
- 请求体上限：220 MB（`/v1/*`）
- API Key 只放在服务端，不写入浏览器公开代码。

## 标准流程

1. `GET /v1/models`，读取当前令牌可用的模型名称。
2. `POST /v1/videos`，提交 `model`、`prompt` 及模型支持的参数。
3. 保存响应中的完整 `id`（形如 `task_xxx`）。
4. 每 5–10 秒调用 `GET /v1/videos/{id}`，直到 `status` 为 `completed` 或 `failed`。
5. `completed` 时响应一定带 `url`，直接用于视频预览和下载。
6. 不必调用 `GET /v1/videos/{id}/content`；`url` 即最终文件地址。

创建成功只代表任务已受理。客户端超时不会取消任务，避免重复提交造成重复计费。

## AI 接入执行方式

接入任务应按一个完整流程完成：先加载环境变量并调用 `GET /v1/models` 验证连接，再实现创建、保存任务 ID、轮询、失败处理和结果预览/下载，最后运行一次完整链路测试。不要把"只开发创建接口"和"之后再补查询接口"当作两个互相独立的接入阶段。测试前确认测试任务、费用和素材范围；连接验证可以先使用不产生生成费用的模型列表请求。

## 查询模型

```bash
curl -sS https://aotianzz.xyz/v1/models \
  -H 'Authorization: Bearer sk-YOUR_TOKEN'
```

只使用模型列表返回的 `id`。模型可见性、时长、分辨率、参考素材数量和价格由账号权限及模型能力决定，不要猜测未返回的模型或参数。

## 创建任务：JSON（推荐）

```bash
curl --fail-with-body -sS https://aotianzz.xyz/v1/videos \
  -H 'Authorization: Bearer sk-YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  --data '{
    "model": "MODEL_ID_FROM_V1_MODELS",
    "prompt": "海边日落，镜头缓慢推进，电影质感",
    "seconds": "5",
    "size": "16:9",
    "resolution": "720p",
    "images": ["https://media.example/reference.jpg", "https://media.example/reference2.jpg"]
  }'
```

常用字段：

- `model`：必填，模型列表中的模型名。
- `prompt`：必填，非空提示词。
- `seconds`：字符串时长，例如 `"5"`；接口硬上限 3600，实际范围由模型决定。**部分模型固定时长并忽略该值**（如 `sh-seedance-2.5-720p` 固定输出 30 秒）。
- `duration`：整数时长别名；不要与 `seconds` 传入冲突值。
- `size`：画面宽高比，直接传 `"16:9"`、`"9:16"`、`"1:1"`、`"4:3"`、`"3:4"` 或 `"21:9"`，具体支持范围由模型决定。不要在客户端换算成像素尺寸，也不要改用 `ratio` 字段。
- `resolution`：独立的清晰度字段，例如 `"480p"`、`"720p"` 或 `"1080p"`，必须选择模型支持的档位。新接入统一使用 `resolution`，不使用 `resolution_name`。
- 参考图片：**多张图片必须使用 JSON 的 `images` 公开 HTTPS URL 数组**。单张可用 `image` / `input_reference`。
- `reference_image_urls`：图片 URL 数组别名。
- `reference_videos`、`reference_audios`：参考视频或音频 URL 数组，仅在模型支持时使用。
- `input_video`、`input_audio`：兼容字段，仅在模型说明允许时使用。
- `metadata`：结果附加信息容器，不要依赖任意自定义键。

JSON 请求体会**完整透传**到模型渠道，以上字段名渠道端均可识别；渠道不支持的字段会被忽略而不会报错，因此"传了但无效"时先核对模型能力。

`size: "16:9"` 只表示比例，不保证输出恰好为 `1280x720`。比例与清晰度分别设置：横屏 1080p 可传 `size: "16:9"`、`resolution: "1080p"`；竖屏 720p 可传 `size: "9:16"`、`resolution: "720p"`，前提是模型支持。最终像素尺寸以生成文件为准。既有像素尺寸请求保留兼容，但新代码和示例使用比例值。JSON 与 multipart 使用同样的 `size` 和 `resolution` 字段。

URL 必须在排队和处理期间可访问，使用 HTTPS、正确的媒体 MIME 类型和足够长的有效期。不要传本地路径、`blob:` 地址、`data:` 地址、控制台页面或需要登录 Cookie 的网页。

## 本地文件 → 公网 URL：素材上传接口

需要以本地文件作为参考素材时，先上传得到公开 HTTPS URL，再走 JSON 创建任务。使用同一个 Bearer 令牌。

```bash
curl --fail-with-body -sS https://image.aotianzz.xyz/api/media-upload \
  -H 'Authorization: Bearer sk-YOUR_TOKEN' \
  -H 'Content-Type: image/png' \
  --data-binary @./reference.png
```

- 请求体为文件原始字节，`Content-Type` 必须是真实 MIME。
- 支持：图片 `image/jpeg`、`image/png`、`image/webp`；视频 `video/mp4`、`video/quicktime`、`video/webm`；音频 `audio/mpeg`、`audio/wav`、`audio/mp4`、`audio/ogg`。
- 单文件上限 600 MB。
- 返回 `{"url": "...", "key": "...", "bytes": N, "mimeType": "..."}`，把 `url` 放进 `images` / `reference_videos` / `reference_audios`。
- 令牌无效返回 401。

## 创建任务：multipart（仅单张本地图片）

multipart **只支持一个 `input_reference` 文件字段，且只能出现一次**。重复同名文件字段只会转发第一个文件；其它文件字段名会被拒绝。需要多张参考图请使用上面的上传接口 + JSON `images`。不要手动设置 `Content-Type`，让 cURL 或浏览器 FormData 自动生成 boundary。

```bash
curl --fail-with-body -sS https://aotianzz.xyz/v1/videos \
  -H 'Authorization: Bearer sk-YOUR_TOKEN' \
  -F 'model=MODEL_ID_FROM_V1_MODELS' \
  -F 'prompt=让参考图中的主体自然运动' \
  -F 'seconds=5' \
  -F 'size=16:9' \
  -F 'resolution=720p' \
  -F 'input_reference=@./reference.png;type=image/png'
```

multipart 中每个文本字段也只能出现一次。不要把 JSON 字符串形式的数组作为一个字符串字段提交。

## 查询任务

```bash
curl -sS https://aotianzz.xyz/v1/videos/task_EXAMPLE \
  -H 'Authorization: Bearer sk-YOUR_TOKEN'
```

`status` 取值：

- `queued`：已受理，排队中。
- `in_progress`：生成中，`progress` 为 0–100。
- `processing`：上游已生成完毕，正在归档到结果存储；**继续轮询**，很快会变为 `completed`。
- `completed`：完成，响应**一定包含** `url`（同时有 `video_url`、`result_url`、`metadata.url`，值相同）。
- `failed`：失败，`error.message` 为可展示给用户的原因，`error.code` 为错误码。

成功响应示例：

```json
{
  "id": "task_EXAMPLE",
  "object": "video",
  "model": "MODEL_ID",
  "status": "completed",
  "progress": 100,
  "created_at": 1789516048,
  "completed_at": 1789516494,
  "url": "https://video.aotianzz.xyz/videos/2026/09/15/task_EXAMPLE.mp4"
}
```

失败响应示例：

```json
{
  "id": "task_EXAMPLE",
  "object": "video",
  "status": "failed",
  "progress": 100,
  "error": { "message": "出于肖像保护考虑，未认证人脸暂不支持生成视频。", "code": "video_generation_failed" }
}
```

保存响应中的 `url`。播放器或下载器应直接使用该 URL，不要自行拼接文件路径。`url` 为长期有效的公开地址，无需鉴权。

## 耗时与超时

- 成功任务从提交到完成通常 **10–25 分钟**（近期平均 17 分钟、90 分位 21 分钟），个别可达数小时。
- 轮询上限建议 **不少于 60 分钟**。到达上限时只停止轮询并保留任务 ID，**不要重新创建**；稍后可继续用同一 ID 查询。
- `progress` 长时间不变属正常，不代表失败。

## 失败处理

- `failed` 时把 `error.message` 原样展示给用户。常见原因：参考图人脸未认证、素材/提示词涉及版权、提示词表达错误、上游生成失败。这类失败**重试同样的输入不会成功**，应提示用户更换素材或提示词。
- 只有 `error.message` 明确为"请稍后重试"、"超时"类文案时才自动重试，且间隔至少 1 分钟。
- 失败任务的费用会自动退回，不需要客户端处理。

## 错误处理（HTTP 状态码）

- `400`：参数、模型、提示词、时长、素材数量或格式不符合要求；**任务 ID 不存在或不属于当前令牌也返回 400**（`code: task_not_exist`）。读取错误后修正请求，不要重试原请求。
- `401` / `403`：令牌无效、无权限或素材 URL 无法访问；检查令牌和 URL 权限。
- `404`：路径错误；模型不可用时上游可能透传 404，视为不可重试。
- `409`：仅出现在 `/content` 路径，表示归档未完成；用 `GET /v1/videos/{id}` 轮询代替。
- `413` / `415`：文件过大或 MIME/格式不支持；压缩或转换素材。
- `429`：接口频率或并发受限；降低并发并退避。
- `503`：**边缘限流**（每 IP 10 请求/秒、突发 30、并发 30）或服务临时不可用；退避 1–5 秒重试查询，创建请求需先查询是否已受理再决定是否重建。
- `500` / `502` / `504`：临时服务或网络异常；先用已保存的任务 ID 查询，再决定是否重试创建。

保留任务 ID、HTTP 状态码和响应头 `X-Oneapi-Request-Id` 便于排查。不要记录或公开 API Key、签名 URL 和私人素材地址。
