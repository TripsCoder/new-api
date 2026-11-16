const aliases = {
  duration: 'seconds', duration_seconds: 'seconds', ratio: 'aspect_ratio',
  input_reference: 'images', first_frame: 'start_image_url', last_frame: 'end_image_url',
  reference_video: 'videos', reference_audio: 'audios',
}
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const mediaURL = (value) => typeof value === 'string' && /^https?:\/\/[^/@?#]+(?:[/?][^#]*)?$/i.test(value) &&
  !/[\s\u0000-\u0020\u007f\\]/.test(value)
const imageURL = (value) => mediaURL(value) || (typeof value === 'string' &&
  /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/.test(value) && value.split(',')[1].length % 4 === 0)

function normalizedInput(value) {
  const input = {}
  for (const [name, raw] of Object.entries(value)) {
    const field = own(aliases, name) ? aliases[name] : name
    let item = raw
    if (['images', 'videos', 'audios'].includes(field) && typeof item === 'string') item = [item]
    if (field === 'resolution' && typeof item === 'string') item = item.toLowerCase()
    if (own(input, field) && JSON.stringify(input[field]) !== JSON.stringify(item)) {
      throw new Error('参数别名冲突：' + field)
    }
    if (field !== '__proto__') input[field] = item
  }
  return input
}

function submission(ctx) {
  const request = ctx.requestBody
  if (!isObject(request?.input) || request.operation !== 'video_generate' ||
    (request.protocolTemplate && request.protocolTemplate !== contract.interfaceId)) {
    throw new Error('请选择笑笑中转 /v1/videos 视频接口')
  }
  const model = ctx.upstreamModel || ctx.model
  if (!own(contract.modelOptions, model)) throw new Error('笑笑中转视频型号尚未适配')
  const options = contract.modelOptions[model]
  const input = normalizedInput(request.input)
  const { seconds, resolution, size, output_count: outputCount } = input
  if (!Number.isInteger(seconds) || seconds < 4 || seconds > options.maxSeconds) {
    throw new Error('duration 必须是 4–' + options.maxSeconds + ' 秒的整数')
  }
  if (outputCount !== undefined && outputCount !== 1) throw new Error('output_count 仅支持 1')
  if (resolution !== undefined && !contract.resolutions.includes(resolution)) throw new Error('不支持该 resolution')
  if (size !== undefined && (size !== '1280x720' || resolution !== undefined)) {
    throw new Error('size 首版支持 1280x720，请与 resolution 二选一')
  }
  const body = { model, duration: seconds, output_count: 1 }
  if (resolution !== undefined) body.resolution = resolution
  if (size !== undefined) body.size = size
  for (const field of ['prompt', 'aspect_ratio']) {
    if (input[field] === undefined) continue
    if (typeof input[field] !== 'string' || !input[field].trim()) throw new Error(field + ' 必须是非空字符串')
    body[field] = input[field]
  }
  if (input.generate_audio !== undefined) {
    if (typeof input.generate_audio !== 'boolean') throw new Error('generate_audio 必须是布尔值')
    body.generate_audio = input.generate_audio
  }
  for (const [field, vendor, validate] of [
    ['images', 'input_reference', imageURL],
    ['videos', 'reference_video', mediaURL],
    ['audios', 'reference_audio', mediaURL],
  ]) {
    const values = input[field]
    if (values === undefined || (Array.isArray(values) && values.length === 0)) continue
    if (!Array.isArray(values) || !values.every(validate) ||
      (field !== 'images' && values.length !== 1)) throw new Error(vendor + ' 素材格式或数量不受支持')
    body[vendor] = field === 'images' ? values : values[0]
  }
  for (const [field, vendor] of [['start_image_url', 'first_frame'], ['end_image_url', 'last_frame']]) {
    if (input[field] === undefined) continue
    if (!imageURL(input[field])) throw new Error(vendor + ' 必须是图片 URL 或图片 Data URL')
    body[vendor] = input[field]
  }
  if (options.requiresFrame && !body.first_frame && !body.last_frame) {
    throw new Error('h3-video-frames 至少需要 first_frame 或 last_frame')
  }
  if (!body.prompt && !body.input_reference && !body.reference_video && !body.reference_audio && !body.first_frame && !body.last_frame) {
    throw new Error('请提供提示词或该型号支持的参考素材')
  }
  return body
}

function apiRequest(ctx, path) {
  const base = String(ctx.baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '')
  if (!mediaURL(base) || /[?#]/.test(base)) throw new Error('请配置有效的笑笑中转渠道地址')
  const token = String(ctx.authHeader || ctx.apiKey || '').replace(/^Bearer +/i, '')
  if (!token || /[\s\u0000-\u001f\u007f]/.test(token)) throw new Error('渠道 API 密钥缺失或无效')
  return { url: base + path, headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } }
}

function taskID(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new Error('上游视频任务 ID 缺失或无效')
  return value
}

export function buildSubmitRequest(ctx) {
  const request = apiRequest(ctx, contract.createPath)
  request.headers['Content-Type'] = 'application/json'
  return { ...request, method: 'POST', body: submission(ctx) }
}

export function buildQueryRequest(ctx) {
  return { ...apiRequest(ctx, contract.createPath + '/' + taskID(ctx.taskId)), method: 'GET' }
}

function resultURL(data) {
  return ['completed', 'succeeded'].includes(data?.status) && mediaURL(data.url) ? data.url : ''
}

export function parseTaskResult(ctx, body) {
  if (!isObject(body) || (ctx.taskId && body.id !== undefined && body.id !== ctx.taskId)) {
    return { status: 'UNKNOWN', reason: '上游视频任务响应缺失或任务 ID 不匹配' }
  }
  switch (body.status) {
    case 'queued': return { status: 'QUEUED' }
    case 'in_progress': return { status: 'IN_PROGRESS' }
    case 'completed':
    case 'succeeded': {
      const url = resultURL(body)
      return url ? { status: 'SUCCESS', progress: '100%', url } : { status: 'UNKNOWN', reason: '成功响应缺少有效视频 URL' }
    }
    case 'failed':
    case 'cancelled':
    case 'canceled': {
      let reason = typeof body.error?.message === 'string' ? body.error.message : '上游视频任务失败'
      for (const secret of [ctx.apiKey, ctx.authHeader]) {
        if (secret) reason = reason.split(secret).join('[redacted]')
      }
      reason = reason.replace(/https?:\/\/\S+/gi, '[URL]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
      return { status: 'FAILURE', progress: '100%', reason: reason.slice(0, 1024) }
    }
    default: return { status: 'UNKNOWN', reason: '无法识别上游视频任务状态' }
  }
}

export function parseSubmitResponse(ctx, response) {
  const body = response.body
  const id = taskID(body?.id)
  const result = parseTaskResult(ctx, body)
  if (result.status === 'SUCCESS' || result.status === 'FAILURE') {
    return { taskId: id, taskData: body, immediate: result }
  }
  // Once the supplier gives an ID, continue polling even if its receipt did not report a usable state.
  return { taskId: id, taskData: body }
}

export function extractUsage(ctx) {
  if (ctx.usagePurpose === 'billing_ratios') throw new Error('请先配置笑笑中转视频计费表达式')
  const body = submission(ctx)
  // Completion usage has not been verified. Keep the request facts frozen.
  return { seconds: body.duration, billable_seconds: body.duration, resolution: body.resolution ?? (body.size ? '720p' : '768p') }
}

export function listArtifacts(task) {
  return task.status === 'SUCCESS' && resultURL(task.data) ? [{ key: 'video', type: 'video' }] : []
}

export function buildContentRequest(ctx) {
  const url = ctx.status === 'SUCCESS' && ctx.artifactKey === 'video' ? resultURL(ctx.data) : ''
  if (!url) throw new Error('视频产物不可用')
  return { url, method: ctx.clientRequest?.method === 'HEAD' ? 'HEAD' : 'GET', credentialless: true }
}

export const protocols = {
  openai_video: {
    decodeRequest(ctx) {
      if (ctx.body?.kind !== 'json' || !isObject(ctx.body.value)) throw new Error('笑笑中转视频首版使用 JSON 请求')
      return { kind: 'submit', model: ctx.model, action: 'video_generate',
        requestBody: { operation: 'video_generate', input: normalizedInput(ctx.body.value), uploads: [] } }
    },
    render(_ctx, task) {
      if (task.status === 'FAILURE') return { error: { code: 'video_generation_failed', message: task.fail_reason || '上游视频任务失败' } }
      return task.status === 'SUCCESS' ? { url: resultURL(task.data) } : {}
    },
  },
}
