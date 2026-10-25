import fs from 'node:fs';
import crypto from 'node:crypto';

const root=new URL('./',import.meta.url);
const read=name=>fs.readFileSync(new URL(name,root));
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
const check=process.argv.includes('--check');
const sources=['openapi','models'].map(name=>({file:'evidence/'+name+'.js.txt',url:'https://fenglang.cloud/js/'+name+'.js',sha256:digest(read('evidence/'+name+'.js.txt')),readAt:'2026-10-24',status:'public-documentation'}));
const source=sources[0];
const parameter=(type,vendorFields,capabilities,description,extra={})=>({type,required:false,description,source,definition:{type,description,'x-channel-parameter':{vendorFields,capabilities,requiredIn:[],status:'documented'},...extra}});
const refs=(field,capabilities)=>parameter('array',[field],capabilities,'公网 HTTPS 素材 URL 数组',{items:{type:'string',format:'uri'}});
const parameters={
  model:{...parameter('string',['model'],['base'],'账号实际可用模型'),required:true},
  prompt:{...parameter('string',['prompt'],['base'],'视频提示词',{minLength:1}),required:true},
  mode:parameter('string',['mode'],['base'],'上游生成模式',{enum:['t2v','i2v','firstlast','reference']}),
  seconds:{...parameter('integer',['seconds','duration'],['base'],'视频时长',{minimum:1,maximum:3600}),minimum:1,maximum:3600},
  resolution:parameter('string',['resolution'],['base'],'分辨率，按模型文档确认'),
  aspect_ratio:parameter('string',['aspect_ratio'],['base'],'画面比例'),
  generate_audio:parameter('boolean',['generate_audio'],['base'],'生成音频'),
  watermark:parameter('boolean',['watermark'],['base'],'添加水印'),
  seed:parameter('integer',['seed'],['base'],'随机种子',{minimum:-1,maximum:Number.MAX_SAFE_INTEGER}),
  output_format:parameter('string',['output_format'],['base'],'输出格式',{enum:['mp4','mov']}),
  start_image_url:parameter('string',['input_reference'],['image_video','frames'],'首帧 HTTPS URL',{format:'uri'}),
  end_image_url:parameter('string',['last_frame'],['frames'],'尾帧 HTTPS URL',{format:'uri'}),
  images:refs('reference_image_urls',['image_video','mixed_ref','video_ref','audio_ref']),
  videos:refs('reference_video_urls',['video_ref','mixed_ref']),
  audios:refs('reference_audio_urls',['audio_ref','mixed_ref']),
};
// Exact IDs below are present in the live public UI source, not inferred from
// display names and not claimed as authenticated /pricing discovery.
const documented=[
  ['seedance-2.5',4,30,['480p','720p','1080p'],[30,10,10]],
  ['seedance-2.0',4,15,['480p','720p','1080p'],[9,3,3]],
  ['seedance-2.0-fast',4,15,['480p','720p'],[9,3,3]],
  ['seedance-2.0-mini',4,15,['480p','720p'],[9,3,3]],
  ['minimax-video-h3',5,15,['768p','2k'],[9,0,0]],
];
const modelRules={};
for (const [model,min,max,resolutions,counts] of documented) {
  if (!read('evidence/models.js.txt').toString().includes("['"+model+"',")) throw new Error('Missing reviewed exact ID '+model);
  const values=structuredClone(parameters);
  values.seconds.minimum=min;values.seconds.maximum=max;
  Object.assign(values.seconds.definition,{minimum:min,maximum:max});
  values.resolution.enum=resolutions;values.resolution.definition.enum=resolutions;
  for (const [index,key] of ['images','videos','audios'].entries()) values[key].definition.maxItems=counts[index];
  const unsupportedFields=model==='minimax-video-h3'?['generate_audio','watermark','seed','output_format']:[];
  // Keep excluded request members visible in the documented rule for driver
  // rejection, but do not offer unsupported controls in the UI projection.
  for (const field of unsupportedFields) delete values[field];
  modelRules[model]={parameters:values,unsupportedFields,source:sources[1]};
}
const id='interface:'+digest('fenglang_video:POST:/open/v1/videos').slice(0,16);
const contract={id,title:'风浪云创建视频任务',kind:'video',method:'POST',path:'/open/v1/videos',status:'documented-interface-not-account-verification',source,parameters,modelRules,
  mapping:Object.fromEntries(Object.keys(parameters).map(field=>[field,field])),
  modes:Object.fromEntries(['text_video','image_video','frames','video_ref','audio_ref','mixed_ref'].map(mode=>[mode,{required:[]}])),
  capabilities:{multipleReferences:true},
  pending:[
    'Authenticated /pricing response shape and account-visible model IDs remain unverified; discovery fails closed on other shapes',
    'Seedance 2.0 documentation says fixed 15 seconds while current public catalog and user specification say 4-15; no paid request verified',
    'Reference clip minimum 2 seconds and per-media-class aggregate 30 seconds require supplier media inspection; URL/count checks are local',
    'Aspect ratios, output formats and optional controls require actual model confirmation',
    'Per-second reservation requires explicit seconds or an administrator-saved duration default; no provider default is fabricated',
    'No actual output-duration usage is documented; completion retains reserved requested seconds',
  ]};
// The host validates exact-model documents independently of the common table.
// Each rule therefore carries the complete supported modes and field mapping.
for (const [model,rule] of Object.entries(modelRules)) {
  Object.assign(rule,{id,title:contract.title,kind:contract.kind,path:contract.path,method:contract.method,status:contract.status,
    mapping:Object.fromEntries(Object.keys(rule.parameters).map(field=>[field,field])),
    modes:Object.fromEntries(Object.entries(contract.modes).filter(([mode])=>model!=='minimax-video-h3' || !['video_ref','audio_ref','mixed_ref'].includes(mode))),
    capabilities:contract.capabilities});
}
// Usage labels describe pricing dimensions, not per-model request candidates.
// Each request still passes the exact modelRules above before usage extraction.
const usageSchema={request_count:{type:'number',unit:'count',description:{en:'Video generation unit price',zh:'视频生成单价'}},seconds:{type:'number',unit:'second',description:{en:'Video generation unit price',zh:'视频生成单价'}},resolution:{enum:[...new Set(documented.flatMap(([, , , values])=>values))],description:{en:'Requested video resolution',zh:'请求视频分辨率'}}};
const meta={apiVersion:1,key:'fenglang_video',name:'风浪云视频',version:'2.1.1',author:{name:'TripsCoder'},icon:'text:FL',description:{en:'Video generation through the Fenglang Cloud API',zh:'通过风浪云接口生成视频'},website:'https://fenglang.cloud/',baseUrl:'https://fenglang.cloud/open/v1',auth:'api_key',models:['seedance-2.5'],fetchMode:'per_task',protocols:['openai_video'],modelDiscovery:{path:'/pricing',format:'fenglang_pricing',sourceUrl:source.url,sourceSha256:source.sha256},parameterInterfaces:{[id]:contract},usageSchema,
};
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
const catalogFile=new URL('../../pkg/modelconfig/fenglang_video.catalog.json',root);
if (process.argv.includes('--sync-catalog')) fs.writeFileSync(catalogFile,JSON.stringify(projection,null,2)+'\n');
if (check && JSON.stringify(JSON.parse(fs.readFileSync(catalogFile,'utf8')))!==JSON.stringify(projection)) throw new Error('Stale Fenglang catalog');
const compiled='// Generated by build.mjs from reviewed Fenglang public documentation. Do not edit.\nexport const meta = '+JSON.stringify(meta,null,2)+';\n'+read('plugin.js').toString();
const lock={format:'fenglang-video-sources/v1',policy:'../juhefuwu/docs/operations/upstream-channel-troubleshooting.md#imported-parameter-policy',sources,readOnlyProbes:{ping:200,pricing:401,apiKeyUsed:false},modelDeclarations:{status:'documentation-only-not-account-discovery',static:meta.models,exactPublicIDs:documented.map(row=>row[0])},pending:contract.pending,securityReferences:['https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html','https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html'],securityControls:['TLS API credentials only on configured origin','Untrusted result URLs credentialless','Canonical authenticated fallback from host-pinned task ID','Host SSRF and cross-origin redirect stripping','No credentials in rendered response or failure text'],accountPricesImported:false,paidCalls:0};
const manifest={format:'fenglang-video-build/v1',key:meta.key,version:meta.version,interface:id,inputs:Object.fromEntries(['build.mjs','plugin.js',...sources.map(item=>item.file)].map(name=>[name,digest(read(name))])),file:'fenglang_video.plugin.js',sha256:digest(compiled),status:'account-models-and-pricing-not-configured'};
for (const [name,value] of [['sources.lock.json',JSON.stringify(lock,null,2)+'\n'],['dist/fenglang_video.plugin.js',compiled],['dist/manifest.json',JSON.stringify(manifest,null,2)+'\n']]) {
  const file=new URL(name,root);
  if (check) { if(fs.readFileSync(file,'utf8')!==value) throw new Error('Stale artifact '+name); }
  else fs.writeFileSync(file,value);
}
console.log(JSON.stringify(manifest));
