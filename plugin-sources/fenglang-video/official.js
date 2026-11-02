// Official wire format shares the host's parameter policies, task lifecycle,
// credential boundary and settlement engine with the original Fenglang API.
const officialID = Object.keys(meta.parameterInterfaces).find(id => meta.parameterInterfaces[id].path === '/api/v3/contents/generations/tasks');

function officialTask(ctx) {
  return ctx.requestBody?.protocolTemplate === officialID || ctx.state?.protocolTemplate === officialID;
}

function officialInput(ctx) {
  const request = ctx.requestBody || {};
  if (request.operation !== 'video_generate' || request.protocolTemplate !== officialID) throw new Error('请先确认 sd-官key 官方协议参数配置');
  if (request.uploads?.length || ctx.files?.length) throw new Error('官方协议仅支持公网 HTTPS 素材 URL');
  const model = ctx.upstreamModel || ctx.model;
  const rule = meta.parameterInterfaces[officialID].modelRules[model];
  if (!rule) throw new Error('该模型的 sd-官key 接口适用性尚未验证');
  if (!object(request.input)) throw new Error('请求参数必须为 JSON 对象');
  const input = {};
  const aliases = {seconds: ['seconds','duration','duration_seconds'], aspect_ratio: ['aspect_ratio','ratio','size'], start_image_url: ['start_image_url','input_reference'], end_image_url: ['end_image_url','last_frame'], images: ['images','reference_image_urls'], videos: ['videos','reference_video_urls'], audios: ['audios','reference_audio_urls']};
  const unrestricted = new Set(request.unrestrictedValueFields || []);
  for (const [field, parameter] of Object.entries(rule.parameters)) {
    if (field === 'model') continue;
    for (const alias of aliases[field] || [field]) {
      if (!own(request.input, alias)) continue;
      let value = request.input[alias];
      if (field === 'seconds' && typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
      if (parameter.type === 'integer' && !Number.isSafeInteger(value)) throw new Error(field + ' 必须为安全整数');
      if (parameter.type === 'boolean' && typeof value !== 'boolean') throw new Error(field + ' 必须为布尔值');
      if (parameter.type === 'string' && typeof value !== 'string') throw new Error(field + ' 必须为字符串');
      if (field === 'seconds' && (value < 1 || value > 3600)) throw new Error('seconds 必须为 1 至 3600 之间的整数');
      if (['start_image_url','end_image_url'].includes(field) && !httpsURL(value)) throw new Error(field + ' 必须为 HTTPS URL');
      if (parameter.type === 'array' && (!Array.isArray(value) || value.some(url => !httpsURL(url)))) throw new Error(field + ' 必须为 HTTPS URL 数组');
      const definition = parameter.definition;
      if (parameter.type === 'array' && value.length > definition.maxItems) throw new Error(field + ' 超出参考素材数量限制');
      if (!unrestricted.has(field)) {
        if (definition.enum && !definition.enum.includes(value)) throw new Error(field + ' 不在该模型文档范围内');
        if (definition.minimum !== undefined && value < definition.minimum || definition.maximum !== undefined && value > definition.maximum) throw new Error(field + ' 超出该模型文档范围');
      }
      if (own(input, field) && JSON.stringify(input[field]) !== JSON.stringify(value)) throw new Error(field + ' 的别名值冲突');
      input[field] = value;
    }
    if (parameter.required && (typeof input[field] !== 'string' || !input[field].trim())) throw new Error(field + ' 必填且不能为空');
  }
  if (input.draft === true && input.resolution !== '480p') throw new Error('draft 样片仅支持 480p');
  if (input.end_image_url && !input.start_image_url) throw new Error('尾帧需要同时提供首帧');
  // The official modes are mutually exclusive, including frame + reference image.
  if ((input.start_image_url || input.end_image_url) && ['images','videos','audios'].some(field => input[field]?.length)) throw new Error('首尾帧不能与多模态参考混用');
  return {model, input};
}

function officialRequest(ctx, id) {
  // Existing channels retain /open/v1; use its origin for the separate API root.
  const request = apiRequest(ctx, '');
  const origin = request.url.match(/^(https:\/\/[^/]+)(?:\/(?:open\/v1|api\/v3))?$/);
  if (!origin) throw new Error('sd-官key 渠道地址必须为站点根地址、/open/v1 或 /api/v3');
  request.url = origin[1] + '/api/v3/contents/generations/tasks' + (id === undefined ? '' : '/' + encodeURIComponent(taskID(id)));
  return request;
}

function officialSubmit(ctx) {
  const {model, input} = officialInput(ctx);
  const content = [{type: 'text', text: input.prompt}];
  for (const [field, role] of [['start_image_url','first_frame'],['end_image_url','last_frame']]) {
    if (input[field]) content.push({type: 'image_url', image_url: {url: input[field]}, role});
  }
  for (const [field, type, role] of [['images','image_url','reference_image'],['videos','video_url','reference_video'],['audios','audio_url','reference_audio']]) {
    for (const url of input[field] || []) content.push({type, [type]: {url}, role});
  }
  const body = {model, content, resolution: input.resolution};
  for (const [field, vendor] of Object.entries({seconds: 'duration', aspect_ratio: 'ratio', seed: 'seed', generate_audio: 'generate_audio', watermark: 'watermark', return_last_frame: 'return_last_frame', draft: 'draft', output_format: 'output_format', priority: 'priority'})) {
    if (own(input, field)) body[vendor] = input[field];
  }
  const request = officialRequest(ctx);
  return {...request, method: 'POST', headers: {...request.headers, 'Content-Type': 'application/json'}, body};
}

function officialResult(body) {
  if (!object(body)) return {status: 'UNKNOWN', reason: '任务响应不是 JSON 对象'};
  if (body.error || ['failed','expired','cancelled'].includes(body.status)) return {status: 'FAILURE', progress: '100%', reason: failureReason({message: body.error?.message || body.status})};
  if (['queued','pending'].includes(body.status)) return {status: 'QUEUED', progress: '0%'};
  if (['processing','running'].includes(body.status)) return {status: 'IN_PROGRESS', progress: '0%'};
  if (body.status !== 'succeeded') return {status: 'UNKNOWN', reason: '未识别官方协议任务状态'};
  const url = body.content?.video_url;
  if (!httpsURL(url)) return {status: 'UNKNOWN', reason: '官方协议成功响应缺少有效视频 URL'};
  return {status: 'SUCCESS', progress: '100%', url};
}

function officialUsage(ctx) {
  if (ctx.usagePurpose === 'billing_ratios') throw new Error('请先配置该模型的 Token 计费表达式');
  const {input} = officialInput(ctx);
  // Defaults below are supplier estimation rules only; never inserted in wire
  // bodies or the administrator's channel defaults. Five seconds per URL is
  // explicitly documented by Fenglang, rather than a fabricated media duration.
  const shortSide = {'480p': 480, '720p': 720, '1080p': 1080, '4k': 2160}[input.resolution];
  const ratio = input.aspect_ratio ?? '16:9';
  if (!shortSide || !/^\d+:\d+$/.test(ratio)) throw new Error('无法安全估算该分辨率或画面比例的 Token 用量');
  const [widthRatio, heightRatio] = ratio.split(':').map(Number);
  if (widthRatio <= 0 || heightRatio <= 0) throw new Error('无法安全估算画面比例的 Token 用量');
  const longSide = Math.max(2, Math.round(shortSide * Math.max(widthRatio,heightRatio) / Math.min(widthRatio,heightRatio) / 2) * 2);
  const frameTokens = shortSide * longSide / 1024;
  const images = (input.images?.length || 0) + Number(!!input.start_image_url) + Number(!!input.end_image_url);
  const tokens = Math.round(frameTokens * (24 * ((input.seconds ?? 4) + 5 * (input.videos?.length || 0)) + images + 5 * (input.audios?.length || 0)));
  if (!Number.isSafeInteger(tokens) || tokens <= 0) throw new Error('Token 用量估算超出安全范围');
  // Even unrestricted values must map to a declared billing tier.
  if (!meta.usageProfiles.find(profile => profile.models.includes(ctx.upstreamModel || ctx.model)).schema.resolution.enum.includes(input.resolution)) throw new Error('该分辨率没有已验证的 Token 计费档位');
  return {tokens, resolution: input.resolution, video_input: input.videos?.length ? 'video' : 'none'};
}
