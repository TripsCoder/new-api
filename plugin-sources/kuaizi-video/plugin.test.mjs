import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as plugin from './dist/kuaizi_video.plugin.js'

const baseUrl = 'https://supplier.example/ai-open-platform-api'
const taskId = 'kz-cgt-fixture'
const temporary = 'https://oss.example/result.mp4?Expires=123&Signature=fixture'
const archived = 'https://tos.example/ai_openapi/result.mp4'
const completed = {
  output: { task_id: taskId, task_status: 'SUCCEEDED', video_url: temporary, kz_video_url: archived },
  usage: { input_video_duration: 3.5, output_video_duration: 10.25, SR: 720 },
}
function context(value) {
  const model = 'wan3.0-video-prime'
  const intent = plugin.protocols.openai_video.decodeRequest({ model, body: { kind: 'json', value } })
  return { model, baseUrl, apiKey: 'fixture-only', requestBody: intent.requestBody }
}

test('uses the reviewed create and query paths with explicit optional values', () => {
  const ctx = context({ prompt: 'Fixture', seconds: -1, resolution: '720p', ratio: '16:9', audio: false, watermark: false, seed: 0 })
  assert.deepEqual(plugin.buildSubmitRequest(ctx), {
    url: baseUrl + '/api/v1/services/aigc/video-generation/video-synthesis',
    method: 'POST',
    headers: {
      Authorization: 'Bearer fixture-only',
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: {
      model: ctx.model,
      input: { prompt: 'Fixture' },
      parameters: { duration: -1, resolution: '720P', ratio: '16:9', audio: false, watermark: false, seed: 0 },
    },
  })
  const query = plugin.buildQueryRequest({ ...ctx, taskId })
  assert.equal(query.url, baseUrl + '/api/v1/tasks/' + taskId)
  assert.equal(query.method, 'GET')
  assert.throws(() => plugin.buildQueryRequest({ ...ctx, taskId: '../private' }), /任务 ID/)
  assert.throws(() => plugin.buildSubmitRequest({ ...ctx, baseUrl: 'http://supplier.example/ai-open-platform-api' }), /HTTPS/)
  assert.throws(() => plugin.buildSubmitRequest({ ...ctx, apiKey: 'fixture\r\nbad' }), /密钥/)
  assert.throws(() => plugin.buildSubmitRequest({ ...ctx, upstreamModel: 'wan3.0-unknown' }), /上游型号/)
})

test('preserves ordered media-only requests and enforces the documented combinations', () => {
  const media = [
    { type: 'reference_image', url: 'https://media.example/image.png' },
    { type: 'reference_video', url: 'https://media.example/video.mp4' },
    { type: 'reference_image', url: 'https://media.example/other.png' },
    { type: 'file', url: 'https://media.example/brief.pdf' },
  ]
  const ctx = context({ input: { media } })
  assert.deepEqual(plugin.buildSubmitRequest(ctx).body, { model: ctx.model, input: { media } })
  // The decoder's ordering information cannot add back filtered fields.
  delete ctx.requestBody.input.videos
  assert.deepEqual(plugin.buildSubmitRequest(ctx).body.input.media, [media[0], media[2], media[3]])
  assert.throws(() => plugin.buildSubmitRequest(context({})), /至少提供一项/)
  assert.throws(() => plugin.buildSubmitRequest(context({ start_image_url: media[0].url, videos: [media[1].url] })), /不能与参考/)
  assert.throws(() => plugin.buildSubmitRequest(context({ file_url: media[3].url, link_url: 'https://media.example/public' })), /不能同时/)
  assert.throws(() => plugin.buildSubmitRequest(context({ images: ['data:image/png;base64,AAAA'] })), /HTTP/)
  assert.throws(() => plugin.buildSubmitRequest(context({ images: Array(11).fill(media[0].url) })), /数量限制/)
})

test('estimates using documented defaults and settles using bounded actual decimal seconds', () => {
  const plain = context({ prompt: 'Fixture' })
  assert.deepEqual(plugin.buildSubmitRequest(plain).body, { model: plain.model, input: { prompt: 'Fixture' } })
  assert.deepEqual(plugin.extractUsage(plain), { seconds: 5, resolution: '1080P' })
  assert.deepEqual(plugin.extractUsage(context({ prompt: 'Fixture', seconds: -1 })), { seconds: 30, resolution: '1080P' })
  assert.deepEqual(plugin.extractUsage(context({ videos: ['https://media.example/video.mp4'], seconds: 10 })), { seconds: 30, resolution: '1080P' })
  for (const seconds of [-2, 0, 1, 2.5, 31, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => plugin.extractUsage(context({ prompt: 'Fixture', seconds })), /duration|seconds/)
  }
  const result = plugin.parseTaskResult({ taskId }, completed)
  assert.deepEqual(plugin.extractUsageOnComplete({}, result, completed), { seconds: 13.75, resolution: '720P' })
  for (const usage of [
    { output_video_duration: 5 },
    { input_video_duration: -1, output_video_duration: 5 },
    { input_video_duration: 10, output_video_duration: 21 },
    { input_video_duration: 0, output_video_duration: 0 },
  ]) {
    assert.deepEqual(plugin.extractUsageOnComplete({}, result, { ...completed, usage }), {})
  }
  assert.deepEqual(plugin.extractUsageOnComplete({}, { status: 'FAILURE' }, completed), {})
})

test('maps poll states and downloads artifacts without credentials', () => {
  for (const [status, expected] of [
    ['PENDING', 'QUEUED'],
    ['RUNNING', 'IN_PROGRESS'],
    ['UNKNOWN', 'UNKNOWN'],
    ['CANCELED', 'FAILURE'],
  ]) {
    assert.equal(plugin.parseTaskResult({ taskId }, { output: { task_id: taskId, task_status: status } }).status, expected)
  }
  const failed = plugin.parseTaskResult({ taskId, apiKey: 'fixture-only' }, {
    output: { task_id: taskId, task_status: 'FAILED', code: 'InvalidParameter', message: 'Unsupported value fixture-only' },
  })
  assert.equal(failed.status, 'FAILURE')
  assert.equal(failed.reason, 'InvalidParameter: Unsupported value [redacted]')
  assert.equal(plugin.parseTaskResult({ taskId: 'different' }, completed).status, 'UNKNOWN')
  assert.equal(plugin.parseTaskResult({ taskId }, { output: { task_id: taskId, task_status: 'SUCCEEDED' } }).status, 'UNKNOWN')
  assert.equal(plugin.parseTaskResult({ taskId }, completed).url, archived)
  assert.equal(plugin.parseTaskResult({ taskId }, { ...completed, output: { ...completed.output, kz_video_url: temporary } }).url, temporary)
  const task = { status: 'SUCCESS', data: completed }
  assert.deepEqual(plugin.listArtifacts(task), [{ key: 'video', type: 'video' }])
  assert.deepEqual(plugin.buildContentRequest({ ...task, artifactKey: 'video', clientRequest: { method: 'HEAD' } }), {
    url: archived, method: 'HEAD', credentialless: true,
  })
})
