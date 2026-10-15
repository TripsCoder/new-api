import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const profiles = JSON.parse(fs.readFileSync(new URL('./profiles.json', import.meta.url), 'utf8'));
const runtime = fs.readFileSync(new URL('./runtime.js', import.meta.url), 'utf8');

test('verified compatible model lists are declared independently of static adaptation', () => {
  const proof = JSON.parse(fs.readFileSync(new URL('./model-discovery-20261015.lock.json', import.meta.url), 'utf8'));
  for (const key of ['lxmone_media', 'zhangyuge_media']) {
    const provider = profiles[key];
    const evidence = proof.sources.find(item => item.plugin === key);
    assert.equal(provider.version, '1.1.1');
    assert.equal(provider.modelDiscovery.path, '/v1/models');
    assert.equal(provider.modelDiscovery.format, 'openai');
    assert.equal(provider.modelDiscovery.sourceUrl, evidence.url);
    assert.equal(provider.modelDiscovery.sourceSha256, evidence.sha256);
    assert.equal(evidence.status, 200);
    assert.equal(typeof evidence.models, 'number');
    // The dynamic-list capture is provenance, never the adapted-model list.
    assert.notEqual(evidence.models, Object.keys(provider.models).length);
    assert.equal(Object.hasOwn(provider.modelDiscovery, 'models'), false);
  }
});

function loadRuntime(providerKey, configure = () => {}) {
  const provider = structuredClone(Object.values(profiles).find(value => value.key === providerKey));
  assert.ok(provider, `missing provider ${providerKey}`);
  configure(provider);
  // Run only the pure plugin hooks. No build script, network, file writes or
  // host credentials are available inside this isolated runtime.
  const source = `const PROVIDER = ${JSON.stringify(provider)}; const meta = {};\n` +
    runtime.replace(/^export /gm, '') + '\n({buildSubmitRequest, extractUsage, protocols});';
  return vm.runInNewContext(source, {}, {timeout: 1000});
}

function requestContext(model, publicTaskId = 'task_0123456789abcdefghijklmnopqrstuv') {
  return {
    model,
    upstreamModel: model,
    publicTaskId,
    baseUrl: 'https://provider.invalid',
    authHeader: 'Bearer offline-fixture-not-a-key',
    upstream: {kind: 'vendor'},
    requestBody: {operation: 'video_generate', input: {model, prompt: 'Offline test', seconds: 5}},
  };
}

test('all 193 candidate model defaults build bounded requests and declared usage facts offline', () => {
  let checked = 0;
  for (const [key, provider] of Object.entries(profiles)) {
    const source = fs.readFileSync(new URL('./dist/' + key + '.plugin.js', import.meta.url), 'utf8');
    const plugin = vm.runInNewContext(source.replace(/^export /gm, '') + '\n({meta,buildSubmitRequest,extractUsage});', {utils:{uuid:()=> 'fixture-task',unixNow:()=>1791676800}}, {timeout:1000});
    for (const [model, p] of Object.entries(provider.models)) {
      const ctx = requestContext(model);
      ctx.requestBody = {operation:p.kind==='image'?'image_generate':'video_generate',input:{model,prompt:'Offline default regression'},uploads:[]};
      const input = ctx.requestBody.input;
      if (p.kind==='video' && (p.secondsField || p.fixedSeconds)) input.seconds=p.defaultSeconds || p.secondsChoices?.[0] || p.minSeconds;
      if (p.minImages || p.firstLastOnly || p.anyImageOrAudio) input.images=Array(p.minImages || 1).fill('https://media.invalid/ref.png');
      if (p.minAudios) input.audios=Array(p.minAudios).fill('https://media.invalid/ref.mp3');
      const request = plugin.buildSubmitRequest(ctx);
      assert.ok(request.url.startsWith('https://provider.invalid/v1'), key+' '+model);
      assert.equal(request.body.model || model, p.upstreamModel || model);
      const facts=plugin.extractUsage(ctx), schema=plugin.meta.usageProfiles.find(profile=>profile.models.includes(model)).schema;
      assert.deepEqual(Object.keys(facts).sort(),Object.keys(schema).sort(),key+' '+model);
      for (const [field,value] of Object.entries(facts)) {
        if (schema[field].enum) assert.ok(schema[field].enum.includes(value),model+' '+field);
        else if (typeof value==='number') assert.ok(Number.isFinite(value) && value>=1 && value<=3600,model+' '+field);
      }
      checked++;
    }
  }
  assert.equal(checked,193);
});

test('reviewed profiles enable only exact documented model changes', () => {
  const cangyuan = loadRuntime('cangyuan_media');
  const ctx=requestContext('gpt-image-2');
  ctx.requestBody={operation:'image_edit',input:{model:ctx.model,prompt:'Offline edit',n:10,images:['https://media.invalid/ref.png'],mask:'https://media.invalid/mask.png'}};
  const body=cangyuan.buildSubmitRequest(ctx).body;
  assert.equal(body.n,10);
  assert.equal(body.mask,'https://media.invalid/mask.png');
  ctx.requestBody.input.n=11;
  assert.throws(()=>cangyuan.buildSubmitRequest(ctx),/between/);
  const lxm=loadRuntime('lxmone_media');
  for (const model of ['seedance-933','seedance2.0-933-V','seedance2.5']) {
    const c=requestContext(model);
    c.requestBody.input.resolution='480p';
    c.requestBody.input.seconds=model==='seedance2.5'?4:5;
    assert.equal(lxm.buildSubmitRequest(c).body.resolution,'480p');
    delete c.requestBody.input.resolution;
    assert.equal(lxm.buildSubmitRequest(c).body.resolution,'720p');
  }
});

function xcmGrokRuntime() {
  return loadRuntime('xcmapi_media', provider => {
    // Explicit opt-in models mirror the reviewed 2026-10-14 Gway contract;
    // legacy names and native h3 must not inherit it by supplier or substring.
    provider.models['grok-1.5'].clientRequestId = 'publicTaskId';
  });
}

test('XCM reviewed Gway profile uses the same gateway identity on every attempt', () => {
  const plugin = xcmGrokRuntime();
  const ctx = requestContext('grok-1.5');
  const first = plugin.buildSubmitRequest(ctx);
  const retry = plugin.buildSubmitRequest(structuredClone(ctx));
  assert.equal(first.body.client_request_id, ctx.publicTaskId);
  assert.equal(retry.body.client_request_id, first.body.client_request_id);
  assert.equal(first.url, 'https://provider.invalid/v1/videos');
  assert.equal(first.body.model, 'grok-1.5');
  assert.equal(first.body.prompt, 'Offline test');
  const another = plugin.buildSubmitRequest(requestContext('grok-1.5', 'task_1123456789abcdefghijklmnopqrstuv'));
  assert.notEqual(another.body.client_request_id, first.body.client_request_id);
});

test('XCM reviewed Gway profile rejects missing or invalid gateway identities', () => {
  const plugin = xcmGrokRuntime();
  for (const id of [undefined, null, '', 'short', 'x'.repeat(129), 'task_0123456789 bad', 'task_0123456789\r\n', 1234567890123456]) {
    const ctx = requestContext('grok-1.5');
    ctx.publicTaskId = id;
    assert.throws(() => plugin.buildSubmitRequest(ctx), /valid stable gateway task id/, String(id));
  }
  for (const id of ['x'.repeat(16), 'x'.repeat(128), 'task_0123456.a:b-c_d']) {
    assert.equal(plugin.buildSubmitRequest(requestContext('grok-1.5', id)).body.client_request_id, id);
  }
});

test('XCM decoder does not need a gateway identity before the host creates the task', () => {
  const plugin = xcmGrokRuntime();
  const decoded = plugin.protocols.openai_video.decodeRequest({
    model: 'grok-1.5', body: {kind: 'json', value: {model: 'grok-1.5', prompt: 'Offline test', seconds: 5}},
  });
  assert.equal(decoded.kind, 'submit');
  assert.equal(decoded.model, 'grok-1.5');
});

test('a client cannot replace the stable gateway identity through the request body', () => {
  const plugin = xcmGrokRuntime();
  const ctx = requestContext('grok-1.5');
  ctx.requestBody.input.client_request_id = 'attacker_0123456789';
  assert.throws(() => plugin.buildSubmitRequest(ctx), /unsupported field: client_request_id/);
});

test('legacy XCM models and native h3 do not gain an undocumented request field', () => {
  const plugin = xcmGrokRuntime();
  for (const model of ['seedance-2.0-900-特惠', 'h3']) {
    const ctx = requestContext(model);
    delete ctx.publicTaskId;
    const request = plugin.buildSubmitRequest(ctx);
    assert.equal(Object.hasOwn(request.body, 'client_request_id'), false, model);
    assert.equal(request.body.model, model);
  }
});

test('Yuxibox and lxmone requests remain unchanged without explicit profile opt-in', () => {
  for (const [provider, model] of [['yuxibox_media', 'seedance-2.0（YX）'], ['lxmone_media', 'seedance2.5']]) {
    const plugin = loadRuntime(provider);
    const ctx = requestContext(model);
    delete ctx.publicTaskId;
    assert.equal(Object.hasOwn(plugin.buildSubmitRequest(ctx).body, 'client_request_id'), false, provider);
  }
});

test('only reviewed ArtBox model accepts references together with first and last frames', () => {
  const plugin = loadRuntime('artbox_media', provider => {
    provider.models['Artdance 2.5-720p'].allowFramesWithImages = true;
  });
  const ctx = requestContext('Artdance 2.5-720p');
  Object.assign(ctx.requestBody.input, {
    image_urls: ['https://cdn.invalid/reference.png'],
    start_image_url: 'https://cdn.invalid/start.png',
    end_image_url: 'https://cdn.invalid/end.png',
  });
  const body = plugin.buildSubmitRequest(ctx).body;
  assert.equal(body.image_urls[0], ctx.requestBody.input.image_urls[0]);
  assert.equal(body.start_image_url, ctx.requestBody.input.start_image_url);
  assert.equal(body.end_image_url, ctx.requestBody.input.end_image_url);
  ctx.model = ctx.upstreamModel = ctx.requestBody.input.model = 'Artdance 2.5-480p';
  assert.throws(() => plugin.buildSubmitRequest(ctx), /cannot be combined/);
});

test('mixed ArtBox references still enforce the model image limit and required first frame', () => {
  const plugin = loadRuntime('artbox_media', provider => {
    provider.models['Artdance 2.5-720p'].allowFramesWithImages = true;
  });
  const ctx = requestContext('Artdance 2.5-720p');
  ctx.requestBody.input.image_urls = Array(28).fill('https://cdn.invalid/reference.png');
  ctx.requestBody.input.start_image_url = 'https://cdn.invalid/start.png';
  ctx.requestBody.input.end_image_url = 'https://cdn.invalid/end.png';
  assert.equal(plugin.buildSubmitRequest(ctx).body.image_urls.length, 28);
  ctx.requestBody.input.image_urls.push('https://cdn.invalid/overflow.png');
  assert.throws(() => plugin.buildSubmitRequest(ctx), /reference images must be between/);
  ctx.requestBody.input.image_urls = [];
  delete ctx.requestBody.input.start_image_url;
  assert.throws(() => plugin.buildSubmitRequest(ctx), /last frame requires a first frame/);
});

function imageContext(model, input = {}) {
  const ctx = requestContext(model);
  ctx.requestBody = {operation: 'image_generate', input: {model, prompt: 'Offline image test', ...input}};
  return ctx;
}

test('reviewed Zhangyuge image ratios accept auto without relaxing sibling models', () => {
  const plugin = loadRuntime('zhangyuge_media', provider => {
    provider.models['gpt-image-2'].imageRatios = ['auto', '1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '21:9'];
  });
  assert.equal(plugin.buildSubmitRequest(imageContext('gpt-image-2', {aspect_ratio: 'auto'})).body.aspect_ratio, 'auto');
  assert.equal(plugin.buildSubmitRequest(imageContext('gpt-image-2', {aspect_ratio: '9:16'})).body.aspect_ratio, '9:16');
  assert.throws(() => plugin.buildSubmitRequest(imageContext('gpt-image-2', {aspect_ratio: '9:99'})), /aspect ratio must be/);
  assert.throws(() => plugin.buildSubmitRequest(imageContext('gpt-image-2', {aspect_ratio: 'auto', size: '1024x1024'})), /mutually exclusive/);
  assert.throws(() => plugin.buildSubmitRequest(imageContext('gpt-image-2.5-flare', {aspect_ratio: 'auto'})), /aspect ratio must be/);
});

const flare1kConstraints = {minPixels: 655360, maxPixels: 1048576, maxDimension: 3840, multiple: 16, maxAspectRatio: 3};

function cangyuanPixelRuntime() {
  return loadRuntime('cangyuan_media', provider => {
    provider.models['gpt-image-2.5-flare-1k'].pixelConstraints = flare1kConstraints;
  });
}

test('reviewed fixed 1k pixel constraints accept valid sizes and documented ratio notation', () => {
  const plugin = cangyuanPixelRuntime();
  for (const size of ['1024x640', '640x1024', '1024x1024', '1280x720', '16:9']) {
    assert.equal(plugin.buildSubmitRequest(imageContext('gpt-image-2.5-flare-1k', {size})).body.size, size);
  }
});

test('reviewed fixed 1k pixel constraints reject wrong tier, divisibility, dimension and aspect ratio', () => {
  const plugin = cangyuanPixelRuntime();
  for (const size of ['2048x2048', '256x256', '1025x640', '3856x256', '1792x512', '9007199254740993x16']) {
    assert.throws(() => plugin.buildSubmitRequest(imageContext('gpt-image-2.5-flare-1k', {size})), /invalid_request:/, size);
  }
  // No supplier-wide constraint: a sibling is unchanged until separately reviewed.
  assert.equal(plugin.buildSubmitRequest(imageContext('gpt-image-2.5-flare-2k', {size: '2048x2048'})).body.size, '2048x2048');
});

test('malformed reviewed pixel constraints fail closed instead of removing bounds', () => {
  for (const bad of [{minPixels: 0}, {maxPixels: 1}, {multiple: 0}, {maxDimension: 1.5}, {maxAspectRatio: 0}]) {
    const plugin = loadRuntime('cangyuan_media', provider => {
      provider.models['gpt-image-2.5-flare-1k'].pixelConstraints = {...flare1kConstraints, ...bad};
    });
    assert.throws(() => plugin.buildSubmitRequest(imageContext('gpt-image-2.5-flare-1k', {size: '1024x1024'})), /invalid model pixel constraints/);
  }
});

function cangyuanOptionalImageRuntime() {
  return loadRuntime('cangyuan_media', provider => {
    const model = provider.models['gpt-image-2.5-flare-1k'];
    model.backgrounds = ['auto', 'opaque', 'transparent'];
    model.outputFormats = ['png', 'jpeg', 'webp'];
  });
}

test('reviewed flare 1k image options forward exact enums for generation and editing without defaults', () => {
  const plugin = cangyuanOptionalImageRuntime();
  for (const operation of ['image_generate', 'image_edit']) {
    const ctx = imageContext('gpt-image-2.5-flare-1k');
    ctx.requestBody.operation = operation;
    if (operation === 'image_edit') ctx.requestBody.input.images = ['https://media.invalid/ref.png'];
    const before = JSON.stringify(plugin.extractUsage(ctx));
    const defaultBody = plugin.buildSubmitRequest(ctx).body;
    assert.equal(Object.hasOwn(defaultBody, 'background'), false);
    assert.equal(Object.hasOwn(defaultBody, 'output_format'), false);
    for (const [background, output_format] of [['auto', 'png'], ['opaque', 'jpeg'], ['transparent', 'webp']]) {
      Object.assign(ctx.requestBody.input, {background, output_format});
      const body = plugin.buildSubmitRequest(ctx).body;
      assert.equal(body.background, background);
      assert.equal(body.output_format, output_format);
      assert.equal(JSON.stringify(plugin.extractUsage(ctx)), before);
    }
  }
});

test('reviewed flare 1k image options explicitly reject unknown or non-string enums', () => {
  const plugin = cangyuanOptionalImageRuntime();
  for (const [field, values] of [
    ['background', ['solid', 'AUTO', '', null, false, 1, ['auto'], {value: 'auto'}]],
    ['output_format', ['jpg', 'gif', 'PNG', '', null, false, 1, ['png'], {value: 'png'}]],
  ]) {
    for (const value of values) {
      assert.throws(() => plugin.buildSubmitRequest(imageContext('gpt-image-2.5-flare-1k', {[field]: value})), new RegExp(field + ' must be one of'), String(value));
    }
  }
});

test('optional image enums stay model-scoped and missing or malformed declarations fail closed', () => {
  const plugin = cangyuanOptionalImageRuntime();
  for (const model of ['gpt-image-2', 'gpt-image-2.5-flare-2k']) {
    for (const [field, value] of [['background', 'auto'], ['output_format', 'png']]) {
      assert.throws(() => plugin.buildSubmitRequest(imageContext(model, {[field]: value})), new RegExp(field + ' is unsupported'), model);
    }
  }
  for (const value of [undefined, null, [], 'png', true]) {
    const unconfigured = loadRuntime('cangyuan_media', provider => {
      provider.models['gpt-image-2.5-flare-1k'].backgrounds = value;
      provider.models['gpt-image-2.5-flare-1k'].outputFormats = value;
    });
    assert.throws(() => unconfigured.buildSubmitRequest(imageContext('gpt-image-2.5-flare-1k', {background: 'auto'})), /background is unsupported/);
    assert.throws(() => unconfigured.buildSubmitRequest(imageContext('gpt-image-2.5-flare-1k', {output_format: 'png'})), /output_format is unsupported/);
  }
});

test('Paisio legacy output formats remain supported without enabling other models or backgrounds', () => {
  const plugin = loadRuntime('paisio_media');
  for (const output_format of ['png', 'jpeg', 'webp']) {
    assert.equal(plugin.buildSubmitRequest(imageContext('gpt-image2-low', {output_format})).body.output_format, output_format);
  }
  assert.equal(Object.hasOwn(plugin.buildSubmitRequest(imageContext('gpt-image2-low')).body, 'output_format'), false);
  assert.throws(() => plugin.buildSubmitRequest(imageContext('gpt-image2-low', {output_format: 'gif'})), /output_format must be one of/);
  assert.throws(() => plugin.buildSubmitRequest(imageContext('gpt-image2-low', {background: 'auto'})), /background is unsupported/);
  assert.throws(() => plugin.buildSubmitRequest(imageContext('gemini-3.1-flash-image-preview', {output_format: 'png'})), /output_format is unsupported/);
});

function lxmAudioDurationRuntime() {
  return loadRuntime('lxmone_media', provider => {
    provider.models['wan3-720'].audioDurations = true;
  });
}

test('reviewed lxmone wan3-720 forwards optional per-audio durations without new billing facts', () => {
  const plugin = lxmAudioDurationRuntime();
  const ctx = requestContext('wan3-720');
  ctx.requestBody.input.seconds = 15;
  ctx.requestBody.input.reference_audio_urls = ['https://cdn.invalid/a.mp3', 'https://cdn.invalid/b.mp3'];
  const before = JSON.stringify(plugin.extractUsage(ctx));
  ctx.requestBody.input.audio_durations = [2.5, 10];
  const request = plugin.buildSubmitRequest(ctx);
  assert.equal(JSON.stringify(request.body.audio_durations), '[2.5,10]');
  assert.equal(request.body.reference_audio_urls.length, 2);
  assert.equal(JSON.stringify(plugin.extractUsage(ctx)), before);
  ctx.requestBody.input.audio_durations = '[2.5,10]';
  assert.equal(JSON.stringify(plugin.buildSubmitRequest(ctx).body.audio_durations), '[2.5,10]');
  delete ctx.requestBody.input.audio_durations;
  assert.equal(Object.hasOwn(plugin.buildSubmitRequest(ctx).body, 'audio_durations'), false);
});

test('lxmone audio duration input is model-scoped, one-to-one and finite positive', () => {
  const plugin = lxmAudioDurationRuntime();
  const ctx = requestContext('wan3-720');
  ctx.requestBody.input.seconds = 15;
  ctx.requestBody.input.reference_audio_urls = ['https://cdn.invalid/a.mp3'];
  for (const value of [[], [1, 2], 1, '1', '[', null, [0], [-1], ['2'], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1]]) {
    ctx.requestBody.input.audio_durations = value;
    assert.throws(() => plugin.buildSubmitRequest(ctx), /audio_durations/, String(value));
  }
  ctx.requestBody.input.audio_durations = [1];
  ctx.model = ctx.upstreamModel = ctx.requestBody.input.model = 'seedance2.5';
  assert.throws(() => plugin.buildSubmitRequest(ctx), /unsupported field: audio_durations/);
});
