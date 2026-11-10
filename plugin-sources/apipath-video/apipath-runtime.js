// Keep canonical field validation, request encoding, usage extraction and
// credentialless artifact downloads in the existing shared interface runtime.
// APIPath requires a complete Bearer header. Vendor api_key contexts may carry
// a raw authHeader; normalize here without changing other providers' auth.
auth = function(ctx) {
  const header = typeof ctx.authHeader === 'string' ? ctx.authHeader : '';
  const credential = header.trim() ? header : (typeof ctx.apiKey === 'string' ? ctx.apiKey : '');
  // Validate before trimming so a trailing newline cannot hide header injection.
  if (/[\u0000-\u001f\u007f]/.test(header) || /[\u0000-\u001f\u007f]/.test(credential)) fail('channel API key is missing or invalid');
  const token = credential.trim().replace(/^Bearer(?: +|$)/i, '');
  if (!token || /\s/.test(token)) fail('channel API key is missing or invalid');
  return { Authorization: 'Bearer ' + token, Accept: 'application/json' };
};

const sharedDocumentNormalization = normalizeDocumentInterface;
normalizeDocumentInterface = function(ctx,p,body) {
  const input=copy(body.input);
  for(const [field,parameter]of Object.entries(p.parameterDefinitions)){
    const names=parameter.definition['x-channel-parameter'].vendorFields;
    for(const name of names){
      if(name===field||!own(input,name))continue;
      let value=input[name];
      if(['images','videos','audios'].includes(field)&&typeof value==='string')value=[value];
      if(own(input,field)&&JSON.stringify(input[field])!==JSON.stringify(value))fail('conflicting documented aliases: '+field);
      input[field]=value;delete input[name];
    }
  }
  const result=sharedDocumentNormalization(ctx,p,{...body,input});
  if(typeof result.input.prompt!=='string'||!result.input.prompt.trim())fail('prompt is required');
  // Count and duration remain bounded even for the administrator's explicit
  // unrestricted-value policy. They are billing multipliers, never arbitrary.
  if(result.seconds!==undefined)bounded(result.seconds,1,3600,'seconds');
  if(result.input.count!==undefined)bounded(integer(result.input.count,'count'),1,1,'count');
  for(const field of ['start_image_url','end_image_url'])if(result.input[field]!==undefined)media(result.input[field],'image',p);
  return result;
};

const sharedRequestedUsage=extractUsage;
extractUsage=function(ctx){
  const facts=sharedRequestedUsage(ctx);
  // An explicitly unrestricted request label is not a reviewed pricing label.
  // Count-based prices still work; a price needing an unknown label fails safely
  // rather than inventing a resolution category or a zero charge.
  if(facts.resolution!==undefined&&!meta.usageSchema.resolution.enum.includes(facts.resolution))delete facts.resolution;
  return facts;
};

// APIPath task responses put video results in output. Reuse this resolver for
// polling, artifact listing, content requests and public rendering.
const sharedVideoURL = videoURL;
videoURL = function(raw) {
  const body = unwrap(raw);
  const output = body.output;
  if (object(output)) {
    if (safeMediaURL(output.video_url)) return output.video_url;
    if (Array.isArray(output.videos)) {
      for (const video of output.videos) {
        if (object(video) && safeMediaURL(video.url)) return video.url;
      }
    }
  }
  return sharedVideoURL(body);
};

function apipathTask(body) {
  if(!object(body))throw new Error('upstream task response must be a JSON object');
  const data=unwrap(body);
  const id=data.task_no || data.task_id || data.id;
  if(id!==undefined)taskID(id);
  for(const field of ['task_no','task_id','id'])if(data[field]!==undefined&&data[field]!==id)throw new Error('conflicting upstream task identifiers');
  // Normalize the documented task_no into the shared task identity. Neither
  // response poll_url nor returned authorization fields are request targets.
  return {...data,...(id?{id}:{}),...(body.success===false?{success:false}:{}),...(body.error?{error:body.error}:{})};
}

const sharedSubmitResponse=parseSubmitResponse;
parseSubmitResponse=function(ctx,response){
  const data=apipathTask(response.body);
  const parsed=sharedSubmitResponse(ctx,{...response,body:data});
  if(parsed.immediate?.status==='FAILURE')parsed.immediate={...parsed.immediate,reason:failureReason(data)};
  return parsed;
};
const sharedTaskResult=parseTaskResult;
parseTaskResult=function(ctx,body){
  const data=apipathTask(body);
  if(data.success===false||data.error)return {status:'FAILURE',progress:'100%',reason:failureReason(data)};
  return sharedTaskResult(ctx,data);
};
const sharedFailureReason=failureReason;
failureReason=function(body){
  return sharedFailureReason(body).replace(/https?:\/\/\S+/gi,'[URL]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]+/g,'[redacted]').slice(0,2048);
};
protocols.openai_video={
  decodeRequest(ctx){
    if(ctx.body?.kind!=='json'||!object(ctx.body.value))fail('use JSON with publicly accessible reference URLs');
    // Host filtering/alias/policy normalization must run before value checks.
    const input=copy(ctx.body.value);
    for(const [alias,field]of [['first_frame_image','first_frame'],['last_frame_image','last_frame']]){
      if(!own(input,alias))continue;
      // Preserve a conflicting value as invalid input for post-policy type
      // validation; disabled frame capabilities still discard the whole field.
      input[field]=own(input,field)&&input[field]!==input[alias]?[input[field],input[alias]]:input[alias];
      delete input[alias];
    }
    return {kind:'submit',model:ctx.model,action:'video_generate',requestBody:{operation:'video_generate',input,uploads:[]}};
  },
  render(ctx,task){
    if(task.status==='FAILURE')return {error:{code:'video_generation_failed',message:failureReason(task.data)}};
    const url=videoURL(task.data);
    return url?{url}:{};
  },
};
