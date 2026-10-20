// YuxiBox's documented cross-field and multipart alternatives. No model-name
// guessing, remote probing, price changes or implicit business defaults.
function yuxiboxReference(value,type,p) {
  const group=p.yuxibox.group;
  return media(value,type,{...p,httpsOnly:['yx','minimax'].includes(group),dataImages:['yx','wan'].includes(group),dataVideos:group==='yx',dataAudios:group==='yx'});
}
function yuxiboxUpload(file, ctx, p) {
  const definition=p.yuxibox.uploads[file.field];
  if(!definition)fail('upload field is absent from YuxiBox documentation: '+file.field);
  const actual=(ctx.files || []).find(entry=>entry.ref===file.ref);
  if(!actual || actual.field!==file.field)fail('unrecognized upload reference');
  const type=text(actual.mimeType).split('/')[0];
  if(type!==definition.kind)fail('upload MIME type does not match documented field: '+file.field);
  const wan=p.yuxibox.group==='wan';
  const limit=wan ? {image:20*1024*1024,video:100*1024*1024,audio:15*1024*1024}[type] : 20*1024*1024;
  bounded(integer(actual.size,'upload size'),1,limit,'upload size');
  const formats=type==='image' ? ['image/png','image/jpeg','image/webp',...(wan?['image/bmp']:[])] : type==='video' ? ['video/mp4','video/quicktime'] : ['audio/mpeg','audio/mp3','audio/wav','audio/x-wav'];
  if(!formats.includes(text(actual.mimeType).toLowerCase()))fail('unsupported documented upload MIME type');
  return {type,file:actual};
}
function prepareYuxiboxDocument(ctx,p,body) {
  const input=copy(body.input), uploads=body.uploads || [], counts={images:0,videos:0,audios:0};
  for(const [vendor,rule] of Object.entries(p.wire)){
    if(vendor===rule.field || input[vendor]===undefined)continue;
    let value=input[vendor];if(['images','videos','audios'].includes(rule.field))value=array(value,vendor);
    if(input[rule.field]!==undefined && JSON.stringify(value)!==JSON.stringify(input[rule.field]))fail('conflicting documented aliases: '+rule.field);
    input[rule.field]=value;delete input[vendor];
  }
  if(input.input_reference!==undefined){
    if(!p.yuxibox.uploads.input_reference)fail('input_reference is absent from the selected document interface');
    if(input.images!==undefined)fail('conflicting documented image aliases');
    input.images=array(input.input_reference,'input_reference');delete input.input_reference;
  }
  for(const [alias,field]of [['start_image_url','first_frame'],['end_image_url','last_frame']]){
    if(input[alias]===undefined)continue;
    if(!p.wire[field])fail('frame field is absent from the selected document interface');
    if(input[field]!==undefined && input[field]!==input[alias])fail('conflicting documented frame aliases');
    input[field]=input[alias];delete input[alias];
  }
  for(const field of Object.keys(counts))counts[field]=array(input[field],field).length;
  let first=input.first_frame?1:0,last=input.last_frame?1:0;
  for(const item of array(input.media,'media')){
    if(item.type==='first_frame')first++;
    else if(item.type==='last_frame')last++;
    else if(item.type==='reference_image')counts.images++;
    else if(item.type==='reference_video')counts.videos++;
    else if(item.type==='reference_audio')counts.audios++;
  }
  for(const file of uploads){const entry=yuxiboxUpload(file,ctx,p);counts[entry.type==='image'?'images':entry.type==='video'?'videos':'audios']++;}
  for(const [field,count]of Object.entries(counts)){
    const ceiling=p.parameterDefinitions[field]?.definition?.maxItems;
    if(ceiling!==undefined && count>ceiling)fail(field+' exceeds combined documented reference limit');
  }
  if(counts.images<p.yuxibox.minimumImages)fail('at least one image is required through reference_images or input_reference upload');
  if(p.yuxibox.group==='wan'){
    if(first>1 || last>1)fail('only one first and one last frame are documented');
    if(last && !first)fail('last_frame requires first_frame');
    if((first || last) && Object.values(counts).some(Boolean))fail('frames are mutually exclusive with reference images, videos and audios');
  }
  const ratio=input.aspect_ratio ?? input.ratio;
  if(input.seconds!==undefined && !(body.unrestrictedValueFields || []).includes('seconds')){
    const seconds=integer(input.seconds,'seconds'), rule=p.parameterDefinitions.seconds;
    if(rule.minimum!==undefined && seconds<rule.minimum || rule.maximum!==undefined && seconds>rule.maximum)fail('seconds is outside the documented range');
  }
  if(p.yuxibox.group==='yx' && ratio!==undefined && input.size!==undefined)fail('omit size when ratio is supplied');
  if(p.yuxibox.group==='official' && ratio!==undefined && input.size!==undefined && ({'16:9':'1280x720','9:16':'720x1280'}[ratio]!==input.size))fail('size must match ratio');
  return {...body,input};
}
