import { createHash } from 'node:crypto'
import fs from 'node:fs'

const root = new URL('./', import.meta.url)
const read = name => fs.readFileSync(new URL(name, root), 'utf8').replace(/\r\n/g, '\n')
const digest = data => createHash('sha256').update(data).digest('hex')
const json = value => JSON.stringify(value, null, 2) + '\n'
const key = 'monkeyapi_image'
const baseURL = 'https://stable.monkeyapi.net'
const paths = { generate: '/v1/images/generations', edit: '/v1/images/edits' }
const interfaceId = 'interface:' + digest(`${key}:POST:${paths.generate}`).slice(0, 16)
const archiveHash = 'a802e78b49c0695277f2f13091f05264aa8e896b99599d020090ae2e2e9b94f0'
const source = {
  url: baseURL,
  sha256: archiveHash,
  readAt: '2026-11-19',
  scope: '用户提供的 monkeyapi-image-v1.0.0.zip 中的客户端源码及参数说明，链接指向服务入口',
  status: 'supplied-client-review',
}
const gpt = { edit: true, maxCount: 10, maxReferences: 16, quality: ['auto', 'low', 'medium', 'high'], outputFormat: 'png' }
const upscaleModels = [
  'gpt-image-2-超分',
  'gpt-image-2.5-超分',
  'gpt-image-2.5-flare-超分',
  'gpt-image-2.5-sunburst-超分',
  'gpt-image-2.6-超分',
  'gpt-image-2.6-flare-超分',
  'gpt-image-2.6-sunburst-超分',
]
// These IDs were returned to the operator by Monkeyapi. The reviewed client
// selects GPT Image IDs by prefix, but the exact variants' limits and edit
// support have not been verified with this provider.
const upscale = { edit: false, maxCount: 1, basicGeneration: true }
const modelOptions = {
  'gpt-image-2': gpt,
  'gpt-image-1.5': gpt,
  'gpt-image-1': gpt,
  'gpt-image-1-mini': gpt,
  'dall-e-3': { edit: false, maxCount: 1, quality: ['auto', 'standard', 'hd', 'high'], responseFormat: 'b64_json' },
  'dall-e-2': { edit: true, maxCount: 10, maxReferences: 1, pngOnly: true, maxFileBytes: 4 * 1024 * 1024 - 1, responseFormat: 'b64_json' },
  ...Object.fromEntries(upscaleModels.map(model => [model, upscale])),
}
const models = Object.keys(modelOptions)
const size = { type: 'string', pattern: '^(auto|[1-9][0-9]{1,4}x[1-9][0-9]{1,4})$' }
const upload = { type: 'string', pattern: '^request_file:' }
const warnings = [
  '字段及候选型号来自用户提供的 Python 客户端。真实目录、账号能力和逐型号限制仍待上游验证',
  '改图仅接受 multipart 上传。蒙版尺寸与透明信息及 DALL-E 2 正方形要求由上游校验',
  '首版解析同步 JSON 结果。SSE、异步任务和采购价尚未核实',
]
const upscaleWarning = '超分型号来自渠道实际目录。插件暂按单张同步生图配置，专属尺寸、质量和改图能力待验证'

function interfaceContract(options) {
  const { edit, maxCount, maxReferences, quality, basicGeneration } = options
  const fields = {
    model: ['模型，由网关填写', ['model'], { type: 'string' }, ['base']],
    prompt: ['图片提示词', ['prompt'], { type: 'string', minLength: 1, maxLength: 65536 }, ['base']],
    n: [
      basicGeneration ? '生成张数，当前适配限制为单张' : '生成张数，缺省按一张处理',
      ['n'], { type: 'integer', minimum: 1, maximum: maxCount }, ['base'],
    ],
    size: ['图片尺寸，具体候选值以型号实际支持为准', ['size'], size, ['base']],
  }
  if (quality) fields.quality = ['生成质量', ['quality'], { type: 'string', enum: quality }, ['base']]
  if (edit) {
    fields.images = ['参考图文件，改图至少上传一张', ['image', 'image[]'], {
      type: 'array', items: upload, minItems: 1, maxItems: maxReferences,
    }, ['edit_image']]
    fields.mask = ['可选透明 PNG 蒙版，与首张参考图同尺寸', ['mask'], upload, ['edit_image']]
  }
  const parameters = Object.fromEntries(Object.entries(fields).map(([name, [description, vendorFields, schema, capabilities]]) => [
    name, {
      ...schema, description, source, required: name === 'prompt' || name === 'model',
      definition: { ...schema, description, 'x-channel-parameter': { vendorFields, capabilities, requiredIn: [], status: 'documented' } },
    },
  ]))
  return {
    id: interfaceId, title: basicGeneration ? 'Monkeyapi 图片生成' : 'Monkeyapi 图片生成与编辑',
    kind: 'image', method: 'POST', path: paths.generate,
    status: 'documented-interface-not-account-verification', source, parameters,
    mapping: Object.fromEntries(Object.keys(parameters).map(name => [name, name])),
    modes: {
      text_image: { required: ['prompt'], initiallyEnabled: true },
      ...(edit ? { edit_image: { required: ['prompt'], initiallyEnabled: true } } : {}),
    },
    pending: basicGeneration ? [...warnings, upscaleWarning] : warnings,
  }
}

const endpoint = interfaceContract({ ...gpt, quality: [...gpt.quality, 'standard', 'hd'] })
endpoint.modelRules = Object.fromEntries(Object.entries(modelOptions).map(([model, options]) => [model, interfaceContract(options)]))
const meta = {
  apiVersion: 1, key, name: 'Monkeyapi 图片', version: '2.0.1', author: { name: 'Local integration' },
  description: { en: 'Generate and edit images through Monkeyapi', zh: '通过 Monkeyapi 生成和编辑图片' },
  icon: 'text:MK', baseUrl: baseURL, auth: 'api_key', models, fetchMode: 'per_task', protocols: ['openai_image'],
  requiredCapabilities: ['large-submit-json@1'],
  channelConfigurationOnly: true,
  modelDiscovery: { path: '/v1/models', format: 'openai', sourceStatus: 'standard_unverified' },
  parameterInterfaces: { [interfaceId]: endpoint },
  usageSchema: {
    image_count: { type: 'number', unit: 'count', description: { en: 'Image generation unit price', zh: '图片生成单价' } },
  },
}
const commonProperties = {
  model: { type: 'string' }, prompt: { type: 'string' }, n: { type: 'integer', minimum: 1, maximum: 10 }, size,
  quality: { type: 'string' }, output_format: { type: 'string' }, response_format: { type: 'string' },
}
const file = { type: 'string', format: 'binary' }
const catalog = {
  key, name: meta.name, baseURL, docsURL: baseURL, models: {}, interfaces: meta.parameterInterfaces,
  warnings: [...warnings, upscaleWarning],
  documents: [
    {
      id: interfaceId, title: 'Monkeyapi 图片生成', method: 'POST', path: paths.generate, source,
      description: 'JSON 请求，返回图片 URL 或 Base64，候选规则摘自随附客户端',
      schema: { type: 'object', required: ['model', 'prompt'], properties: commonProperties },
    },
    {
      id: 'monkeyapi-images-edit', title: 'Monkeyapi 图片编辑', method: 'POST', path: paths.edit, source,
      description: 'multipart 请求，单图 image 或多图 image[]，可选 mask',
      schema: {
        type: 'object', required: ['model', 'prompt'], anyOf: [{ required: ['image'] }, { required: ['image[]'] }],
        properties: { ...commonProperties, image: file, 'image[]': { type: 'array', minItems: 1, maxItems: 16, items: file }, mask: file },
      },
    },
  ],
}

const filename = key + '.plugin.js'
const compiled = '// Generated by build.mjs from the supplied Monkeyapi client review.\n'
  + 'export const meta = ' + JSON.stringify(meta, null, 2) + ';\n'
  + 'const contract = ' + JSON.stringify({ interfaceId, paths, modelOptions }, null, 2) + ';\n'
  + read('plugin.js')
const artifacts = {
  [`../../pkg/modelconfig/${key}.catalog.json`]: json(catalog),
  [`dist/${filename}`]: compiled,
  'dist/manifest.json': json({
    key, version: meta.version, file: filename, interface: interfaceId, sha256: digest(compiled),
    configuration: 'common', source, inputs: Object.fromEntries(['build.mjs', 'plugin.js'].map(name => [name, digest(read(name))])),
  }),
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
