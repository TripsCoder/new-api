// Skip only saved value choices/bounds; retain wire shape and material rules.
function documentValueSchema(schema, unrestricted) {
  if (!unrestricted) return schema;
  const result = {...schema};
  for (const key of ['enum','const','minimum','maximum','exclusiveMinimum','exclusiveMaximum']) delete result[key];
  for (const key of ['anyOf','oneOf','allOf']) if (Array.isArray(result[key])) result[key]=result[key].map(rule=>documentValueSchema(rule,true));
  return result;
}
// Included in the same immutable plugin as its documentation contract. This
// codec consumes canonical plugin inputs and emits only documented wire fields.
function normalizeDocumentInterface(ctx, p, body) {
  if (p.yuxibox) body = prepareYuxiboxDocument(ctx, p, body);
  const input = copy(body.input), operation = body.operation;
  if (p.kind === 'video' ? operation !== 'video_generate' : !['image_generate', 'image_edit'].includes(operation)) fail('interface and operation do not match');
  if(p.submit.endsWith('/edits') && operation!=='image_edit')fail('the documented edit interface requires the edit operation');
  if(operation==='image_edit' && !array(input.images,'images').length && !(body.uploads || []).length)fail('image editing requires reference images');
  const unrestricted = new Set(body.unrestrictedValueFields || []);
  const known = new Set(Object.values(p.wire).map(rule => rule.field));
  const aliases = {duration:'seconds',duration_seconds:'seconds',ratio:'aspect_ratio',aspectRatio:'aspect_ratio',imageSize:'image_size'};
  for (const [alias, field] of Object.entries(aliases)) {
    if (own(input,alias)) {
      if (!known.has(field)) { delete input[alias]; continue; }
      if (own(input,field) && String(input[alias]) !== String(input[field])) fail('conflicting '+field+' aliases');
      input[field]=input[alias]; delete input[alias];
    }
  }
  // Unified callers may send another model's optional fields. Keep only this
  // interface's mapped fields before value validation and usage extraction.
  for (const field of Object.keys(input)) if (!known.has(field)) delete input[field];
  for(const [field,parameter]of Object.entries(p.parameterDefinitions || {})){
    if(input[field]!==undefined)validateDocumentValue(input[field],documentValueSchema({...parameter.definition,...(parameter.enum?{enum:parameter.enum}:{}),...(parameter.minimum!==undefined?{minimum:parameter.minimum}:{}),...(parameter.maximum!==undefined?{maximum:parameter.maximum}:{})},unrestricted.has(field)&&!parameter.required),field);
  }
  if ((body.uploads || []).some(file => !(p.uploadFields || []).includes(file.field))) fail('uploaded field is absent from the selected documented interface');
  const model = ctx.upstreamModel || ctx.model;
  let resolution=typeof input.resolution==='string'?input.resolution.toLowerCase():undefined;
  // Some video interfaces express the same output tier as explicit pixel dimensions.
  // Read the supplied size only; never infer a default from the model name.
  if(p.kind==='video' && resolution===undefined && typeof input.size==='string'){
    const dimensions=/^(\d{1,5})x(\d{1,5})$/i.exec(input.size);
    if(dimensions){const height=Math.min(Number(dimensions[1]),Number(dimensions[2]));if([480,720,1080].includes(height))resolution=String(height)+'p';}
  }
  return {p, input, operation, model, uploads:body.uploads || [], prompt:input.prompt, resolution, seconds:input.seconds === undefined ? undefined : integer(input.seconds,'duration'), n:input.n === undefined ? 1 : integer(input.n,'n')};
}
function validateDocumentValue(value, schema, field) {
  if (schema.enum && !schema.enum.some(candidate => JSON.stringify(candidate)===JSON.stringify(value))) fail(field+' is outside documented candidate values');
  if (schema.type==='integer' && !Number.isInteger(value)) fail(field+' must be an integer');
  if (schema.type==='number' && (typeof value!=='number' || !Number.isFinite(value))) fail(field+' must be a number');
  if (schema.type==='string' && typeof value!=='string') fail(field+' must be a string');
  if (schema.type==='boolean' && typeof value!=='boolean') fail(field+' must be a boolean');
  if (schema.type==='object') {
    if(!object(value))fail(field+' must be an object');
    for(const key of schema.required || [])if(value[key]===undefined)fail(field+'.'+key+' is required');
    for(const [key,rule]of Object.entries(schema.properties||{}))if(value[key]!==undefined)validateDocumentValue(value[key],rule,field+'.'+key);
  }
  if(schema.anyOf || schema.oneOf){
    let valid=false;for(const rule of schema.anyOf || schema.oneOf){try{validateDocumentValue(value,rule,field);valid=true;break}catch(_){}}
    if(!valid)fail(field+' does not match a documented input shape');
  }
  if (typeof value==='number' && (schema.minimum!==undefined && value<schema.minimum || schema.maximum!==undefined && value>schema.maximum)) fail(field+' is outside the documented range');
  if (typeof value==='string' && (schema.minLength!==undefined && value.length<schema.minLength || schema.maxLength!==undefined && value.length>schema.maxLength)) fail(field+' violates documented length');
  if (schema.type==='array') {
    if (!Array.isArray(value)) fail(field+' must be an array');
    if (schema.maxItems!==undefined && value.length>schema.maxItems) fail(field+' exceeds documented reference limit');
    if (schema.items) for (const item of value) validateDocumentValue(item,schema.items,field+'[]');
  }
  if(typeof value==='number' && schema.exclusiveMinimum!==undefined && value<=schema.exclusiveMinimum)fail(field+' must exceed the documented minimum');
}
function documentInterfaceRequest(ctx, r) {
  const p=r.p, output={}, emitted=new Set();
  for (const [vendor,rule] of Object.entries(p.wire)) {
    const field=rule.field;
    let value=field==='model' ? r.model : field==='client_request_id' ? ctx.publicTaskId : r.input[field];
    if (field==='seconds' && value!==undefined) value=rule.schema.type==='string' ? String(integer(value,field)) : integer(value,field);
    if (value===undefined || value===null) { if(rule.required) fail('required documented field is missing: '+vendor); continue; }
    if (emitted.has(field)) continue; // documented aliases use one spelling
    if (field==='images' || field==='videos' || field==='audios') {
      value=array(value,field).map(item=>p.yuxibox ? yuxiboxReference(item,field.slice(0,-1),p) : media(item,field.slice(0,-1),{...p,httpsOnly:PROVIDER.key==='paisio_media' || PROVIDER.key==='xcmapi_media',dataImages:['zhangyuge_media','lxmone_media','yuxibox_media','paisio_media'].includes(PROVIDER.key)}));
      if (!value.length) continue;
      if (p.mainImage && field==='images') {
        output.image_url=value[0];
        if(value.length>1) {const extra=p.wire.extra_images;if(!extra)fail('extra images are absent from documentation');validateDocumentValue(value.slice(1),extra.schema,'extra_images');output.extra_images=value.slice(1);}
        emitted.add(field); continue;
      }
      if (rule.schema.type==='string') {if(value.length!==1)fail(vendor+' only accepts one reference');value=value[0];}
      if(rule.schema.items?.type==='object' && Array.isArray(value))value=value.map(item=>typeof item==='string'?{url:item}:item);
    }
    validateDocumentValue(value,documentValueSchema(rule.schema,(ctx.requestBody.unrestrictedValueFields || []).includes(field)&&!p.parameterDefinitions?.[field]?.required),vendor);
    output[vendor]=value; emitted.add(field);
  }
  if (p.gemini) {
    const parts=[];
    if(r.input.prompt!==undefined)parts.push({text:r.input.prompt});
    for(const reference of array(r.input.images,'images')) {
      const match=/^data:(image\/[^;,]+);base64,(.+)$/.exec(reference);
      if(!match)fail('Gemini inline references require a documented data URI');
      parts.push({inlineData:{mimeType:match[1],data:match[2]}});
    }
    const imageConfig={};if(r.input.image_size!==undefined)imageConfig.imageSize=r.input.image_size;if(r.input.aspect_ratio!==undefined)imageConfig.aspectRatio=r.input.aspect_ratio;
    return request(ctx,p.submit.replace('{model}',encodeURIComponent(r.model)),{contents:[{role:'user',parts}],generationConfig:{responseModalities:['TEXT','IMAGE'],imageConfig}});
  }
  if (p.assets) {
    output.assets=[];
    for(const [key,type] of [['reference_images','image'],['reference_audios','audio']]){
      for(const value of output[key] || [])output.assets.push({category:type,url:value});
      delete output[key];
    }
  }
  if(p.referenceRole && output.reference_images)output.reference_images=output.reference_images.map(value=>({url:typeof value==='string'?value:value.url,role:p.referenceRole}));
  if(p.nestedWan){
    const media=[];for(const [key,type]of [['reference_images','image'],['reference_videos','video'],['reference_audios','audio']]){for(const url of output[key]||[])media.push({type,url});delete output[key];}
    output.input={prompt:output.prompt,...(media.length?{media}:{})};output.parameters={};
    if(output.duration!==undefined)output.parameters.duration=output.duration;
    if(output.resolution!==undefined)output.parameters.resolution=output.resolution.toUpperCase();
    if(output.aspect_ratio!==undefined)output.parameters.ratio=output.aspect_ratio;
    delete output.prompt;delete output.duration;delete output.resolution;delete output.aspect_ratio;
  }
  if(p.camelReferences){for(const [alias,native]of [['reference_images','referenceImages'],['reference_videos','referenceVideos'],['reference_audios','referenceAudios'],['aspect_ratio','ratio']]){if(output[alias]!==undefined)output[native]=output[alias];delete output[alias];}}
  const path=r.operation==='image_edit' ? p.edit || p.submit : p.submit;
  const descriptor=request(ctx,path.replace('{model}',encodeURIComponent(r.model)),output);
  if(r.uploads.length){
    delete descriptor.body;delete descriptor.headers['Content-Type'];descriptor.bodyType='multipart';
    descriptor.parts=Object.entries(output).map(([name,value])=>({name,value:typeof value==='object'?JSON.stringify(value):String(value)}));
    for(const file of r.uploads){const entry=p.yuxibox ? yuxiboxUpload(file,ctx,p) : uploadedMedia(file,ctx,p);descriptor.parts.push({name:p.yuxibox ? file.field : (p.uploadFields || [])[0],fileRef:entry.file.ref,filename:entry.file.filename});}
  }
  return descriptor;
}
