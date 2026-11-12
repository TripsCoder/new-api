const basePath = '/ai-open-platform-api'
const maxVideoSeconds = 30
const maxReferenceVideoSeconds = 15
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const rules = meta.parameterInterfaces[contract.interfaceId].parameters
const mediaByType = Object.fromEntries(
  Object.entries(contract.mediaFields).map(([field, entry]) => [entry.type, field])
)

function mediaURL(value) {
  return typeof value === 'string' &&
    !/[\u0000-\u0020\u007f\\]/.test(value) &&
    /^https?:\/\/[^/@?#]+(?:[/?][^#]*)?$/i.test(value)
}

function decodeInput(value) {
  const input = { ...value }
  const assign = (key, data) => {
    if (key === 'resolution' && typeof data === 'string') data = data.toUpperCase()
    if (own(input, key) && JSON.stringify(input[key]) !== JSON.stringify(data)) {
      throw new Error(key + ' 的参数值冲突')
    }
    input[key] = data
  }
  if (typeof input.resolution === 'string') input.resolution = input.resolution.toUpperCase()
  for (const [alias, field] of Object.entries({
    duration: 'seconds',
    duration_seconds: 'seconds',
    ratio: 'aspect_ratio',
    audio: 'generate_audio',
    first_frame: 'start_image_url',
    first_frame_image: 'start_image_url',
    input_reference: 'start_image_url',
    last_frame: 'end_image_url',
    last_frame_image: 'end_image_url',
  })) {
    if (own(input, alias)) {
      assign(field, input[alias])
      delete input[alias]
    }
  }
  const order = []
  const nested = value.input
  const settings = value.parameters
  if (nested !== undefined && !object(nested)) throw new Error('input 必须为对象')
  if (settings !== undefined && !object(settings)) throw new Error('parameters 必须为对象')
  if (nested && own(nested, 'prompt')) assign('prompt', nested.prompt)
  for (const [field, vendor] of Object.entries(contract.settings)) {
    if (settings && own(settings, vendor)) assign(field, settings[vendor])
  }
  if (nested && own(nested, 'media')) assign('media', nested.media)
  if (own(input, 'media')) {
    if (!Array.isArray(input.media)) throw new Error('input.media 必须为数组')
    const byField = {}
    for (const item of input.media) {
      if (!object(item) || !own(mediaByType, item.type)) throw new Error('input.media 包含未知素材类型')
      const field = mediaByType[item.type]
      const entries = byField[field] ??= []
      order.push([field, entries.length])
      entries.push(item.url)
    }
    for (const [field, entries] of Object.entries(byField)) {
      if (!contract.mediaFields[field].array && entries.length > 1) {
        throw new Error(field + ' 最多提供一项')
      }
      assign(field, contract.mediaFields[field].array ? entries : entries[0])
    }
  }
  delete input.input
  delete input.media
  delete input.parameters
  return { input, order }
}

function submitBody(ctx) {
  const request = ctx.requestBody
  if (!object(request?.input) || request.operation !== 'video_generate' ||
    (request.protocolTemplate && request.protocolTemplate !== contract.interfaceId)) {
    throw new Error('请选择筷子科技万相视频接口')
  }
  const model = ctx.upstreamModel || ctx.model
  if (!meta.models.includes(model)) throw new Error('筷子接口不接受此上游型号')
  const input = request.input
  const content = {}
  if (input.prompt !== undefined) {
    if (typeof input.prompt !== 'string' || [...input.prompt].length > rules.prompt.definition.maxLength) {
      throw new Error('prompt 必须为不超过 20000 字符的字符串')
    }
    if (input.prompt.trim()) content.prompt = input.prompt
  }

  const fields = {}
  for (const [name, entry] of Object.entries(contract.mediaFields)) {
    if (!own(input, name)) continue
    const items = entry.array ? input[name] : [input[name]]
    if (!Array.isArray(items) || items.length > entry.max || items.some((item) => !mediaURL(item))) {
      throw new Error(name + ' 必须为符合数量限制的公开 HTTP(S) URL')
    }
    if (items.length) fields[name] = items.map((url) => ({ type: entry.type, url }))
  }
  const frames = fields.start_image_url || fields.end_image_url
  if (frames && ['images', 'videos', 'audios', 'file_url', 'link_url'].some((key) => fields[key])) {
    throw new Error('首尾帧不能与参考素材混用')
  }
  if (fields.file_url && fields.link_url) throw new Error('参考文件和网页链接不能同时提交')

  // Reassemble the input order after the host applies capability and field policies.
  const media = []
  for (const [field, index] of request.mediaOrder || []) {
    const item = fields[field]?.[index]
    if (item) {
      media.push(item)
      fields[field][index] = null
    }
  }
  for (const items of Object.values(fields)) media.push(...items.filter(Boolean))
  if (media.length) content.media = media
  if (!content.prompt && !media.length) throw new Error('提示词和素材至少提供一项')

  const parameters = {}
  const unrestricted = new Set(request.unrestrictedValueFields || [])
  for (const [name, vendor] of Object.entries(contract.settings)) {
    if (!own(input, name)) continue
    const value = input[name]
    const rule = rules[name].definition
    if (rule.type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== rule.type) {
      throw new Error(name + ' 的参数类型无效')
    }
    if (name === 'seconds' && value !== -1 && (value < 2 || value > maxVideoSeconds)) {
      throw new Error('duration 必须为 -1 或 2 至 30 秒之间的整数')
    }
    // Duration and resolution affect charging, so both retain their safety
    // bounds even when the administrator disables other documented limits.
    if (name === 'resolution' || !unrestricted.has(name)) {
      if ((rule.enum && !rule.enum.includes(value)) ||
        (rule.minimum !== undefined && value < rule.minimum) ||
        (rule.maximum !== undefined && value > rule.maximum)) {
        throw new Error(name + ' 超出文档允许范围')
      }
    }
    parameters[vendor] = value
  }
  return { model, input: content, ...(Object.keys(parameters).length ? { parameters } : {}) }
}

function apiRequest(ctx, path) {
  const base = String(ctx.baseUrl || '').replace(/\/+$/, '')
  if (!base.endsWith(basePath) || !/^https:\/\/[^\s/@?#\\]+$/.test(base.slice(0, -basePath.length))) {
    throw new Error('请配置 HTTPS 渠道地址，路径为 /ai-open-platform-api')
  }
  const credential = ctx.authHeader || ctx.apiKey || ''
  const token = credential.replace(/^Bearer +/i, '')
  if (!token || /[\s\u0000-\u001f\u007f]/.test(token)) throw new Error('渠道 API 密钥缺失或无效')
  return { url: base + path, method: 'GET', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } }
}

function taskID(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value) || /\s/.test(value)) {
    throw new Error('筷子任务 ID 缺失或无效')
  }
  return value
}

export function buildSubmitRequest(ctx) {
  const body = submitBody(ctx)
  // encodeURIComponent counts UTF-8 bytes after collapsing each percent escape.
  if (encodeURIComponent(JSON.stringify(body)).replace(/%[0-9A-F]{2}/g, 'x').length > 4 * 1024 * 1024) {
    throw new Error('视频请求超过 4 MB')
  }
  const request = apiRequest(ctx, contract.createPath)
  request.method = 'POST'
  request.headers['Content-Type'] = 'application/json'
  request.headers['X-DashScope-Async'] = 'enable'
  request.body = body
  return request
}

export function buildQueryRequest(ctx) {
  return apiRequest(ctx, contract.queryPath + encodeURIComponent(taskID(ctx.taskId)))
}

function videoURL(body) {
  const { kz_video_url: archived, video_url: original } = body?.output || {}
  for (const url of [archived, original]) {
    // The documented archive path is distinct from the temporary signed OSS URL.
    if (mediaURL(url) && /\/ai_openapi\/[^?]+$/.test(url)) return url
  }
  if (mediaURL(original)) return original
  return mediaURL(archived) ? archived : ''
}

function failureReason(ctx, body) {
  const output = body?.output || {}
  const code = typeof output.code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(output.code) ? output.code : ''
  const message = typeof output.message === 'string' ? output.message : '上游视频任务失败'
  let reason = code ? code + ': ' + message : message
  for (const credential of [ctx.apiKey, ctx.authHeader]) {
    if (typeof credential === 'string' && credential) {
      reason = reason.split(credential).join('[redacted]')
    }
  }
  reason = reason.replace(/https?:\/\/\S+/gi, '[URL]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  return reason.slice(0, 1024)
}

export function parseTaskResult(ctx, body) {
  const output = body?.output
  if (!object(output) || (ctx.taskId && output.task_id && output.task_id !== ctx.taskId)) {
    return { status: 'UNKNOWN', reason: '筷子任务响应缺失或任务 ID 不匹配' }
  }
  switch (output.task_status) {
    case 'PENDING': return { status: 'QUEUED' }
    case 'RUNNING': return { status: 'IN_PROGRESS' }
    case 'FAILED':
    case 'CANCELED':
      return { status: 'FAILURE', progress: '100%', reason: failureReason(ctx, body) }
    case 'SUCCEEDED': {
      const url = videoURL(body)
      if (url) return { status: 'SUCCESS', progress: '100%', url }
      return { status: 'UNKNOWN', reason: '成功响应缺少有效视频地址' }
    }
    default:
      return { status: 'UNKNOWN', reason: '无法识别筷子任务状态' }
  }
}

export function parseSubmitResponse(ctx, response) {
  const body = response.body
  const id = taskID(body?.output?.task_id)
  const result = parseTaskResult(ctx, body)
  if (result.status === 'SUCCESS' || result.status === 'FAILURE') {
    return { taskId: id, taskData: body, immediate: result }
  }
  return { taskId: id, taskData: body }
}

export function extractUsage(ctx) {
  if (ctx.usagePurpose === 'billing_ratios') throw new Error('请先配置筷子视频计费表达式')
  const body = submitBody(ctx)
  const duration = body.parameters?.duration ?? rules.seconds.definition.documentedDefault
  const hasVideo = body.input.media?.some((item) => item.type === 'reference_video')
  return {
    seconds: hasVideo || duration === -1 ? maxVideoSeconds : duration,
    resolution: body.parameters?.resolution ?? rules.resolution.definition.documentedDefault,
  }
}

export function extractUsageOnComplete(_ctx, result, body) {
  if (result.status !== 'SUCCESS' || body?.output?.task_status !== 'SUCCEEDED') return {}
  const { input_video_duration: input, output_video_duration: output, SR: tier } = body.usage || {}
  if (!Number.isFinite(input) || input < 0 || input > maxReferenceVideoSeconds ||
    !Number.isFinite(output) || output <= 0 || input + output > maxVideoSeconds) return {}
  const resolution = String(tier ?? '').toUpperCase().replace(/^(\d+)$/, '$1P')
  return {
    seconds: input + output,
    ...(meta.usageSchema.resolution.enum.includes(resolution) ? { resolution } : {}),
  }
}

export function listArtifacts(task) {
  return task.status === 'SUCCESS' && videoURL(task.data) ? [{ key: 'video', type: 'video' }] : []
}

export function buildContentRequest(ctx) {
  const url = ctx.status === 'SUCCESS' && ctx.artifactKey === 'video' ? videoURL(ctx.data) : ''
  if (!url) throw new Error('视频结果不可用')
  return { url, method: ctx.clientRequest?.method === 'HEAD' ? 'HEAD' : 'GET', credentialless: true }
}

export const protocols = {
  openai_video: {
    decodeRequest(ctx) {
      if (ctx.body?.kind !== 'json' || !object(ctx.body.value)) {
        throw new Error('筷子视频仅支持 JSON 和公开 HTTP(S) 素材 URL')
      }
      const { input, order } = decodeInput(ctx.body.value)
      return {
        kind: 'submit',
        model: ctx.model,
        action: 'video_generate',
        requestBody: { operation: 'video_generate', input, uploads: [], mediaOrder: order },
      }
    },
    render(_ctx, task) {
      if (task.status === 'FAILURE') {
        return { error: { code: 'video_generation_failed', message: task.fail_reason || '上游视频任务失败' } }
      }
      return task.status === 'SUCCESS' ? { url: videoURL(task.data) } : {}
    },
  },
}
