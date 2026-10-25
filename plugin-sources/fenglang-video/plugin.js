// API v1 driver. Request policies are applied by the host before these hooks.
const own = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const interfaceID = Object.keys(meta.parameterInterfaces)[0];

function httpsURL(value) {
  return typeof value==='string' && /^https:\/\/[^\s/@?#\\]+(?:[/?][^\s#\\]*)?$/.test(value);
}

function inputs(body) {
  if (!object(body)) throw new Error('请求体必须是 JSON 对象');
  const result={};
  const aliases={prompt:['prompt'],seconds:['seconds','duration','duration_seconds'],mode:['mode'],resolution:['resolution'],aspect_ratio:['aspect_ratio','size'],generate_audio:['generate_audio'],watermark:['watermark'],seed:['seed'],output_format:['output_format'],start_image_url:['start_image_url','input_reference'],end_image_url:['end_image_url','last_frame'],images:['images','reference_image_urls'],videos:['videos','reference_video_urls'],audios:['audios','reference_audio_urls']};
  for (const [field,names] of Object.entries(aliases)) for (const name of names) {
    if (!own(body,name)) continue;
    let value=body[name];
    if (field==='seconds') {
      if (typeof value==='string' && /^\d+$/.test(value)) value=Number(value);
      if (!Number.isSafeInteger(value) || value<1 || value>3600) throw new Error('seconds 必须为 1 至 3600 之间的整数');
    } else if (field==='seed') {
      if (!Number.isSafeInteger(value) || value < -1) throw new Error('seed 必须为 -1 或非负安全整数');
    } else if (field==='generate_audio' || field==='watermark') {
      if (typeof value!=='boolean') throw new Error(name+' 必须为布尔值');
    } else if (['images','videos','audios'].includes(field)) {
      if (!Array.isArray(value) || value.some(item=>!httpsURL(item))) throw new Error(name+' 必须为 HTTPS URL 数组');
    } else if (['start_image_url','end_image_url'].includes(field)) {
      if (!httpsURL(value)) throw new Error(name+' 必须为 HTTPS URL');
    } else if (typeof value!=='string') throw new Error(name+' 必须为字符串');
    if (own(result,field) && JSON.stringify(result[field])!==JSON.stringify(value)) throw new Error(field+' 的别名值冲突');
    result[field]=value;
  }
  return result;
}

function normalized(ctx) {
  const request=ctx.requestBody || {};
  if (request.protocolTemplate!==interfaceID || request.operation!=='video_generate') throw new Error('请先确认风浪云视频接口参数配置');
  if (request.uploads?.length || ctx.files?.length) throw new Error('风浪云仅支持公网 HTTPS 素材 URL');
  const input=inputs(request.input);
  const model=ctx.upstreamModel || ctx.model;
  if (typeof model!=='string' || !model.trim() || typeof input.prompt!=='string' || !input.prompt.trim()) throw new Error('model 和 prompt 必填且不能为空');
  const references=['images','videos','audios'].some(field=>input[field]?.length);
  const frames=!!(input.start_image_url || input.end_image_url);
  if (references && frames) throw new Error('首尾帧不能与多模态参考混用');
  if (input.end_image_url && !input.start_image_url) throw new Error('尾帧需要同时提供首帧');
  const mode=input.mode ?? (references?'reference':input.end_image_url?'firstlast':input.start_image_url?'i2v':'t2v');
  if (!['t2v','i2v','firstlast','reference'].includes(mode)) throw new Error('mode 无效');
  if ((mode==='t2v' && (frames || references)) || (mode==='i2v' && (!input.start_image_url || input.end_image_url || references)) || (mode==='firstlast' && (!input.start_image_url || !input.end_image_url || references)) || (mode==='reference' && (!references || frames))) throw new Error('mode 与参考素材不匹配');
  const rule=meta.parameterInterfaces[interfaceID].modelRules[model];
  const unrestricted=new Set(request.unrestrictedValueFields || []);
  if (rule) {
    const parameters=rule.parameters;
    if (input.seconds!==undefined && !unrestricted.has('seconds') && (input.seconds<parameters.seconds.minimum || input.seconds>parameters.seconds.maximum)) throw new Error('seconds 超出该模型的文档时长范围');
    if (input.resolution!==undefined && !unrestricted.has('resolution') && !parameters.resolution.enum.includes(input.resolution)) throw new Error('resolution 不在该模型文档范围内');
    for (const field of ['images','videos','audios']) if (input[field]?.length>parameters[field].definition.maxItems) throw new Error(field+' 超过该模型参考素材数量限制');
    for (const field of rule.unsupportedFields || []) if (input[field]!==undefined) throw new Error(field+' 未被该模型支持，请在渠道配置中关闭');
  }
  if (input.output_format!==undefined && !['mp4','mov'].includes(input.output_format)) throw new Error('output_format 必须为 mp4 或 mov');
  // Unknown model capabilities and media durations require supplier validation.
  // URL strings cannot establish individual/aggregate reference clip durations.
  return {input,model,mode};
}

function apiRequest(ctx,path) {
  const base=String(ctx.baseUrl || meta.baseUrl).replace(/\/+$/,'');
  if (!/^https:\/\/[^\s/@?#\\]+(?:\/[^\s?#\\]*)?$/.test(base)) throw new Error('渠道地址必须为不含凭据的 HTTPS URL');
  const authorization=ctx.authHeader || (ctx.apiKey?'Bearer '+ctx.apiKey:'');
  if (!authorization || /[\r\n]/.test(authorization)) throw new Error('渠道 API 密钥未配置');
  return {url:base+path,method:'GET',headers:{Authorization:authorization,Accept:'application/json'}};
}

export function buildSubmitRequest(ctx) {
  const {input,model,mode}=normalized(ctx);
  const body={model,prompt:input.prompt,mode};
  const mapping={seconds:'seconds',resolution:'resolution',aspect_ratio:'aspect_ratio',generate_audio:'generate_audio',watermark:'watermark',seed:'seed',output_format:'output_format',start_image_url:'input_reference',end_image_url:'last_frame',images:'reference_image_urls',videos:'reference_video_urls',audios:'reference_audio_urls'};
  for (const [field,vendor] of Object.entries(mapping)) if (own(input,field)) body[vendor]=input[field];
  const request=apiRequest(ctx,'/videos');
  request.method='POST';request.headers['Content-Type']='application/json';request.body=body;
  return request;
}

function failureReason(body) {
  const error=body?.task?.error ?? body?.message;
  const value=object(error)?error.message:error;
  return typeof value==='string' && value.trim() ? value.replace(/https?:\/\/\S+/gi,'[URL]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]+/g,'[redacted]').slice(0,2048) : '上游视频任务失败';
}

function resultURL(data) {
  return object(data?.task) && httpsURL(data.task.videoUrl)?data.task.videoUrl:'';
}

function taskID(id) {
  if (Number.isSafeInteger(id) && id>0) id=String(id);
  if (typeof id!=='string' || !id.trim() || id.length>512 || /[\s\x00-\x1f\x7f]/.test(id)) throw new Error('响应缺少有效 task.id，请核对任务记录，勿重复创建');
  return id;
}

export function parseTaskResult(ctx,body) {
  if (!object(body)) return {status:'UNKNOWN',reason:'任务响应不是 JSON 对象'};
  if (body.success===false) return {status:'FAILURE',progress:'100%',reason:failureReason(body)};
  const task=body.task;
  if (body.success!==true || !object(task) || typeof task.done!=='boolean') return {status:'UNKNOWN',reason:'任务响应缺少明确的 success、task 或 done'};
  if (!task.done) return {status:task.status==='queued'?'QUEUED':'IN_PROGRESS',progress:'0%'};
  if (task.status==='failed') return {status:'FAILURE',progress:'100%',reason:failureReason(body)};
  if (task.status!=='completed') return {status:'UNKNOWN',reason:'未识别上游终态'};
  const url=resultURL(body);
  // The documented authenticated download endpoint also serves archived videos.
  return {status:'SUCCESS',progress:'100%',...(url?{url}:{})};
}

export function parseSubmitResponse(ctx,response) {
  const body=response.body;
  if (!object(body)) throw new Error('创建响应不是 JSON 对象，请核对任务记录，勿重复创建');
  const result=parseTaskResult(ctx,body);
  if (result.status==='FAILURE') return {taskId:body.task?.id?taskID(body.task.id):ctx.publicTaskId || utils.uuid(),taskData:body,immediate:result};
  if (body.success!==true) throw new Error('创建响应缺少明确成功标记，请核对任务记录，勿重复创建');
  const parsed={taskId:taskID(body.task?.id),taskData:body,state:{protocolTemplate:interfaceID}};
  if (result.status==='SUCCESS') parsed.immediate=result;
  return parsed;
}

export function buildQueryRequest(ctx) {
  return apiRequest(ctx,'/tasks/'+encodeURIComponent(taskID(ctx.taskId)));
}

export function extractUsage(ctx) {
  const {input}=normalized(ctx);
  if (ctx.usagePurpose==='billing_ratios') throw new Error('请先配置该模型的插件计费表达式');
  // Current documented models charge by requested second. No undocumented
  // vendor default is safe for reservation. Require an explicit effective value.
  if (input.seconds===undefined) throw new Error('按秒预扣需要显式 seconds 或已保存的渠道时长默认值');
  // A requested resolution selects a pricing tier; it is not a numeric ratio.
  // Preserve omission instead of inventing a supplier default or a free tier.
  // Unknown account models retain their existing seconds-only usage contract
  // for unreviewed labels; do not invent a tier or reject a seconds-only price.
  const resolution=meta.usageSchema.resolution.enum.includes(input.resolution)?input.resolution:undefined;
  return {request_count:1,seconds:input.seconds,...(resolution===undefined?{}:{resolution})};
}

export function extractUsageOnComplete() {
  // No documented actual-duration usage. Keep the reserved requested seconds;
  // refunded is supplier metadata, not an instruction to credit the local wallet.
  return {};
}

export function listArtifacts(task) {
  return task.status==='SUCCESS'?[{key:'video',type:'video'}]:[];
}

export function buildContentRequest(ctx) {
  if (ctx.artifactKey!=='video' || ctx.status!=='SUCCESS') throw new Error('视频结果不可用');
  const method=ctx.clientRequest?.method==='HEAD'?'HEAD':'GET';
  const url=resultURL(ctx.data);
  if (url) return {url,method,credentialless:true};
  // Never attach the supplier key to a response-controlled URL. The known
  // canonical download route uses only the host-pinned upstream task ID.
  const request=apiRequest(ctx,'/tasks/'+encodeURIComponent(taskID(ctx.upstreamTaskId))+'/download');
  request.method=method;
  delete request.headers.Accept;
  // The host forwards Range/If-Range and strips credentials on cross-origin
  // redirects while checking each redirect destination for SSRF.
  return request;
}

export const protocols={openai_video:{
  decodeRequest(ctx) {
    if (ctx.body?.kind!=='json' || !object(ctx.body.value)) throw new Error('仅支持 JSON 和公网 HTTPS 素材 URL');
    // Unsupported malformed optional fields must reach host filtering first.
    const input=JSON.parse(JSON.stringify(ctx.body.value));
    // In this API input_reference means a first frame, not reference images.
    // Canonicalize its role before the host classifies capability switches;
    // leave conflicting aliases for the host's effective-parameter checks.
    if (own(input,'input_reference') && !own(input,'start_image_url')) {
      input.start_image_url=input.input_reference;
      delete input.input_reference;
    }
    return {kind:'submit',model:ctx.model,action:'video_generate',requestBody:{operation:'video_generate',input,uploads:[]}};
  },
  render(ctx,task) {
    if (task.status==='FAILURE') return {error:{code:'video_generation_failed',message:failureReason(task.data)}};
    if (task.status!=='SUCCESS') return {};
    return {url:resultURL(task.data) || '/v1/videos/'+encodeURIComponent(task.task_id)+'/content'};
  },
}};
