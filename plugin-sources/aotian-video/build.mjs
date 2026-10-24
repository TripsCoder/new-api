import fs from 'node:fs';
import crypto from 'node:crypto';

const root = new URL('./', import.meta.url);
const read = name => fs.readFileSync(new URL(name, root));
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const check = process.argv.includes('--check');
const sources = [
  {file:'evidence/docs.html', url:'https://aotianzz.xyz/docs#endpoints'},
  {file:'evidence/Aotian-SKILL.md', url:'https://video.aotianzz.xyz/Aotian-SKILL.md'},
].map(item => ({...item, sha256:digest(read(item.file)), readAt:'2026-10-24'}));
const doc = read(sources[0].file).toString();
for (const field of ['model','prompt','seconds','duration','size','resolution','images','reference_image_urls','reference_videos','reference_audios','metadata']) {
  if (!doc.includes(field)) throw new Error('Reviewed source no longer contains '+field);
}
const source = {...sources[0], status:'public-documentation'};
const parameter = (type, vendorFields, capabilities, description, extra = {}) => ({
  type, required:false, description, source,
  definition:{type, description, 'x-channel-parameter':{vendorFields, capabilities, requiredIn:[], status:'documented'}, ...extra},
});
const parameters = {
  model:{...parameter('string',['model'],['base'],'当前令牌可用的视频模型'), required:true},
  prompt:{...parameter('string',['prompt'],['base'],'非空视频提示词',{minLength:1}), required:true},
  seconds:{...parameter('integer',['seconds','duration'],['base'],'视频时长，发送为 seconds 字符串',{minimum:1,maximum:3600}),minimum:1,maximum:3600},
  aspect_ratio:parameter('string',['size'],['base'],'画面比例，直接发送 size，不换算像素',{enum:['16:9','9:16','1:1','4:3','3:4','21:9']}),
  resolution:parameter('string',['resolution'],['base'],'独立清晰度，具体支持档位待逐型号确认',{examples:['480p','720p','1080p']}),
  images:parameter('array',['images','reference_image_urls','image','input_reference'],['image_video','mixed_ref'],'参考图片 HTTPS URL 数组',{items:{type:'string',format:'uri'}}),
  videos:parameter('array',['reference_videos'],['video_ref','mixed_ref'],'参考视频 HTTPS URL 数组',{items:{type:'string',format:'uri'}}),
  audios:parameter('array',['reference_audios'],['audio_ref','mixed_ref'],'参考音频 HTTPS URL 数组',{items:{type:'string',format:'uri'}}),
};
const id = 'interface:'+digest('aotian_video:POST:/v1/videos').slice(0,16);
const contract = {
  id, title:'AoTian 创建视频任务',kind:'video',method:'POST',path:'/v1/videos',
  status:'documented-interface-not-account-verification',source,parameters,
  mapping:Object.fromEntries(Object.keys(parameters).map(key=>[key,key])),
  modes:Object.fromEntries(['text_video','image_video','video_ref','audio_ref','mixed_ref'].map(mode=>[mode,{required:[]}])) ,
  capabilities:{multipleReferences:true},
  pending:[
    'Account-visible model IDs, permissions, per-model duration and reference limits are unverified',
    'resolution values are examples, not an exhaustive enum',
    'metadata and input_video/input_audio lack a complete request contract',
    'seed/fps/n/generate_audio/camera_movement lack model-specific definitions',
    'Provider documentation disagrees about rejecting versus ignoring unsupported fields',
    'Actual output duration and provider billing units are not generally documented',
  ],
};
const meta = {
  apiVersion:1,key:'aotian_video',name:'AoTian Video',version:'2.1.0',author:{name:'TripsCoder'},icon:'text:AT',
  description:{en:'Video generation through the AoTian video API',zh:'通过 AoTian 视频接口生成视频'},
  website:'https://aotianzz.xyz/docs#endpoints',baseUrl:'https://aotianzz.xyz',auth:'api_key',
  // API v1 requires a static model. This exact ID is explicitly named in the
  // supplemental provider document; it is NOT a fetched account model list.
  models:['sh-seedance-2.5-720p'],fetchMode:'per_task',protocols:['openai_video'],
  modelDiscovery:{path:'/v1/models',format:'openai',sourceUrl:sources[0].url,sourceSha256:sources[0].sha256},
  parameterInterfaces:{[id]:contract},
  // One completed video request is a known quantity. The provider has not
  // documented general actual-duration usage, so do not invent second billing.
  usageSchema:{request_count:{type:'number',unit:'count',description:{en:'Video generation unit price',zh:'视频生成单价'}}},
};
const runtime = read('plugin.js').toString();
const catalogFile = new URL('../../pkg/modelconfig/aotian_video.catalog.json',root);
// The configuration UI consumes both the execution interface and its source
// document list. Keep the document projection derived from the same contract.
const projection = {
  key:meta.key,name:meta.name,baseURL:meta.baseUrl,docsURL:meta.website,
  models:{},interfaces:meta.parameterInterfaces,
  documents:[{
    id:contract.id,title:contract.title,method:contract.method,path:contract.path,
    description:'Canonical channel parameters projected from the reviewed API document; the plugin driver owns upstream field encoding',
    source:contract.source,
    schema:{
      type:'object',
      properties:Object.fromEntries(Object.entries(contract.parameters).map(([name,rule])=>[name,rule.definition])),
      required:Object.entries(contract.parameters).filter(([,rule])=>rule.required).map(([name])=>name),
    },
  }],
  warnings:[...contract.pending],
};
if (process.argv.includes('--sync-catalog')) {
  fs.writeFileSync(catalogFile,JSON.stringify(projection,null,2)+'\n');
}
if (check && JSON.stringify(JSON.parse(fs.readFileSync(catalogFile,'utf8')))!==JSON.stringify(projection)) throw new Error('Stale AoTian documentation catalog projection');
const compiled = '// Generated by build.mjs from reviewed AoTian sources. Do not edit.\n'+
  'export const meta = '+JSON.stringify(meta,null,2)+';\n'+runtime;
const lock = {format:'aotian-video-sources/v1',policy:'../juhefuwu/docs/operations/upstream-channel-troubleshooting.md#imported-parameter-policy',sources,
  modelDeclarations:{status:'documentation-only-not-account-discovery',models:meta.models,source:sources[1]},
  conflicts:[{topic:'unsupported fields',primary:'HTTP 400',supplement:'ignored',decision:'Saved channel configuration filters fields before encoding'},
    {topic:'automatic creation retries',decision:'No automatic generation retries; use the host explicit channel single-attempt header'}]};
const manifest = {format:'aotian-video-build/v1',key:meta.key,version:meta.version,interface:id,
  inputs:Object.fromEntries(['build.mjs','plugin.js',...sources.map(s=>s.file)].map(name=>[name,digest(read(name))])),
  file:'aotian_video.plugin.js',sha256:digest(compiled),status:'account-models-and-pricing-not-configured'};
for (const [name,value] of [['sources.lock.json',JSON.stringify(lock,null,2)+'\n'],['dist/aotian_video.plugin.js',compiled],['dist/manifest.json',JSON.stringify(manifest,null,2)+'\n']]) {
  const file = new URL(name,root);
  if(check) { if(fs.readFileSync(file,'utf8')!==value) throw new Error('Stale artifact: '+name); }
  else fs.writeFileSync(file,value);
}
console.log(JSON.stringify(manifest));
