const scalarFields = ['prompt', 'n', 'size', 'quality']
const imageFields = ['image', 'image[]', 'images']
const maxUploadBytes = 32 * 1024 * 1024
const own = (object, field) => Object.prototype.hasOwnProperty.call(object, field)
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function modelOptions(model, edit) {
  if (!own(contract.modelOptions, model)) throw new Error('Monkeyapi 型号不在已适配目录中')
  const options = contract.modelOptions[model]
  if (edit && !options.edit) throw new Error('此 Monkeyapi 型号不支持改图')
  return options
}

function decodeRequest(ctx) {
  const { body, operation } = ctx
  if (operation !== 'generate' && operation !== 'edit') throw new Error('不支持此图片操作')
  const edit = operation === 'edit'
  modelOptions(ctx.upstreamModel || ctx.model, edit)
  const input = {}
  const uploads = []
  if (edit) {
    if (body?.kind !== 'multipart') throw new Error('Monkeyapi 改图仅接受 multipart 文件上传')
    for (const field of scalarFields) {
      const values = body.fields[field] || []
      if (values.length > 1) throw new Error(field + ' 只能传一次')
      if (values.length) input[field] = values[0]
    }
    if (own(input, 'n')) {
      if (!/^[0-9]+$/.test(input.n)) throw new Error('n 必须为整数')
      input.n = Number(input.n)
    }
    if (body.fields.stream?.some(value => value !== 'false')) throw new Error('Monkeyapi 首版使用同步 JSON 响应')
    if ([...imageFields, 'mask'].some(field => own(body.fields, field))) {
      throw new Error('参考图和蒙版必须为文件')
    }
    const images = []
    let referenceField = ''
    for (const file of body.files) {
      if (imageFields.includes(file.field)) {
        if (referenceField && file.field !== referenceField) throw new Error('参考图文件须统一使用一个字段名')
        referenceField = file.field
        images.push(file.ref)
      }
      else if (file.field === 'mask' && !own(input, 'mask')) input.mask = file.ref
      else throw new Error('改图包含重复蒙版或未知文件字段')
      uploads.push({ ref: file.ref, field: file.field, mimeType: file.mimeType, size: file.size })
    }
    if (!images.length) throw new Error('改图至少需要一张参考图')
    input.images = images
  } else {
    if (body?.kind !== 'json' || !isObject(body.value)) throw new Error('Monkeyapi 生图需要 JSON 请求')
    if (body.value.stream === true) throw new Error('Monkeyapi 首版使用同步 JSON 响应')
    for (const field of scalarFields) if (own(body.value, field)) input[field] = body.value[field]
  }
  return {
    kind: 'submit', model: ctx.model, action: edit ? 'image_edit' : 'image_generate',
    requestBody: { operation: edit ? 'image_edit' : 'image_generate', input, uploads },
  }
}

function submissionFields(ctx) {
  const body = ctx.requestBody
  if (!isObject(body?.input) || (body.operation !== 'image_generate' && body.operation !== 'image_edit')) {
    throw new Error('Monkeyapi 图片请求无效')
  }
  if (body.protocolTemplate && body.protocolTemplate !== contract.interfaceId) {
    throw new Error('Monkeyapi 图片协议绑定无效')
  }
  const edit = body.operation === 'image_edit'
  const model = ctx.upstreamModel || ctx.model
  const options = modelOptions(model, edit)
  const input = body.input
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 65536) {
    throw new Error('prompt 必须为非空字符串且最多占 64 KiB')
  }
  if (/[^\x00-\x7F]/.test(input.prompt)) {
    const encoded = utils.base64(input.prompt)
    const padding = encoded.endsWith('==') ? 2 : Number(encoded.endsWith('='))
    if (encoded.length * 3 / 4 - padding > 65536) throw new Error('prompt 超过 64 KiB')
  }
  const n = own(input, 'n') ? input.n : 1
  if (!Number.isInteger(n) || n < 1 || n > options.maxCount) throw new Error('n 超出此型号的张数限制')
  const fields = { model, prompt: input.prompt }
  if (!options.basicGeneration || own(input, 'n')) fields.n = n
  if (own(input, 'size')) {
    if (typeof input.size !== 'string' || !/^(auto|[1-9][0-9]{1,4}x[1-9][0-9]{1,4})$/.test(input.size)) {
      throw new Error('size 必须为 宽x高 或 auto')
    }
    if (input.size !== 'auto' || !options.responseFormat) fields.size = input.size
  }
  if (options.quality && own(input, 'quality')) {
    if (!options.quality.includes(input.quality)) throw new Error('此型号不支持所选 quality')
    fields.quality = input.quality
    if (model === 'dall-e-3') fields.quality = ['hd', 'high'].includes(input.quality) ? 'hd' : 'standard'
  }
  if (options.outputFormat) fields.output_format = options.outputFormat
  if (options.responseFormat) fields.response_format = options.responseFormat
  return { fields, edit, options, n }
}

function multipartParts(ctx, fields, options) {
  const { input, uploads } = ctx.requestBody
  if (!Array.isArray(input.images) || !input.images.length || input.images.length > options.maxReferences) {
    throw new Error('参考图数量超出此型号限制')
  }
  const parts = Object.entries(fields).map(([name, value]) => ({ name, value: String(value) }))
  const referenceField = input.images.length === 1 ? 'image' : 'image[]'
  const refs = new Set()
  let total = 0
  for (const [name, ref] of [
    ...input.images.map(ref => [referenceField, ref]),
    ...(own(input, 'mask') ? [['mask', input.mask]] : []),
  ]) {
    const file = uploads.find(file => file.ref === ref)
    if (!file || refs.has(ref) || (name === 'mask' ? file.field !== 'mask' : !imageFields.includes(file.field))) {
      throw new Error('参考图或蒙版必须引用本次上传的文件')
    }
    const mime = String(file.mimeType || '').toLowerCase().split(';')[0].trim()
    const format = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mime]
    if (!format || ((name === 'mask' || options.pngOnly) && format !== 'png')) {
      throw new Error('参考图或蒙版的媒体类型不符合此型号要求')
    }
    refs.add(ref)
    total += file.size
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > (options.maxFileBytes || maxUploadBytes) || total > maxUploadBytes) {
      throw new Error('参考图或蒙版超出上传大小限制')
    }
    parts.push({ name, fileRef: ref, filename: 'upload-' + refs.size + '.' + format })
  }
  return parts
}

export function buildSubmitRequest(ctx) {
  const { fields, edit, options } = submissionFields(ctx)
  const base = String(ctx.baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '')
  const token = String(ctx.authHeader || ctx.apiKey || '').trim().replace(/^Bearer +/i, '')
  if (!token || /[\r\n]/.test(token)) throw new Error('Monkeyapi 渠道缺少有效的 API Key')
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' }
  if (edit) {
    return { method: 'POST', url: base + contract.paths.edit, headers, bodyType: 'multipart', parts: multipartParts(ctx, fields, options) }
  }
  headers['Content-Type'] = 'application/json'
  return { method: 'POST', url: base + contract.paths.generate, headers, body: fields }
}

function imageResult(body) {
  if (!isObject(body) || body.error || body.success === false || (own(body, 'code') && body.code !== 0)) {
    throw new Error('Monkeyapi 返回图片生成或编辑失败')
  }
  const received = body.data || body.images || body.results
  const entries = Array.isArray(received) ? received : [received]
  const data = []
  let urls = 0
  let encoded = 0
  for (const entry of entries) {
    if (!isObject(entry)) continue
    const url = typeof entry.url === 'string' && /^https:\/\/[a-z0-9.-]+(?::443)?(?:[/?#]|$)/i.test(entry.url)
      && !/[\s\\\u0000-\u001f\u007f]/.test(entry.url)
    const b64 = typeof entry.b64_json === 'string' && entry.b64_json.length >= 4
      && entry.b64_json.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(entry.b64_json)
    if (!url && !b64) continue
    const image = {}
    if (url) {
      urls++
      image.url = entry.url
    }
    if (b64) {
      encoded++
      image.b64_json = entry.b64_json
    }
    if (typeof entry.revised_prompt === 'string') image.revised_prompt = entry.revised_prompt
    data.push(image)
  }
  if (!data.length) throw new Error('Monkeyapi 没有返回有效图片')
  const taskData = { data, imageCount: Math.max(urls, encoded) }
  if (Number.isSafeInteger(body.created) && body.created > 0) taskData.created = body.created
  return taskData
}

export function parseSubmitResponse(ctx, response) {
  return { taskId: utils.uuid(), taskData: imageResult(response.body), immediate: { status: 'SUCCESS' } }
}

export function buildQueryRequest() {
  throw new Error('Monkeyapi 当前仅支持同步图片结果')
}

export function parseTaskResult() {
  return { status: 'FAILURE', reason: 'Monkeyapi 当前仅支持同步图片结果' }
}

export function extractUsage(ctx) {
  return { image_count: submissionFields(ctx).n }
}

function completionUsage(ctx, data) {
  const limit = modelOptions(ctx.upstreamModel || ctx.model, false).maxCount
  return Number.isInteger(data?.imageCount) && data.imageCount > 0 && data.imageCount <= limit
    ? { image_count: data.imageCount }
    : {}
}

export function extractUsageOnSubmit(ctx, data) {
  return completionUsage(ctx, data)
}

export function extractUsageOnComplete(ctx, result, data) {
  return completionUsage(ctx, data)
}

export const protocols = {
  openai_image: {
    decodeRequest,
    render(ctx, task) {
      const { data, created } = task.data
      return created ? { data, created } : { data }
    },
  },
}
