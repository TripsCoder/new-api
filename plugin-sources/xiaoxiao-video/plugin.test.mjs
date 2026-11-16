import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const script = fs.readFileSync(new URL('./dist/xiaoxiao_video.plugin.js', import.meta.url), 'utf8')
const plugin = vm.runInNewContext(script.replace(/^export /gm, '') + '\n;({ buildSubmitRequest, extractUsage, parseTaskResult, listArtifacts })')
const plain = (value) => JSON.parse(JSON.stringify(value))
function context(model, input, options = {}) {
  return { model, baseUrl: 'https://vendor.example/v1', apiKey: 'fixture',
    requestBody: { operation: 'video_generate', input }, ...options }
}

test('all four documented models use one POST endpoint and emit documented fields', () => {
  const img = 'data:image/png;base64,AAAA'
  const video = 'https://media.example/v.mp4'
  const audio = 'https://media.example/a.mp3'
  const input = { prompt: 'Clip', aspect_ratio: '16:9', duration: 8, resolution: '960P',
    generate_audio: false, input_reference: [img, img], reference_video: video,
    reference_audio: audio, start_image_url: img, end_image_url: img }
  const catalog = JSON.parse(fs.readFileSync(new URL('../../pkg/modelconfig/xiaoxiao_video.catalog.json', import.meta.url)))
  const schema = Object.values(catalog.interfaces)[0]
  for (const model of ['h3-video', 'h3-video-flex', 'h3-video-prism', 'h3-video-frames']) {
    const request = plain(plugin.buildSubmitRequest(context(model, input)))
    assert.equal(request.method, 'POST')
    assert.equal(request.url, 'https://vendor.example/v1/videos')
    assert.equal(request.headers.Authorization, 'Bearer fixture')
    assert.deepEqual(request.body, { model, duration: 8, output_count: 1, resolution: '960p',
      prompt: 'Clip', aspect_ratio: '16:9', generate_audio: false, input_reference: [img, img],
      reference_video: video, reference_audio: audio, first_frame: img, last_frame: img })
    assert.deepEqual(Object.keys(schema.modelRules[model].parameters), Object.keys(schema.parameters))
  }
  const onlyTail = plain(plugin.buildSubmitRequest(context('h3-video-frames', { seconds: 15, end_image_url: img })))
  assert.deepEqual(onlyTail.body, { model: 'h3-video-frames', duration: 15, output_count: 1, last_frame: img })
  assert.deepEqual(Object.keys(schema.modelRules['h3-video-frames'].modes), ['frames'])
  for (const field of ['images', 'videos', 'audios']) {
    assert.ok(schema.modelRules['h3-video-frames'].parameters[field].definition['x-channel-parameter'].capabilities.includes('frames'))
  }
})

test('bounds count and per-model duration before building or pricing a request', () => {
  const input = { prompt: 'Clip', seconds: 8 }
  for (const n of [0, 2, 1.5, '1']) {
    assert.throws(() => plugin.extractUsage(context('h3-video', { ...input, output_count: n })), /output_count/)
  }
  assert.throws(() => plugin.buildSubmitRequest(context('h3-video-frames', { ...input, seconds: 16 })), /4–15/)
  assert.throws(() => plugin.buildSubmitRequest(context('h3-video-frames', input)), /first_frame 或 last_frame/)
  assert.throws(() => plugin.buildSubmitRequest(context('h3-video', { ...input, duration: 9 })), /参数别名冲突/)
  assert.throws(() => plugin.extractUsage(context('h3-video', { ...input, resolution: '1440p' })), /resolution/)
  assert.deepEqual(plain(plugin.extractUsage(context('h3-video', input))), { seconds: 8, billable_seconds: 8, resolution: '768p' })
  assert.deepEqual(plain(plugin.extractUsage(context('h3-video', { ...input, size: '1280x720' }))), { seconds: 8, billable_seconds: 8, resolution: '720p' })
})

test('a successful poll needs a safe video URL and failures preserve a sanitized reason', () => {
  const ctx = { taskId: 'fixture-task', apiKey: 'fixture-secret' }
  assert.equal(plugin.parseTaskResult(ctx, { status: 'completed' }).status, 'UNKNOWN')
  assert.equal(plugin.parseTaskResult(ctx, { id: 'wrong', status: 'completed', url: 'https://media.example/v.mp4' }).status, 'UNKNOWN')
  assert.equal(plugin.parseTaskResult(ctx, { id: ctx.taskId, status: 'in_progress' }).status, 'IN_PROGRESS')
  const failed = plugin.parseTaskResult(ctx, { status: 'failed', error: { message: 'failed fixture-secret https://media.example/private' } })
  assert.equal(failed.status, 'FAILURE')
  assert.equal(failed.reason, 'failed [redacted] [URL]')
  assert.deepEqual(plain(plugin.listArtifacts({ status: 'SUCCESS', data: { status: 'succeeded', url: 'https://media.example/v.mp4' } })), [{ key: 'video', type: 'video' }])
})
