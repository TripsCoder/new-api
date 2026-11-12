import { createHash } from 'node:crypto'
import fs from 'node:fs'

const root = new URL('./', import.meta.url)
const read = (name) => fs.readFileSync(new URL(name, root), 'utf8').replace(/\r\n/g, '\n')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const json = (value) => JSON.stringify(value, null, 2) + '\n'
const key = 'kuaizi_video'
const baseURL = 'https://aiopenapi.kuaizi.cn/ai-open-platform-api'
const createPath = '/api/v1/services/aigc/video-generation/video-synthesis'
const queryPath = '/api/v1/tasks/{task_id}'
const interfaceId = 'interface:' + sha256(key + ':POST:' + createPath).slice(0, 16)
const docsURL = 'https://www.yuque.com/huicundeyouhuo-dtb95/tci6ux/tuf5p28rq63mi6q1?singleDoc'
const evidence = 'evidence/yuque-video-v1.2.txt'
const source = {
  url: docsURL,
  sha256: sha256(read(evidence)),
  readAt: '2026-11-12',
  scope: '筷子科技万相 3.0 视频生成兼容接口 v1.2',
  status: 'public-documentation',
}
const models = ['wan3.0-video', 'wan3.0-video-prime']
const resolutions = ['480P', '720P', '1080P']
const ratios = ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16']
const modes = ['text_video', 'image_video', 'frames', 'video_ref', 'audio_ref', 'mixed_ref']
const url = { type: 'string', format: 'uri', pattern: '^https?://' }
const mediaFields = {
  start_image_url: { type: 'first_frame', max: 1, label: '首帧图片', modes: ['image_video', 'frames'] },
  end_image_url: { type: 'last_frame', max: 1, label: '尾帧图片', modes: ['frames'] },
  images: { type: 'reference_image', max: 10, label: '参考图片', modes: ['image_video', 'video_ref', 'audio_ref', 'mixed_ref'], array: true },
  videos: { type: 'reference_video', max: 5, label: '参考视频，总时长最多 15 秒', modes: ['video_ref', 'mixed_ref'], array: true },
  audios: { type: 'reference_audio', max: 5, label: '参考音频，总时长最多 15 秒', modes: ['audio_ref', 'mixed_ref'], array: true },
  file_url: { type: 'file', max: 1, label: '参考文件 URL，与网页链接互斥', modes: ['base'] },
  link_url: { type: 'link', max: 1, label: '无需登录的公开网页 URL，与文件互斥', modes: ['base'] },
}
const settings = {
  resolution: { vendor: 'resolution', label: '分辨率', schema: { type: 'string', enum: resolutions, default: '1080P' } },
  aspect_ratio: { vendor: 'ratio', label: '画面比例', schema: { type: 'string', enum: ratios, default: 'adaptive' } },
  seconds: {
    vendor: 'duration',
    label: '输出视频时长，-1 为智能时长，有参考视频时输入与输出总时长最多 30 秒',
    schema: { type: 'integer', minimum: -1, maximum: 30, anyOf: [{ const: -1 }, { minimum: 2, maximum: 30 }], default: 5 },
  },
  generate_audio: { vendor: 'audio', label: '生成音频', schema: { type: 'boolean', default: true } },
  seed: { vendor: 'seed', label: '随机种子', schema: { type: 'integer', minimum: 0, maximum: 2147483647 } },
  watermark: { vendor: 'watermark', label: '添加水印', schema: { type: 'boolean', default: false } },
}

function field(schema, vendorFields, capabilities, description, required = false) {
  const { default: documentedDefault, ...constraints } = schema
  return {
    type: schema.type,
    required,
    description,
    source,
    ...(schema.enum ? { enum: schema.enum } : {}),
    ...(schema.minimum === undefined ? {} : { minimum: schema.minimum }),
    ...(schema.maximum === undefined ? {} : { maximum: schema.maximum }),
    definition: {
      ...constraints,
      description,
      ...(documentedDefault === undefined ? {} : { documentedDefault }),
      'x-channel-parameter': { vendorFields, capabilities, requiredIn: [], status: 'documented' },
    },
  }
}

const prompt = { type: 'string', minLength: 1, maxLength: 20000 }
const parameters = {
  model: field({ type: 'string', enum: models }, ['model'], ['base'], '接口接受的上游型号，由网关带入', true),
  prompt: field(prompt, ['input.prompt'], ['base'], '提示词与素材至少提供一项'),
}
for (const [name, entry] of Object.entries(settings)) {
  parameters[name] = field(entry.schema, ['parameters.' + entry.vendor], ['base'], entry.label)
}
for (const [name, entry] of Object.entries(mediaFields)) {
  const schema = entry.array ? { type: 'array', items: url, maxItems: entry.max } : url
  parameters[name] = field(schema, ['input.media[].url'], entry.modes, entry.label)
}

const warnings = [
  '任务查询路由已验证可达。文档仅列出接口允许型号，账号邀测权限与模型列表接口仍待确认',
  '媒体用公开 HTTP(S) URL。参考视频及音频时长、媒体格式和仅尾帧的适用性由上游验证',
  '上游按输入与输出视频总秒数及分辨率计费，文档人民币单价仅供采购参考',
  '成功后筷子可能仍返回临时下载地址，及时保存产物',
]
const contract = {
  id: interfaceId,
  title: '筷子科技万相 3.0 创建视频任务',
  kind: 'video',
  method: 'POST',
  path: createPath,
  status: 'documented-interface-not-account-verification',
  source,
  parameters,
  mapping: Object.fromEntries(Object.keys(parameters).map((name) => [name, name])),
  modes: Object.fromEntries(modes.map((mode) => [mode, { required: [] }])),
  capabilities: { firstFrame: true, lastFrame: true, multipleReferences: true },
  pending: warnings,
}
const meta = {
  apiVersion: 1,
  key,
  name: '筷子科技万相视频',
  version: '2.1.0',
  author: { name: 'TripsCoder' },
  description: { en: 'Wan 3.0 video generation through Kuaizi', zh: '通过筷子科技接口生成万相 3.0 视频' },
  icon: 'text:KZ',
  website: docsURL,
  baseUrl: baseURL,
  auth: 'api_key',
  models,
  fetchMode: 'per_task',
  requiredCapabilities: ['duration-auto@1'],
  protocols: ['openai_video'],
  parameterInterfaces: { [interfaceId]: contract },
  usageSchema: {
    seconds: { type: 'number', unit: 'second', description: { en: 'Video generation unit price', zh: '视频生成单价' } },
    resolution: { enum: resolutions, description: { en: 'Output video resolution', zh: '输出视频分辨率' } },
  },
}
const catalog = {
  key,
  name: meta.name,
  baseURL,
  docsURL,
  models: {},
  interfaces: meta.parameterInterfaces,
  documents: [
    {
      id: interfaceId,
      title: contract.title,
      method: contract.method,
      path: contract.path,
      description: '提示词或素材至少一项。首尾帧与其他参考素材互斥，文件与网页链接互斥',
      source,
      schema: {
        type: 'object',
        required: ['model', 'input'],
        properties: {
          model: { type: 'string', enum: models },
          input: {
            type: 'object',
            anyOf: [{ required: ['prompt'] }, { required: ['media'] }],
            properties: {
              prompt,
              media: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  required: ['type', 'url'],
                  properties: { type: { enum: Object.values(mediaFields).map((entry) => entry.type) }, url },
                },
              },
            },
          },
          parameters: { type: 'object', properties: Object.fromEntries(Object.values(settings).map(({ vendor, schema }) => [vendor, schema])) },
        },
      },
    },
    {
      id: 'kuaizi-video-task-query',
      title: '筷子科技万相 3.0 查询视频任务',
      method: 'GET',
      path: queryPath,
      description: '使用创建返回的筷子任务 ID 轮询，读取 output.task_status、视频地址和 usage',
      source,
      schema: { type: 'object', required: ['task_id'], properties: { task_id: { type: 'string' } } },
    },
  ],
  warnings,
}
const runtime = {
  createPath,
  queryPath: queryPath.replace('{task_id}', ''),
  interfaceId,
  settings: Object.fromEntries(Object.entries(settings).map(([field, entry]) => [field, entry.vendor])),
  mediaFields: Object.fromEntries(Object.entries(mediaFields).map(([field, { type, max, array = false }]) => [field, { type, max, array }])),
}
const compiled = '// Generated by build.mjs from the reviewed Kuaizi API documentation.\n' +
  'export const meta = ' + JSON.stringify(meta, null, 2) + ';\n' +
  'const contract = ' + JSON.stringify(runtime, null, 2) + ';\n' + read('plugin.js')
const lock = {
  format: 'kuaizi-video-sources/v1',
  sources: [{ ...source, file: evidence, retrievedFrom: docsURL.split('?')[0] + '/markdown?plain=true' }],
  modelDeclarations: { status: 'documented-interface-allowlist', models },
  unauthenticatedProbes: { baseURL, taskQuery: { status: 401, code: 'InvalidApiKey' }, openAIModelList: { status: 404 }, readAt: '2026-11-12' },
  supplierCost: { currency: 'CNY', unit: 'second', resolution: resolutions, 'wan3.0-video': [0.3, 0.6, 1.2], 'wan3.0-video-prime': [0.45, 0.9, 1.8] },
  pending: warnings,
}
const manifest = {
  format: 'kuaizi-video-build/v1',
  key,
  version: meta.version,
  interface: interfaceId,
  file: key + '.plugin.js',
  sha256: sha256(compiled),
  inputs: Object.fromEntries(['build.mjs', 'plugin.js', evidence].map((name) => [name, sha256(read(name))])),
}
const artifacts = {
  '../../pkg/modelconfig/kuaizi_video.catalog.json': json(catalog),
  'sources.lock.json': json(lock),
  'dist/kuaizi_video.plugin.js': compiled,
  'dist/manifest.json': json(manifest),
}
for (const [name, content] of Object.entries(artifacts)) {
  const file = new URL(name, root)
  if (process.argv.includes('--check')) {
    if (read(name) !== content) throw new Error('Stale artifact ' + name)
  } else {
    fs.mkdirSync(new URL('.', file), { recursive: true })
    fs.writeFileSync(file, content)
  }
}
