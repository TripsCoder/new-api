import fs from 'node:fs';
import crypto from 'node:crypto';

const root = new URL('./', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8').replace(/\r\n/g, '\n');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const check = process.argv.includes('--check');
const sourceText = read('evidence/video-docs.json');
const docs = JSON.parse(sourceText);
const source = {url:'https://online.apipath.top/api/api-docs',sha256:sha(sourceText),readAt:'2026-11-02',scope:'Published video records only; not authenticated account discovery'};
const id = 'interface:' + sha('apipath_video:POST:/v1/video/generations').slice(0,16);
const aliases = {
  model:['model'], prompt:['prompt','input'], seconds:['duration','duration_seconds','seconds'],
  count:['count'],size:['size'],resolution:['resolution'],orientation:['orientation'],aspect_ratio:['aspect_ratio','ratio'],
  images:['reference_images','input_reference','image'],videos:['reference_videos'],audios:['reference_audios'],
  start_image_url:['first_frame','first_frame_image'],end_image_url:['last_frame','last_frame_image'],
};
const modes = ['text_video','image_video','frames','video_ref','audio_ref','mixed_ref'];
const capability = field => field==='images' ? ['image_video','video_ref','audio_ref','mixed_ref'] : field==='videos' ? ['video_ref','mixed_ref'] : field==='audios' ? ['audio_ref','mixed_ref'] : field.endsWith('_image_url') ? ['frames'] : ['base'];

function contractFor(parameters, status, recordSource) {
  const fields = {}, wire = {};
  for (const [field,names] of Object.entries(aliases)) {
    const entries = names.map(name=>parameters.find(p=>p.name===name)).filter(Boolean);
    if (!entries.length) continue;
    const original = entries[0];
    const type = ['images','videos','audios'].includes(field) ? 'array' : original.type;
    if (!['string','integer','boolean','array','number'].includes(type)) throw new Error('Unreviewed field type: '+original.type);
    const schema = {type,description:original.description};
    if (type==='array') schema.items={type:'string',format:'uri'};
    for (const key of ['enum','minimum','maximum','minItems','maxItems','minLength','maxLength']) if (original[key]!==undefined) schema[key]=original[key];
    if (field==='prompt') schema.minLength=1;
    if (original.default!==undefined) schema.documentedDefault=original.default;
    schema['x-channel-parameter']={vendorFields:names.filter(name=>entries.some(p=>p.name===name) || ['first_frame_image','last_frame_image'].includes(name)),capabilities:capability(field),requiredIn:[]};
    fields[field]={type,required:original.required===true,description:original.description,definition:schema,source:recordSource};
    for (const key of ['enum','minimum','maximum']) if(schema[key]!==undefined) fields[field][key]=schema[key];
    const {documentedDefault,description,...validation}=schema;
    wire[original.name]={field,required:original.required===true,schema:validation};
  }
  const supported=modes.filter(mode=>!(['video_ref','mixed_ref'].includes(mode)&&!fields.videos) && !(['audio_ref','mixed_ref'].includes(mode)&&!fields.audios));
  const contract={id,title:'APIPath 创建视频任务',kind:'video',method:'POST',path:'/v1/video/generations',status,source:recordSource,
    parameters:fields,mapping:Object.fromEntries(Object.keys(fields).map(field=>[field,field])),modes:Object.fromEntries(supported.map(mode=>[mode,{required:[]}])),
    capabilities:{firstFrame:!!fields.start_image_url,lastFrame:!!fields.end_image_url,multipleReferences:!!fields.images}};
  const codec={kind:'video',documentInterface:true,publicReferences:true,billing:'unconfirmed',submit:contract.path,query:'/v1/tasks/',wire};
  return {...contract,codec};
}

const knownNames=new Set(Object.values(aliases).flat());
const modelRules={};
for(const doc of docs){
  if(doc.request_mode!=='video'||doc.endpoint!=='/v1/video/generations'||!doc.is_published||!doc.model_code)throw new Error('Unreviewed video record');
  for(const p of doc.content.parameters)if(!knownNames.has(p.name))throw new Error('New parameter needs review: '+p.name);
  if(modelRules[doc.model_code])throw new Error('Duplicate exact platform ID');
  modelRules[doc.model_code]=contractFor(doc.content.parameters,'documented-model-not-account-verification',{...source,scope:'Published record '+doc.id+'; platform ID '+doc.model_code});
}
// Generic interface fields are a type-level union, without another model's
// candidates, bounds or defaults. Exact model records override the whole rule.
const common=[];
for(const doc of docs)for(const p of doc.content.parameters)if(!common.some(x=>x.name===p.name)){
  const {enum:values,minimum,maximum,default:documentedDefault,...field}=p;
  common.push(field);
}
const contract=contractFor(common,'documented-interface-model-applicability-pending',source);
contract.modelRules=modelRules;
contract.pending=[
  'Published model codes are documentation evidence, not authenticated /v1/models results or enabled channel routes',
  'Unknown account models need explicit interface applicability review; exact documented model limits are not inferred from names',
  'Reference item limits and combinations are not specified by these request parameter tables and remain pending supplier confirmation',
  'The document describes image as template-dependent; use explicit first_frame or reference_images when its role matters',
  'Resolution documented defaults may differ in letter case from candidates; no documentation defaults or example prices become business defaults',
  'No verified actual output duration is documented; completion retains requested usage without reading estimated_cost',
  'Authenticated discovery and paid generation have not been performed',
];
const {codec,...definition}=contract;
definition.modelRules=Object.fromEntries(Object.entries(modelRules).map(([name,{codec,...rule}])=>[name,rule]));
const usageSchema={request_count:{type:'number',unit:'count',description:{en:'Video generation unit price',zh:'视频生成单价'}},seconds:{type:'number',unit:'second',description:{en:'Video generation unit price',zh:'视频生成单价'}},resolution:{enum:[...new Set(docs.flatMap(d=>d.content.parameters.find(p=>p.name==='resolution')?.enum || []))],description:{en:'Requested video resolution',zh:'请求视频分辨率'}}};
const meta={apiVersion:1,key:'apipath_video',name:'APIPath 视频',version:'2.1.0',author:{name:'TripsCoder'},icon:'text:AP',description:{en:'Video generation through the APIPath API',zh:'通过 APIPath 接口生成视频'},website:'https://online.apipath.top/app/api-docs',baseUrl:'https://online.apipath.top',auth:'api_key',models:docs.map(d=>d.model_code),fetchMode:'per_task',protocols:['openai_video'],modelDiscovery:{path:'/v1/models',format:'openai',sourceUrl:source.url,sourceSha256:source.sha256},parameterInterfaces:{[id]:definition},usageSchema};
const provider={key:meta.key,name:meta.name,baseUrl:meta.baseUrl,models:{},interfaces:{[id]:contract}};
const catalog={key:meta.key,name:meta.name,baseURL:meta.baseUrl,docsURL:meta.website,models:{},interfaces:meta.parameterInterfaces,
  documents:[{id,title:contract.title,method:contract.method,path:contract.path,description:'Canonical request parameters from published APIPath video records',source,schema:{type:'object',properties:Object.fromEntries(Object.entries(contract.parameters).map(([key,p])=>[key,p.definition])),required:Object.entries(contract.parameters).filter(([,p])=>p.required).map(([key])=>key)}}],warnings:contract.pending};
const inputs=['build.mjs','apipath-runtime.js','evidence/video-docs.json','../media-providers/six-v2/runtime.js','../media-providers/six-v2/interface-runtime.js'];
const compiled='// Generated from reviewed APIPath documents; shared video runtime remains unchanged.\nconst PROVIDER = '+JSON.stringify(provider,null,2)+';\nexport const meta = '+JSON.stringify(meta,null,2)+';\n'+inputs.slice(3).map(read).join('\n')+'\n'+read('apipath-runtime.js');
const manifest={format:'apipath-video-build/v1',key:meta.key,version:meta.version,inputs:Object.fromEntries(inputs.map(file=>[file,sha(read(file))])),file:'apipath_video.plugin.js',sha256:sha(compiled)};
const lock={format:'apipath-video-sources/v1',policy:'../juhefuwu/docs/operations/upstream-channel-troubleshooting.md#imported-parameter-policy',sources:[source],modelDeclarations:{status:'published-documentation-only',exactIDs:meta.models},reusedRuntime:inputs.slice(3),pending:contract.pending,paidCalls:0,accountPricesImported:false};
for(const [name,value]of [['../../pkg/modelconfig/apipath_video.catalog.json',catalog],['sources.lock.json',lock],['dist/manifest.json',manifest],['dist/apipath_video.plugin.js',compiled]]){
  const file=new URL(name,root),content=typeof value==='string'?value:JSON.stringify(value,null,2)+'\n';
  if(check){if(read(name)!==content)throw new Error('Stale artifact '+name);}else{fs.mkdirSync(new URL('./',file),{recursive:true});fs.writeFileSync(file,content);}
}
console.log(JSON.stringify(manifest));
