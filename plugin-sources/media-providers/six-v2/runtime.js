// Bundled with one reviewed provider profile by build.mjs. No network discovery,
// retries, pricing constants, Node APIs or external imports run inside the host.
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value.trim() : '';
const copy = value => JSON.parse(JSON.stringify(value));

function fail(message) { throw new Error('invalid_request: ' + message); }
function pick(input, names, convert) {
  let result;
  for (const name of names) {
    if (!own(input, name)) continue;
    const value = convert ? convert(input[name], name) : input[name];
    if (result !== undefined && JSON.stringify(value) !== JSON.stringify(result)) fail('conflicting ' + names.join('/'));
    result = value;
  }
  return result;
}
function integer(value, name) {
  if (!((typeof value === 'number' && Number.isInteger(value)) || (typeof value === 'string' && /^\d+$/.test(value)))) fail(name + ' must be an integer');
  const n = Number(value);
  if (!Number.isSafeInteger(n)) fail(name + ' is outside the safe integer range');
  return n;
}
function boolean(value, name) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  fail(name + ' must be a boolean');
}
function oneOf(value, values, name) {
  if (!values.includes(value)) fail(name + ' must be one of ' + values.join(', '));
  return value;
}
function bounded(n, min, max, name) {
  if (n < min || n > max) fail(name + ' must be between ' + min + ' and ' + max);
  return n;
}
function array(value, name) {
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try { value = JSON.parse(value); } catch (_) { fail(name + ' must be an array'); }
  }
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
function profile(ctx) {
  const name = ctx.upstreamModel || ctx.model;
  const template = (ctx.requestBody || {}).protocolTemplate || (ctx.state || {}).protocolTemplate;
  if (template) {
    if (own(PROVIDER.interfaces || {}, template)) {
      const entry=PROVIDER.interfaces[template];
      const result={...entry.codec, ...(entry.modelRules?.[name]?.codec || {}), parameterDefinitions:entry.modelRules?.[name]?.parameters || entry.parameters, upstreamModel:name};
      const additions=(ctx.requestBody || {}).manualInterfaceFields;
      if(additions && Object.keys(additions).length){
        result.wire=copy(result.wire);result.parameterDefinitions=copy(result.parameterDefinitions);
        for(const [vendor,rule] of Object.entries(additions)){
          if(!/^[A-Za-z0-9_-]{1,128}$/.test(vendor)||/^(authorization|api_?key|token|password|secret|cookie|__proto__|prototype|constructor)$/i.test(vendor)||own(result.wire,vendor)||own(result.parameterDefinitions,rule.field)||!['images','videos','audios','start_image_url','end_image_url'].includes(rule.field))fail('invalid manual reference field');
          const frame=['start_image_url','end_image_url'].includes(rule.field);
          if(!['url','urls','objects'].includes(rule.shape)||frame&&rule.shape!=='url'||!Number.isInteger(rule.maxItems)||rule.maxItems<0||rule.maxItems>100)fail('invalid manual reference format');
          const item=rule.shape==='objects'?{type:'object',properties:{url:{type:'string'}},required:['url']}:{type:'string'};
          const schema=frame?{type:'string'}:{type:'array',items:item,...(rule.maxItems?{maxItems:rule.maxItems}:{})};
          result.parameterDefinitions[rule.field]={type:schema.type,required:false,definition:schema};
          result.wire[vendor]={field:rule.field,required:false,schema:rule.shape==='url'?{type:'string'}:schema};
        }
        result.referenceMetadata=true;
      }
      return result;
    }
    if (!own(PROVIDER.models, template) || PROVIDER.models[template].compatibilityAlias) fail('unknown protocol template');
    // Preserve the actual selected upstream ID. Never turn this into a model alias.
    return {...PROVIDER.models[template], upstreamModel:name};
  }
  if (own(PROVIDER.models, name)) return PROVIDER.models[name];
  const mapped = Object.values(PROVIDER.models).find(p => p.upstreamModel === name);
  if (!mapped) fail('model needs interface settings before it can run: ' + name);
  return mapped;
}
function apiRoot(ctx) {
  const root = text(ctx.baseUrl || PROVIDER.baseUrl).replace(/\/+$/, '').replace(/\/v1$/, '');
  // Only operator-controlled channel roots; never use a client poll_url or base_url.
  if (!/^https:\/\/[^\s/@?#]+(?::\d+)?(?:\/[^\s?#]*)?$/.test(root)) fail('configure a valid HTTPS channel Base URL');
  return root;
}
function auth(ctx) {
  const token = text(ctx.authHeader) || (text(ctx.apiKey) ? 'Bearer ' + text(ctx.apiKey) : '');
  if (!token || /[\r\n]/.test(token)) fail('channel API key is missing or invalid');
  return { Authorization: token, Accept: 'application/json' };
}
function request(ctx, path, body) {
  const result = { url: apiRoot(ctx) + path, method: body === undefined ? 'GET' : 'POST', headers: auth(ctx) };
  if (body !== undefined) {
    if (PROVIDER.key === 'xcmapi_media' && ctx.requestBody?.operation === 'video_generate') {
      // XCM transport identity belongs to the plugin, outside model field policy.
      // Reuse the host task ID for both documented interfaces and legacy profiles.
      if (typeof ctx.publicTaskId !== 'string' || !/^[A-Za-z0-9_.:-]{16,128}$/.test(ctx.publicTaskId)) fail('a valid stable gateway task id is required');
      body = {...body, client_request_id: ctx.publicTaskId};
    }
    result.headers['Content-Type'] = 'application/json'; result.body = body;
  }
  return result;
}
function taskID(value) {
  if (!text(value) || value.length > 512 || /[\r\n]/.test(value)) throw new Error('upstream_task_id_missing');
  return value;
}
function unpack(ctx, operation) {
  const decoded = ctx.body || {};
  let input;
  if (decoded.kind === 'json') input = copy(decoded.value);
  else if (decoded.kind === 'form' || decoded.kind === 'multipart') {
    input = {};
    for (const key of Object.keys(decoded.fields || {})) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('invalid field name');
      const values = decoded.fields[key];
      input[key] = values.length === 1 ? values[0] : values.slice();
    }
  } else fail('JSON or multipart body is required');
  if (!object(input)) fail('body must be an object');
  const model = ctx.model || text(input.model);
  const body = { operation, input, uploads: copy(decoded.files || []) };
  const contract = PROVIDER.models[ctx.upstreamModel || model];
  if (contract && contract.firstLastOnly) body.contractMode = 'frames';
  const driver = { model, upstreamModel: ctx.upstreamModel || model, requestBody: body, files: decoded.files || [] };
  // Aliases may be resolved only on the second decode. The driver always revalidates.
  // The six channel editors apply aliases/defaults after final protocol decode.
  // Validate them in buildSubmitRequest before reservation, not before the
  // channel overlay has a chance to translate the original standard input.
  const configuredProviders = ['paisio_media','yuxibox_media','xcmapi_media','artbox_media','lxmone_media','zhangyuge_media'];
  if (!configuredProviders.includes(PROVIDER.key) && own(PROVIDER.models, driver.upstreamModel)) normalize(driver);
  return { kind: 'submit', model, action: operation, requestBody: body };
}
function media(value, type, p) {
  if (type === 'audio' && p.voicePresets) {
    if (!object(value) || Object.keys(value).length !== 1 || !/^[A-Za-z0-9_-]{1,100}$/.test(value.voice_id || '')) fail('this model accepts preset reference_audios with voice_id');
    if (p.voiceChoices) oneOf(value.voice_id,p.voiceChoices,'preset voice');
    return {voice_id:value.voice_id};
  }
  if (object(value) && p.referenceMetadata) {
    if (Object.keys(value).some(key=>!['url','role','type','name','duration_seconds'].includes(key))) fail('unsupported reference object field');
    const reference = copy(value); reference.url = media(value.url,type,{...p,referenceMetadata:false});
    if (own(value,'duration_seconds') && (typeof value.duration_seconds!=='number'||!Number.isFinite(value.duration_seconds)||value.duration_seconds<=0||value.duration_seconds>120)) fail('reference duration must be positive and at most 120 seconds');
    return reference;
  }
  if (object(value)) {
    if (p.nativeH3 && Object.keys(value).some(key=>key!=='url')) fail('native h3 image objects accept only url');
    if (Object.keys(value).some(key => !['url', 'role'].includes(key))) fail('unsupported reference object');
    value = value.url;
  }
  if (typeof value !== 'string' || !value.trim()) fail(type + ' reference must be a URL or documented data URL');
  value = value.trim();
  if (p.publicReferences && !publicReferenceURL(value)) fail('this interface requires a public HTTPS reference URL');
  if (/^https:\/\/[^\s]+$/.test(value) || (!p.httpsOnly && /^http:\/\/[^\s]+$/.test(value))) return value;
  const permitsData = type === 'image' ? p.dataImages : type === 'video' ? p.dataVideos : p.dataAudios;
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!permitsData || !match || !match[1].startsWith(type + '/')) fail(type + ' reference format is not supported by this model');
  if (type === 'image' && !['image/png', 'image/jpeg', 'image/webp'].includes(match[1])) fail('unsupported image MIME type');
  const bytes = Math.floor(match[2].length * 3 / 4);
  bounded(bytes, 1, p.maxImageBytes || p.maxFileBytes || 20 * 1024 * 1024, 'reference bytes');
  return value;
}
function uploadedMedia(file, ctx, p) {
  const actual = (ctx.files || []).find(entry => entry.ref === file.ref);
  if (!actual || actual.field !== file.field) fail('unrecognized upload reference');
  const type = text(actual.mimeType).split('/')[0];
  if (!['image', 'video', 'audio'].includes(type)) fail('unsupported upload MIME type');
  const size = integer(actual.size, 'upload size');
  bounded(size, 1, p.maxImageBytes || p.maxFileBytes || 20 * 1024 * 1024, 'upload size');
  if (type === 'image' && !['image/png', 'image/jpeg', 'image/webp'].includes(actual.mimeType)) fail('unsupported image MIME type');
  return { type, file: actual };
}
const IMAGE_REFS = ['images', 'image', 'image[]', 'reference_images', 'image_urls', 'reference_image_urls', 'input_reference'];
const VIDEO_REFS = ['videos', 'video_urls', 'reference_videos', 'reference_video_urls', 'extra_videos'];
const AUDIO_REFS = ['audios', 'audio_urls', 'reference_audios', 'reference_audio_urls', 'extra_audios'];
const VIDEO_KEYS = ['materials','first_frame','model', 'prompt', 'seconds', 'duration', 'duration_seconds', 'aspect_ratio', 'ratio', 'resolution', 'size', 'generate_audio', 'first_last_frame', 'image_url', 'extra_images', 'start_image_url', 'end_image_url', 'last_frame', 'image', ...IMAGE_REFS, ...VIDEO_REFS, ...AUDIO_REFS];
const IMAGE_KEYS = ['async', 'model', 'prompt', 'n', 'size', 'quality', 'imageSize', 'image_size', 'resolution', 'aspectRatio', 'aspect_ratio', 'response_format', 'background', 'output_format', 'mask', 'image_url', ...IMAGE_REFS];
function normalize(ctx) {
  const p = profile(ctx), body = ctx.requestBody || {}; let input = body.input;
  if (!object(input)) fail('normalized request is missing');
  if (p.documentInterface) return normalizeDocumentInterface(ctx, p, body);
  if (PROVIDER.key === 'xcmapi_media' && p.kind === 'video' && own(input, 'client_request_id')) {
    input = copy(input); delete input.client_request_id;
  }
  if (input.materials !== undefined) {
    if (!p.materials || !Array.isArray(input.materials)) fail('materials is not supported by this model');
    if (['images','videos','audios'].some(key=>array(input[key],key).length)) fail('materials cannot be combined with media arrays');
    input = {...input};
    for (const item of input.materials) {
      if (!object(item)||!['image','video','audio'].includes(item.type)) fail('invalid material type');
      const {type,...reference}=item; const field=type+'s'; (input[field]??=[]).push(reference);
    }
    delete input.materials;
  }
  const operation = body.operation;
  if (p.kind === 'video' ? operation !== 'video_generate' : !['image_generate', 'image_edit'].includes(operation)) fail('model and operation do not match');
  let keys = p.kind === 'video' ? (p.audioDurations ? VIDEO_KEYS.concat('audio_durations') : VIDEO_KEYS) : IMAGE_KEYS;
  if (p.kind === 'video' && p.parameterContract?.fields?.seed?.status === 'documented') keys = keys.concat('seed');
  for (const key of Object.keys(input)) if (!keys.includes(key)) fail('unsupported field: ' + key);
  const prompt = text(input.prompt);
  if ((!prompt && !p.promptOptional) || prompt.length > (p.maxPrompt || 100000)) fail('prompt is empty or too long');
  const result = { p, operation, prompt, model: p.upstreamModel || ctx.upstreamModel || ctx.model, images: [], videos: [], audios: [], files: [], videoFiles: [], input };
  let imageAliases = IMAGE_REFS;
  if (p.frameObjects) imageAliases = IMAGE_REFS.filter(key => key !== 'image');
  result.images = pick(input, imageAliases, array) || [];
  if (own(input, 'image_url')) {
    if (result.images.length) fail('image_url conflicts with another image collection');
    result.images = array(input.image_url, 'image_url');
  }
  if (own(input, 'extra_images')) {
    if (!p.mainImage) fail('extra_images is unsupported');
    result.images = result.images.concat(array(input.extra_images, 'extra_images'));
  }
  result.videos = pick(input, VIDEO_REFS, array) || [];
  result.audios = pick(input, AUDIO_REFS, array) || [];
  for (const type of ['image', 'video', 'audio']) result[type + 's'] = result[type + 's'].map(value => media(value, type, p));
  for (const file of body.uploads || []) {
    const entry = uploadedMedia(file, ctx, p);
    if (entry.file.field === 'mask') {
      // Only HTTPS masks are documented by the currently enabled mask-capable models.
      fail('upload the mask to HTTPS storage and pass mask as a URL');
    }
    if (!IMAGE_REFS.concat(VIDEO_REFS, AUDIO_REFS).includes(entry.file.field)) fail('unsupported upload field');
    if (p.kind === 'video' && p.videoMultipart) result.videoFiles.push(entry.file);
    else if (p.kind === 'image' && p.editMultipart) result.files.push(entry.file);
    else {
      const allowed = entry.type === 'image' ? p.dataImages : entry.type === 'video' ? p.dataVideos : p.dataAudios;
      if (!allowed) fail('this model requires public reference URLs');
      result[entry.type + 's'].push({ __fileRef: entry.file.ref, encoding: 'dataUrl', mimeType: entry.file.mimeType, maxBytes: p.maxImageBytes || p.maxFileBytes || 20 * 1024 * 1024 });
    }
  }
  if (result.files.some(f => !f.mimeType.startsWith('image/'))) fail('image edits accept only image files');
  const first = pick(input, p.frameObjects ? ['start_image_url', 'first_frame','image'] : ['start_image_url','first_frame']);
  const last = pick(input, ['end_image_url', 'last_frame']);
  if (first !== undefined || last !== undefined) {
    if (!p.frames) fail('first/last frame fields are unsupported');
    if (last !== undefined && first === undefined && !p.lastFrameAlone) fail('a last frame requires a first frame');
    if (first !== undefined) result.first = media(first, 'image', p);
    if (last !== undefined) result.last = media(last, 'image', p);
    if (result.images.length && !p.allowFramesWithImages) fail('first/last frames cannot be combined with reference_images');
  }
  if (p.nativeH3 && (result.first||result.last) && result.audios.length) fail('native frame and preset-audio combination is not documented; use reference_images for mixed references');
  if (p.requireVideoDuration && result.videos.some(value=>!object(value)||typeof value.duration_seconds!=='number')) fail('each reference video requires duration_seconds');
  const imageCount = result.images.length + result.files.length + result.videoFiles.filter(f => f.mimeType.startsWith('image/')).length + (result.first ? 1 : 0) + (result.last ? 1 : 0);
  const videoCount = result.videos.length + result.videoFiles.filter(f => f.mimeType.startsWith('video/')).length;
  const audioCount = result.audios.length + result.videoFiles.filter(f => f.mimeType.startsWith('audio/')).length;
  if (result.videoFiles.length && result.images.length + result.videos.length + result.audios.length) fail('use either uploaded video-task references or URL/data references; mixed ordering is ambiguous');
  bounded(imageCount, p.minImages || (p.firstLastOnly ? 1 : 0), p.maxImages || 0, 'reference images');
  bounded(videoCount, 0, p.maxVideos || 0, 'reference videos');
  bounded(audioCount, p.minAudios || 0, p.maxAudios || 0, 'reference audios');
  bounded(imageCount + videoCount + audioCount, 0, p.maxTotal || 128, 'total references');
  if (p.anyImageOrAudio && !imageCount && !result.audios.length) fail('at least one image or audio reference is required');
  if (p.blockReferenceVideoBilling && result.videos.length) fail('reference video duration billing is not documented as a verifiable usage fact; this mode is unavailable');
  if (p.referenceContractPending && imageCount + result.videos.length + result.audios.length) fail('model-specific reference payload is not documented; only text-to-video is enabled');
  if (p.kind === 'image') return normalizeImage(result);
  if (own(input, 'audio_durations')) {
    let durations = input.audio_durations;
    if (typeof durations === 'string') {
      try { durations = JSON.parse(durations); } catch (_) { fail('audio_durations must be an array'); }
    }
    if (!Array.isArray(durations) || durations.length !== result.audios.length) fail('audio_durations must match reference audios one-to-one');
    if (durations.some(value => typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER)) fail('audio_durations must contain finite positive seconds');
    result.audioDurations = durations.slice();
  }
  let seconds = pick(input, ['seconds', 'duration', 'duration_seconds'], integer);
  if (!p.secondsField && !p.fixedSeconds) {
    if (seconds !== undefined) fail('this model has no documented duration parameter');
  } else {
    if (seconds === undefined) seconds = p.defaultSeconds;
    if (seconds === undefined) fail('seconds is required');
    bounded(seconds, p.minSeconds, p.maxSeconds, 'seconds');
    if (p.secondsChoices) oneOf(seconds, p.secondsChoices, 'seconds');
    if (p.maxSecondsWithVideo && result.videos.length) bounded(seconds, p.minSeconds, p.maxSecondsWithVideo, 'seconds with reference video');
    if (p.multiImageMaxSeconds && imageCount > 1) bounded(seconds, p.minSeconds, p.multiImageMaxSeconds, 'seconds with multiple images');
    result.seconds = seconds;
  }
  let resolution = input.resolution === undefined ? p.defaultResolution || (p.resolutions || [])[0] : text(input.resolution).toLowerCase();
  if (p.resolutionAliases && own(p.resolutionAliases,resolution)) resolution=p.resolutionAliases[resolution];
  if (own(input, 'resolution') && !(p.resolutions || []).length && !p.resolutionOptional && !p.freeResolution) fail('resolution is fixed by the model');
  if (resolution !== undefined) {
    if (p.resolutions && p.resolutions.length) oneOf(resolution.toLowerCase(), p.resolutions.map(v => v.toLowerCase()), 'resolution');
    else if (!p.freeResolution) oneOf(resolution, ['480p', '720p', '1080p'], 'resolution');
    result.resolution = resolution.toLowerCase();
    if (p.referenceResolutionCeiling && imageCount+audioCount+videoCount>0 && result.resolution==='1080p') fail('reference resolution above '+p.referenceResolutionCeiling+' is not verified by the native contract');
    if (p.maxByResolution && p.maxByResolution[result.resolution]) bounded(seconds, p.minSeconds, p.maxByResolution[result.resolution], 'seconds at ' + result.resolution);
  }
  result.ratio = pick(input, ['aspect_ratio', 'ratio'], text);
  if (result.ratio !== undefined) {
    if (!p.ratioField) fail('aspect ratio is not a documented parameter');
    oneOf(result.ratio, p.ratios, 'aspect ratio');
  }
  if (own(input, 'size')) {
    if (!(p.videoSizes || []).length && !p.sizeDefault) fail('size is not supported; use the model resolution/aspect ratio fields');
    result.size = oneOf(text(input.size), p.videoSizes || ['1280x720', '720x1280', '720x720', '854x480', '480x854'], 'size');
    if (result.ratio !== undefined) {
      if (!p.sizeRatioMustMatch) fail('size and ratio are mutually exclusive');
      const expected = {'1280x720':'16:9','720x1280':'9:16','720x720':'1:1'}[result.size];
      if (expected !== result.ratio) fail('size and ratio must agree');
    }
  } else if (p.sizeDefault && result.ratio === undefined) result.size = p.sizeDefault;
  if (own(input, 'generate_audio')) {
    if (!p.audio) fail('generate_audio is not supported');
    result.audio = boolean(input.generate_audio, 'generate_audio');
  } else if (p.audio && p.audioDefault !== undefined) result.audio = p.audioDefault;
  if (p.allowAsync && own(input,'async')) result['async']=boolean(input['async'],'async');
  if (!p.allowAsync && own(input,'async')) fail('async is not documented for this model');
  if (own(input, 'first_last_frame')) {
    if (!p.firstLast) fail('first_last_frame is not supported');
    result.firstLast = boolean(input.first_last_frame, 'first_last_frame');
    if (result.firstLast) {
      bounded(imageCount, 1, p.firstLastMax || 2, 'first/last frame images');
      if (videoCount || audioCount) fail('first/last mode cannot include video or audio references');
    }
  }
  if (p.onlyFirstFrame && imageCount && result.firstLast !== true) fail('this model requires first_last_frame=true for an image reference');
  return result;
}
const ZHANG_SIZES = {
  '1K': ['1024x1024','1280x720','720x1280','1248x832','832x1248','1152x864','864x1152','1120x896','896x1120','1456x624'],
  '2K': ['2048x2048','2560x1440','1440x2560','2496x1664','1664x2496','2304x1728','1728x2304','2240x1792','1792x2240','3024x1296'],
  '4K': ['2880x2880','3840x2160','2160x3840','3504x2336','2336x3504','3264x2448','2448x3264','3200x2560','2560x3200','3696x1584']
};
function normalizeImage(r) {
  const p = r.p, input = r.input;
  if (p.allowAsync && own(input,'async')) r['async']=boolean(input['async'],'async');
  if (!p.allowAsync && own(input,'async')) fail('async is not documented for this model');
  r.n = own(input, 'n') ? bounded(integer(input.n, 'n'), 1, p.nMax, 'n') : 1;
  if (r.operation === 'image_edit') {
    if (!p.edit) fail('image editing is not documented for this model');
    if (!r.images.length && !r.files.length) fail('image editing requires reference images');
    if (p.fileOnlyEdit && r.images.length) fail('this model requires uploaded multipart image files for edits');
  } else if (r.images.length || r.files.length || own(input, 'mask')) fail('reference images require the image edit operation');
  if (own(input, 'mask')) {
    if (!p.mask) fail('mask is not supported');
    r.mask = media(input.mask, 'image', { httpsOnly: true });
  }
  r.imageSize = pick(input, ['imageSize', 'image_size', 'resolution'], v => text(v).toUpperCase());
  if (r.imageSize !== undefined && !p.imageSizes) fail('image size tier is fixed by the model');
  if (p.imageSizes) r.imageSize = oneOf(r.imageSize === undefined ? p.imageSizes[0] : r.imageSize, p.imageSizes, 'image size');
  r.ratio = pick(input, ['aspectRatio', 'aspect_ratio'], text);
  if (r.ratio !== undefined) {
    if (!['paisio', 'zhangyuge','gemini'].includes(p.imageMode)) fail('aspect_ratio is unsupported; use size');
    oneOf(r.ratio, p.imageRatios || (p.imageMode === 'paisio' ? ['1:1','16:9','9:16','3:2','2:3','4:3','3:4','21:9','9:21'] : ['1:1','16:9','9:16','3:2','2:3','4:3','3:4','5:4','4:5','21:9']), 'aspect ratio');
  }
  r.size = own(input, 'size') ? text(input.size) : p.sizeDefault;
  if (r.size !== undefined) {
    if (!r.size) fail('size must be a nonempty string');
    if (r.ratio !== undefined) fail('size and aspect_ratio are mutually exclusive');
    if (p.sizeTiers) {
      if (!own(p.sizeTiers, r.size)) fail('unsupported size for this model');
      r.imageSize = p.sizeTiers[r.size];
    } else if (p.imageMode === 'cangyuan') {
      if (!(p.sizeRatios || []).includes(r.size) && !(p.sizeAuto && r.size === 'auto')) {
        if (!p.pixelSize) fail('use a documented aspect ratio as size');
        validateProfilePixels(r.size, p.pixelConstraints);
      }
    } else if (p.imageMode === 'zhangyuge') {
      if (!p.pixelSize) fail('this image model accepts aspect_ratio, not pixel size');
      const tier = Object.keys(ZHANG_SIZES).find(key => ZHANG_SIZES[key].includes(r.size));
      if (!tier || !p.imageSizes.includes(tier)) fail('pixel size is outside this model tier');
      if (pick(input, ['imageSize', 'image_size', 'resolution']) !== undefined && r.imageSize !== tier) fail('size and image_size disagree');
      r.imageSize = tier;
    } else if (p.imageMode === 'paisio') {
      if (!p.pixelSize) fail('Gemini uses image_size and aspect_ratio');
      const dimensions = validatePixels(r.size, 3840);
      if (dimensions.some(v => v % 16) || Math.max(...dimensions) / Math.min(...dimensions) > 3) fail('invalid GPT pixel dimensions');
      bounded(dimensions[0] * dimensions[1], 655360, 8294400, 'image pixels');
      // Pixel size changes cost. Force an explicit matching tier rather than under-reserve.
      const edge = Math.max(...dimensions);
      const tier = edge > 2048 ? '4K' : edge > 1024 ? '2K' : '1K';
      if (pick(input, ['imageSize', 'image_size', 'resolution']) !== undefined && r.imageSize !== tier) fail('size and image_size disagree');
      r.imageSize = tier;
    } else if (p.imageMode === 'gemini') fail('this Gemini endpoint has no documented size parameter');
    else if (r.size !== 'auto') validatePixels(r.size, 16384);
  }
  if (own(input, 'quality')) {
    r.quality = oneOf(text(input.quality), p.qualities || [], 'quality');
  }
  if (p.qualityTier) r.qualityTier = ['xhigh', 'max'].includes(r.quality) ? 'enhanced' : 'standard';
  if (own(input, 'response_format')) oneOf(text(input.response_format), ['url','b64_json'], 'response_format');
  if (own(input, 'background')) {
    if (!Array.isArray(p.backgrounds) || !p.backgrounds.length) fail('background is unsupported');
    r.background = oneOf(text(input.background), p.backgrounds, 'background');
  }
  if (own(input, 'output_format')) {
    // Preserve the existing Paisio GPT contract; other models must opt in.
    const formats = p.outputFormats === undefined && p.imageMode === 'paisio' && p.pixelSize ? ['png','jpeg','webp'] : p.outputFormats;
    if (!Array.isArray(formats) || !formats.length) fail('output_format is unsupported');
    r.outputFormat = oneOf(text(input.output_format), formats, 'output_format');
  }
  return r;
}
function validatePixels(value, max) {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) fail('size must be WIDTHxHEIGHT');
  return [bounded(Number(match[1]), 1, max, 'width'), bounded(Number(match[2]), 1, max, 'height')];
}
function validateProfilePixels(value, limits) {
  if (!limits) return validatePixels(value, 16384);
  // These bounds belong to the reviewed model, not its supplier or name prefix.
  // They prevent a fixed-tier profile from accepting a higher-cost pixel tier.
  for (const key of ['minPixels', 'maxPixels', 'maxDimension', 'multiple']) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) fail('invalid model pixel constraints');
  }
  if (limits.minPixels > limits.maxPixels || !Number.isFinite(limits.maxAspectRatio) || limits.maxAspectRatio < 1) fail('invalid model pixel constraints');
  const dimensions = validatePixels(value, limits.maxDimension);
  if (dimensions.some(dimension => dimension % limits.multiple)) fail('pixel dimensions must be multiples of ' + limits.multiple);
  const pixels = dimensions[0] * dimensions[1];
  if (!Number.isSafeInteger(pixels)) fail('image pixels are outside the safe integer range');
  bounded(pixels, limits.minPixels, limits.maxPixels, 'image pixels');
  if (Math.max(...dimensions) / Math.min(...dimensions) > limits.maxAspectRatio) fail('image aspect ratio exceeds model limit');
  return dimensions;
}
function videoBody(r) {
  const p = r.p, body = { model: r.model, prompt: r.prompt };
  if (own(r.input, 'seed') && p.parameterContract?.fields?.seed?.status === 'documented') body.seed = integer(r.input.seed, 'seed');
  if (p.promptOptional && !r.prompt) delete body.prompt;
  if (p.secondsField) body[p.secondsField] = p.stringSeconds ? String(r.seconds) : r.seconds;
  if (r.resolution && p.resolutionField) {
    let resolution = r.resolution;
    if (p.resolutionEncoding === 'upper') resolution = resolution.toUpperCase();
    if (p.resolutionEncoding === 'pixels') resolution = { '480p':'854x480', '720p':'1280x720', '1080p':'1920x1080', '2k':'2K' }[resolution];
    body[p.resolutionField] = resolution;
  } else if (r.resolution && p.resolutionOptional) body.resolution = r.resolution;
  if (r.ratio !== undefined) body[p.ratioField] = r.ratio;
  if (r.size !== undefined) body.size = r.size;
  if (r.audio !== undefined) body.generate_audio = r.audio;
  if (r.firstLast !== undefined) body.first_last_frame = r.firstLast;
  if (r.audioDurations !== undefined) body.audio_durations = r.audioDurations;
  for (const type of ['image', 'video', 'audio']) {
    let refs = r[type + 's'];
    if (!refs.length) continue;
    if (p.mainImage && type === 'image') { body.image_url = refs[0]; if (refs.length > 1) body.extra_images = refs.slice(1); continue; }
    if (p.referenceObjects && !(type === 'audio' && p.voicePresets)) refs = refs.map(url => object(url)?url:p.referenceRole ? { url, role: p.referenceRole } : { url });
    if (p.assets) {body.assets??=[];for(const url of refs) body.assets.push({category:type,url});}
    else body[p[type + 'Field']] = refs;
  }
  if (p.framesAsReferenceArray && (r.first||r.last)) { body[p.imageField]=[r.first,r.last]; return body; }
  if (p.framesAsImages && (r.first||r.last)) {body.images=[];if(r.first)body.images.push({url:r.first,type:'first_frame'});if(r.last)body.images.push({url:r.last,type:'end_frame'});return body;}
  if (r.first) body[p.frameFields[0]] = p.frameObjects ? {url:r.first} : r.first;
  if (r.last) body[p.frameFields[1]] = p.frameObjects ? {url:r.last} : r.last;
  return body;
}
function imageRequest(ctx, r) {
  const p = r.p;
  if (p.imageMode === 'gemini') {
    const parts = [{text:r.prompt}];
    for (const reference of r.images) {
      if (object(reference)) parts.push({inlineData:{mimeType:reference.mimeType,data:{...reference,encoding:'base64'}}});
      else {
        const match = /^data:(image\/[^;,]+);base64,(.+)$/.exec(reference);
        if (!match) fail('Gemini references require uploaded files or image data URLs');
        parts.push({inlineData:{mimeType:match[1],data:match[2]}});
      }
    }
    const generationConfig={responseModalities:['TEXT','IMAGE']};if(r.imageSize||r.ratio){generationConfig.imageConfig={};if(r.imageSize)generationConfig.imageConfig.imageSize=r.imageSize;if(r.ratio)generationConfig.imageConfig.aspectRatio=r.ratio;}
    return request(ctx, p.submit.replace('{model}', encodeURIComponent(r.model)), {contents:[{role:'user',parts}],generationConfig});
  }
  const body = {model:r.model,prompt:r.prompt};
  if (p.imageMode !== 'zhangyuge') body.n = r.n;
  if (r.size !== undefined) body.size = r.size;
  if (r.quality !== undefined) body.quality = r.quality;
  if (r.background !== undefined) body.background = r.background;
  if (r.outputFormat) body.output_format = r.outputFormat;
  if (r.mask) body.mask = r.mask;
  if (r['async']!==undefined) body['async']=r['async'];
  if (p.omitCount) delete body.n;
  if (p.imageMode === 'paisio') {
    // Do not combine pixel size with imageSize: upstream documents precedence, not equality.
    if (r.size === undefined) body.imageSize = r.imageSize;
    if (r.ratio !== undefined) body.aspectRatio = r.ratio;
    if (r.images.length) body.image = r.images;
  } else if (p.imageMode === 'zhangyuge') {
    if (r.ratio !== undefined) body.aspect_ratio = r.ratio;
    if (p.imageSizes.length > 1 || r.input.image_size !== undefined || r.input.resolution !== undefined) body.image_size = r.imageSize;
    if (r.images.length) body.images = r.images;
  } else {
    body.response_format = 'url';
    if (r.images.length) body[p.imageInputField||'images'] = r.images;
  }
  const path = r.operation === 'image_edit' ? p.edit : p.submit;
  const descriptor = request(ctx, path, body);
  if (r.operation === 'image_edit' && p.editMultipart && (r.files.length || p.imageMode === 'openai')) {
    if (p.imageMode === 'lxmone' && r.images.length) fail('do not mix uploaded files with JSON image references');
    delete body.images;
    delete descriptor.body;
    delete descriptor.headers['Content-Type'];
    descriptor.bodyType = 'multipart';
    descriptor.parts = Object.keys(body).map(name => ({name,value:String(body[name])}));
    for (const value of r.images) descriptor.parts.push({name:'image[]',value});
    for (const file of r.files) descriptor.parts.push({name:'image[]',fileRef:file.ref,filename:file.filename});
  }
  return descriptor;
}
export function buildSubmitRequest(ctx) {
  if (ctx.upstream && ctx.upstream.kind !== 'vendor') fail('this plugin connects directly to the vendor');
  const r = normalize(ctx);
  if (r.p.documentInterface) return documentInterfaceRequest(ctx, r);
  if (r.p.kind === 'image') return imageRequest(ctx, r);
  const body = videoBody(r);
  const descriptor = request(ctx, r.p.submit, body);
  if (r.videoFiles.length) {
    delete descriptor.body;
    delete descriptor.headers['Content-Type'];
    descriptor.bodyType = 'multipart';
    descriptor.parts = Object.keys(body).map(name => ({name,value:String(body[name])}));
    for (const file of r.videoFiles) descriptor.parts.push({name:'input_reference',fileRef:file.ref,filename:file.filename});
  }
  return descriptor;
}
function unwrap(body) {
  if (!object(body)) return {};
  if (object(body.data) && (body.data.status !== undefined || body.data.task_id || body.data.request_id || body.data.id)) return body.data;
  return body;
}
function imageEntries(raw) {
  const body = unwrap(raw);
  if (PROVIDER.key === 'yuxibox_media' && Array.isArray(body.candidates)) {
    const result = [];
    for (const candidate of body.candidates) for (const part of (candidate.content || {}).parts || []) {
      const data = part.inlineData || part.inline_data;
      if (data && /^image\//.test(data.mimeType || data.mime_type || '') && text(data.data)) result.push({b64_json:data.data});
    }
    return result;
  }
  let data = body.data;
  if (PROVIDER.key === 'lxmone_media' && object(body.result)) data = body.result.data;
  if (object(data)) data = [data];
  if (!Array.isArray(data)) {
    let url;
    if (PROVIDER.key === 'zhangyuge_media') url = body.image_url || body.url || body.video_url || (body.metadata || {}).image_url;
    if (PROVIDER.key === 'lxmone_media') url = body.image_url;
    data = url ? [{url}] : [];
  }
  return data.filter(object).map(entry => {
    const item = {};
    if (safeMediaURL(entry.url)) item.url = entry.url;
    if (text(entry.b64_json)) item.b64_json = entry.b64_json;
    if (text(entry.revised_prompt)) item.revised_prompt = entry.revised_prompt;
    return item;
  }).filter(entry => entry.url || entry.b64_json);
}
function imageCount(body) {
  const entries = imageEntries(body);
  // Host's documented OpenAI rule: split URL and base64 representations are not
  // two independently generated images. Gemini parts are individually generated.
  if (PROVIDER.key === 'yuxibox_media' && Array.isArray(unwrap(body).candidates)) return entries.length;
  return Math.max(entries.filter(e => e.url).length, entries.filter(e => e.b64_json).length);
}
function safeMediaURL(url) { return typeof url === 'string' && /^https?:\/\/[^\s/@?#]+(?:[/?#][^\s]*)?$/.test(url); }
function videoURL(raw) {
  if (PROVIDER.outputURLPending) return '';
  const body = unwrap(raw);
  let candidates = [];
  if (PROVIDER.key === 'cangyuan_media') candidates = [body.video_url, Array.isArray(body.data) && (body.data[0] || {}).url];
  else if (PROVIDER.key === 'lxmone_media') candidates = [(body.metadata || {}).direct_url, body.video_url, body.url];
  else if (PROVIDER.key === 'xcmapi_media') candidates = [(body.video || {}).url, body.video_url, body.url, (body.result_urls || [])[0]];
  else if (PROVIDER.key === 'paisio_media') candidates = [body.video_url];
  else if (PROVIDER.key === 'yuxibox_media') candidates = [body.video_url, body.url, body.download_url];
  else candidates = [body.video_url, body.url];
  return candidates.find(safeMediaURL) || '';
}
function failureReason(body) {
  return text((body.error || {}).message) || text(body.error) || text(body.message) || text(body.msg) || text(body.detail) || text(body.fail_reason) || 'upstream task failed';
}
function taskResult(ctx, raw) {
  const p = profile(ctx), body = unwrap(raw), status = text(body.status).toLowerCase();
  if (['failed','error','expired','cancelled','canceled'].includes(status)) return {status:'FAILURE',progress:'100%',reason:failureReason(body)};
  if (['completed','succeeded','success','done'].includes(status)) {
    const url = p.kind === 'video' ? videoURL(body) : '';
    if (p.kind === 'image' && !imageCount(body)) return {status:'UNKNOWN',reason:'completed image task has no output'};
    if (p.kind === 'video' && !url && !PROVIDER.content) return {status:'UNKNOWN',reason:'completed video task has no documented output URL'};
    const result = {status:'SUCCESS',progress:'100%'};
    if (url) result.url = url;
    return result;
  }
  if (['pending','queued'].includes(status)) return {status:'QUEUED',progress:'0%'};
  if (['processing','running','in_progress'].includes(status)) {
    const n = Number(body.progress);
    return {status:'IN_PROGRESS',progress:(Number.isFinite(n) ? Math.min(99,Math.max(0,Math.round(n))) : 0) + '%'};
  }
  return {status:'UNKNOWN',reason:'unrecognized upstream status: ' + status};
}
export function parseSubmitResponse(ctx, response) {
  const r = normalize(ctx), body = response.body, data = unwrap(body);
  if (response.statusCode < 200 || response.statusCode >= 300) throw new Error('upstream_submit_http_' + response.statusCode);
  if (!object(body)) throw new Error('upstream_submit_failed');
  const state = {protocolTemplate:(ctx.requestBody || {}).protocolTemplate,pluginVersion:meta.version,configurationRevision:ctx.configurationRevision||0,operation:r.operation,query:r.operation === 'image_edit' ? r.p.editQuery || r.p.query : r.p.query};
  const id = data.task_id || data.id || data.request_id;
  const result = taskResult(ctx, body);
  // A terminal task can carry error details or stale outputs. Respect its status
  // before inspecting content, and never turn an accepted failure into a retry.
  if (result.status === 'FAILURE') return {taskId:id || ctx.publicTaskId || utils.uuid(),taskData:body,state,immediate:result};
  const rejected = [body,data,body.data].find(value=>object(value)&&(value.error || value.success === false));
  if (rejected) return {taskId:id || ctx.publicTaskId || utils.uuid(),taskData:body,state,immediate:{status:'FAILURE',progress:'100%',reason:failureReason(rejected)}};
  if (r.p.kind === 'image' && imageCount(body) && ['', 'completed','succeeded','success','done'].includes(text(data.status).toLowerCase())) {
    return {taskId:id || ctx.publicTaskId || utils.uuid(),taskData:body,state,immediate:{status:'SUCCESS',progress:'100%'}};
  }
  if (!r.p.query) throw new Error('upstream returned no synchronous image output');
  const parsed = {taskId:taskID(id),taskData:body,state};
  if (result.status === 'SUCCESS') parsed.immediate = result;
  return parsed;
}
export function buildQueryRequest(ctx) {
  const p = profile(ctx);
  const expected = (ctx.state || {}).operation === 'image_edit' ? p.editQuery || p.query : p.query;
  const path=(ctx.state||{}).query||expected;
  if(path!==expected)throw new Error('pinned query contract does not match this plugin version');
  if (!path) throw new Error('task cannot be polled');
  return request(ctx, path + encodeURIComponent(taskID(ctx.taskId)));
}
export function parseTaskResult(ctx, body) { return taskResult(ctx, body); }
export function extractUsage(ctx) {
  const r = normalize(ctx), p = r.p;
  const facts = {};
  if (p.billing === 'unconfirmed') {
    facts.request_count = 1;
    if (p.kind === 'image') facts.image_count = r.n;
    else if (r.seconds !== undefined) facts.seconds = r.seconds;
  } else facts[p.billing] = p.billing === 'request_count' ? 1 : p.billing === 'image_count' ? r.n : r.seconds;
  if (p.kind === 'video' && r.resolution !== undefined && (p.documentInterface || (p.usageResolutions || p.resolutions || []).length > 1)) facts.resolution = r.resolution;
  if (p.billImageSize) facts.image_size = r.imageSize;
  if (p.qualityTier) facts.quality_tier = r.qualityTier;
  if (p.audio) facts.generate_audio = r.audio === undefined ? false : r.audio;
  if (ctx.usagePurpose === 'billing_ratios') {
    fail('configure a plugin billing expression for this model');
  }
  return facts;
}
export function extractUsageOnComplete(ctx, result, body) {
  if (result.status !== 'SUCCESS') return {};
  const p = profile(ctx);
  if (p.kind === 'image') {
    const count = imageCount(body);
    // Missing or absurd output counts must not decrease a frozen reservation.
    return count > 0 && count <= 128 ? {image_count:count} : {};
  }
  // These supplier docs do not define a trustworthy *actual output duration*
  // field. Neither requested seconds echoes nor monetary cost are actual usage.
  return {};
}
export function listArtifacts(task) {
  if (task.status !== 'SUCCESS') return [];
  if (String(task.action).startsWith('image_')) return imageEntries(task.data).filter(item => item.url).map((_, i) => ({key:'image-' + (i + 1),type:'image'}));
  return videoURL(task.data) || PROVIDER.content ? [{key:'video',type:'video',mimeType:'video/mp4'}] : [];
}
export function buildContentRequest(ctx) {
  const method = ctx.clientRequest && ctx.clientRequest.method === 'HEAD' ? 'HEAD' : 'GET';
  // Prefer Paisio's public result URL without forwarding channel credentials.
  // Its authenticated content endpoint redirects to a different CDN origin.
  if (PROVIDER.key === 'paisio_media' && ctx.artifactKey === 'video') {
    const url = videoURL(ctx.data);
    if (safeMediaURL(url)) return {url,method,credentialless:true};
  }
  if (ctx.artifactKey === 'video' && PROVIDER.content) {
    const descriptor = request(ctx, PROVIDER.content + encodeURIComponent(taskID(ctx.upstreamTaskId)) + '/content');
    descriptor.method = method;
    return descriptor;
  }
  let url = '';
  if (ctx.artifactKey === 'video') url = videoURL(ctx.data);
  else if (/^image-[1-9]\d*$/.test(ctx.artifactKey || '')) {
    const images = imageEntries(ctx.data).filter(item => item.url);
    url = (images[Number(ctx.artifactKey.slice(6)) - 1] || {}).url || '';
  }
  if (!safeMediaURL(url)) throw new Error('artifact_not_found');
  // The host also drops channel credentials on redirects. CDN requests carry none.
  return {url,method,credentialless:true};
}
export const protocols = {};
if (Object.values(PROVIDER.models).some(p => p.kind === 'video')) protocols.openai_video = {
  decodeRequest(ctx) { return unpack(ctx, 'video_generate'); },
  render(ctx, task) { const url = videoURL(task.data); return url ? {video_url:url} : {}; }
};
if (Object.values(PROVIDER.models).some(p => p.kind === 'image')) protocols.openai_image = {
  decodeRequest(ctx) { return unpack(ctx, ctx.operation === 'edit' ? 'image_edit' : 'image_generate'); },
  render(ctx, task) { return {data:imageEntries(task.data)}; }
};
export const native = {
  submit(ctx) {
    const path = ctx.path || '';
    return unpack(ctx, path.endsWith('/images/edits') ? 'image_edit' : path.endsWith('/images/generations') ? 'image_generate' : 'video_generate');
  },
  render(ctx, task) {
    return {id:task.task_id,status:task.status,progress:task.progress || '0%',error:task.fail_reason || undefined,data:task.data};
  }
};

function publicReferenceURL(value) {
 if(typeof value!=='string'||value.length>8192||value.includes('#'))return false;
 const match=/^https:\/\/([^/?#]+)(?:[/?][^#]*)?$/.exec(value);if(!match)return false;
 let host=match[1].toLowerCase();if(host.includes('@')||host.includes('['))return false;
 if(host.includes(':')){if(!host.endsWith(':443'))return false;host=host.slice(0,-4)}
 if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||!host.includes('.'))return false;
 if(/^\d+\.\d+\.\d+\.\d+$/.test(host)){const n=host.split('.').map(Number);if(n.some(v=>v>255)||[0,10,127].includes(n[0])||n[0]>=224||n[0]===169&&n[1]===254||n[0]===172&&n[1]>=16&&n[1]<=31||n[0]===192&&n[1]===168)return false;}
 return true;
}
