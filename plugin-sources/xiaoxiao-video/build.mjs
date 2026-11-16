import { createHash } from 'node:crypto'
import fs from 'node:fs'

const root = new URL('./', import.meta.url)
const read = (name) => fs.readFileSync(new URL(name, root), 'utf8').replace(/\r\n/g, '\n')
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = (value) => JSON.stringify(value, null, 2) + '\n'
const key = 'xiaoxiao_video'
const baseURL = 'http://8.148.77.247:5555'
const docsURL = baseURL + '/about'
const createPath = '/v1/videos'
const interfaceId = 'interface:' + digest(`${key}:POST:${createPath}`).slice(0, 16)
const evidence = 'evidence/about-20261116.json'
const source = {
  url: docsURL,
  sha256: digest(read(evidence)),
  readAt: '2026-11-16',
  scope: '笑笑中转视频生成接口',
  status: 'reviewed-document-extract',
}
const resolutions = ['480p', '720p', '768p', '960p', '1080p']
const videoModes = ['text_video', 'image_video', 'frames', 'video_ref', 'audio_ref', 'mixed_ref']
const modelOptions = {
  'h3-video': { maxSeconds: 30 },
  'h3-video-flex': { maxSeconds: 30 },
  'h3-video-prism': { maxSeconds: 30 },
  'h3-video-frames': { maxSeconds: 15, requiresFrame: true },
}
const models = Object.keys(modelOptions)
const image = { type: 'string', pattern: '^(https?://|data:image/[a-z0-9.+-]+;base64,)' }
const url = { type: 'string', pattern: '^https?://' }
const fields = {
  model: ['model', '接口型号，由网关填写', { type: 'string', enum: models }, ['base']],
  prompt: ['prompt', '视频提示词', { type: 'string', minLength: 1 }, ['base']],
  seconds: ['duration', '视频时长（秒）', { type: 'integer', minimum: 4, maximum: 30 }, ['base']],
  resolution: ['resolution', '视频分辨率，缺省时上游按 768p 计费', { type: 'string', enum: resolutions }, ['base']],
  size: ['size', '兼容尺寸，首版支持文档示例 1280x720，与 resolution 二选一', { type: 'string', enum: ['1280x720'] }, ['base']],
  output_count: ['output_count', '视频输出条数，首版仅支持 1', { type: 'integer', enum: [1], minimum: 1, maximum: 1 }, ['base']],
  aspect_ratio: ['aspect_ratio', '画面比例，文档未列候选值', { type: 'string', minLength: 1 }, ['base']],
  generate_audio: ['generate_audio', '生成音频', { type: 'boolean' }, ['base']],
  images: ['input_reference', '参考图片 URL 或图片 Base64 Data URL', { type: 'array', items: image }, ['image_video', 'frames', 'video_ref', 'audio_ref', 'mixed_ref']],
  start_image_url: ['first_frame', '首帧图片', image, ['frames']],
  end_image_url: ['last_frame', '尾帧图片', image, ['frames']],
  videos: ['reference_video', '参考视频 URL，首版至多一个', { type: 'array', items: url, maxItems: 1 }, ['frames', 'video_ref', 'mixed_ref']],
  audios: ['reference_audio', '参考音频 URL，首版至多一个', { type: 'array', items: url, maxItems: 1 }, ['frames', 'audio_ref', 'mixed_ref']],
}
const warnings = [
  '型号以带渠道密钥的 /v1/models 结果为准。公开价格目录只用来核对文档型号',
  '首版单条输出，音视频参考各至多一个。尺寸只支持文档示例 1280x720，其余请使用明确的 resolution',
  '未取得实际完成计费用量样本。按已校验请求的时长和计费分辨率提供用量，公开采购报价不写入渠道售价',
  '当前供应商只验证了 HTTP 地址。实际密钥联调应使用供应商提供的 HTTPS 地址',
]

function interfaceContract({ maxSeconds, requiresFrame, initiallyEnabled }) {
  const modes = requiresFrame ? ['frames'] : videoModes
  const parameters = {}
  for (const [name, [vendor, description, schema, capabilities]] of Object.entries(fields)) {
    const applicable = capabilities.filter((cap) => cap === 'base' || modes.includes(cap))
    if (!applicable.length) continue
    const limits = name === 'seconds' ? { ...schema, maximum: maxSeconds } : schema
    const frameField = name === 'start_image_url' || name === 'end_image_url'
    const label = requiresFrame && frameField ? `${description}，首帧和尾帧至少提供一个` : description
    parameters[name] = {
      ...limits,
      required: name === 'model',
      description: label,
      source,
      definition: {
        ...limits,
        description: label,
        'x-channel-parameter': { vendorFields: [vendor], capabilities: applicable, requiredIn: [], status: 'documented' },
      },
    }
  }
  return {
    id: interfaceId,
    title: '笑笑中转创建视频任务',
    kind: 'video',
    method: 'POST',
    path: createPath,
    status: 'documented-interface-not-account-verification',
    source,
    parameters,
    mapping: Object.fromEntries(Object.keys(parameters).map((name) => [name, name])),
    modes: Object.fromEntries(modes.map((mode) => [mode, {
      required: [],
      ...(initiallyEnabled ? { initiallyEnabled } : {}),
      ...(requiresFrame ? { optionalReferences: ['images', 'videos', 'audios'] } : {}),
    }])),
    capabilities: {
      firstFrame: true,
      lastFrame: true,
      multipleReferences: true,
      ...(requiresFrame ? { requiresFrame: true } : {}),
    },
    pending: warnings,
  }
}

const endpoint = interfaceContract({ maxSeconds: 30 })
endpoint.modelRules = Object.fromEntries(Object.entries(modelOptions).map(([model, options]) => [
  model, interfaceContract({ ...options, initiallyEnabled: true }),
]))
const meta = {
  apiVersion: 1,
  key,
  name: '笑笑中转视频',
  version: '2.1.3',
  author: { name: 'TripsCoder' },
  description: { en: 'H3 video generation through Xiaoxiao', zh: '通过笑笑中转生成 H3 视频' },
  icon: 'text:XX',
  baseUrl: baseURL,
  auth: 'api_key',
  models,
  fetchMode: 'per_task',
  protocols: ['openai_video'],
  modelDiscovery: { path: '/v1/models', format: 'openai', sourceStatus: 'standard_unverified' },
  parameterInterfaces: { [interfaceId]: endpoint },
  usageSchema: {
    billable_seconds: { type: 'number', unit: 'second', description: { en: 'Video generation unit price', zh: '视频生成单价' } },
    seconds: { type: 'number', unit: 'second', description: { en: 'Video generation unit price', zh: '视频生成单价' } },
    resolution: { enum: resolutions, description: { en: 'Billing resolution', zh: '计费分辨率' } },
  },
}
const catalog = {
  key, name: meta.name, baseURL, docsURL, models: {}, interfaces: meta.parameterInterfaces,
  documents: [
    {
      id: interfaceId, title: endpoint.title, method: 'POST', path: createPath, source,
      description: 'JSON 视频请求。首尾帧型号至少提供首帧或尾帧，首版仅支持单条输出',
      schema: {
        type: 'object', required: ['model'],
        properties: {
          ...Object.fromEntries(Object.values(fields).map(([vendor, description, schema]) => [vendor, { ...schema, description }])),
          input_reference: { anyOf: [image, { type: 'array', items: image }] },
          reference_video: url,
          reference_audio: url,
        },
      },
    },
    {
      id: 'xiaoxiao-video-task-query', title: '笑笑中转查询视频任务', method: 'GET', path: `${createPath}/{id}`, source,
      description: '以提交响应的 id 轮询，成功时下载顶层 url',
      schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, url } },
    },
  ],
  warnings,
}
const compiled = '// Generated by build.mjs from the reviewed Xiaoxiao video documentation.\n' +
  'export const meta = ' + JSON.stringify(meta, null, 2) + ';\n' +
  'const contract = ' + JSON.stringify({ createPath, interfaceId, resolutions, modelOptions }, null, 2) + ';\n' + read('plugin.js')
const lock = {
  configuration: 'common',
  parameterApplicability: { scope: 'four H3 models', evidence: 'operator-confirmed shared video fields', confirmedOn: '2026-11-16' },
  sources: [{ ...source, file: evidence, reviewedFrom: baseURL + '/api/about' }],
  catalogCheck: { url: baseURL + '/api/pricing', videoModels: models, readAt: source.readAt },
  discovery: { path: '/v1/models', unauthenticatedStatus: 401, authenticated: false },
  supplierCost: { currency: 'CNY', unit: 'second', resolution: resolutions, minimumPerVideo: 0.072,
    'h3-video': [0.018, 0.042, 0.042, 0.09, 0.102], 'h3-video-flex': [0.03, 0.048, 0.054, 0.09, 0.102],
    'h3-video-prism': [0.03, 0.042, 0.042, 0.09, 0.102], 'h3-video-frames': [0.018, 0.042, 0.042, 0.09, 0.102] },
  pending: warnings,
}
const filename = key + '.plugin.js'
const artifacts = {
  [`../../pkg/modelconfig/${key}.catalog.json`]: json(catalog),
  'sources.lock.json': json(lock),
  [`dist/${filename}`]: compiled,
  'dist/manifest.json': json({ key, version: meta.version, interface: interfaceId, file: filename, sha256: digest(compiled),
    inputs: Object.fromEntries(['build.mjs', 'plugin.js', evidence].map((name) => [name, digest(read(name))])) }),
}
for (const [name, value] of Object.entries(artifacts)) {
  if (process.argv.includes('--check')) {
    if (read(name) !== value) throw new Error('Stale artifact ' + name)
  } else {
    const file = new URL(name, root)
    fs.mkdirSync(new URL('.', file), { recursive: true })
    fs.writeFileSync(file, value)
  }
}
