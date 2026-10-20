import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
const root=path.dirname(fileURLToPath(import.meta.url));
const expected=['paisio_media','yuxibox_media','xcmapi_media','artbox_media','lxmone_media','zhangyuge_media'];
const profiles=JSON.parse(fs.readFileSync(path.join(root,'profiles.json'),'utf8'));
if(JSON.stringify(Object.keys(profiles).sort())!==JSON.stringify([...expected].sort()))throw new Error('Exactly six providers are required');
const providers=profiles;
const pluginVersion='2.1.5';
const localized = (en, zh) => ({en, 'zh-CN':zh});
const quantity = (unit, en, zh) => ({type:'number',unit,description:localized(en,zh)});
function schemaFor(p) {
  const schema = {};
  if (p.billing === 'unconfirmed' || p.billing === 'request_count') schema.request_count = p.kind === 'video' ? quantity('count','Video request unit price','视频请求单价') : quantity('count','Image request unit price','图片请求单价');
  if (p.billing === 'image_count' || (p.billing === 'unconfirmed' && p.kind === 'image')) schema.image_count = quantity('count','Image generation unit price','图片生成单价');
  if (p.billing === 'seconds' || (p.billing === 'unconfirmed' && p.kind === 'video' && (p.secondsField || p.fixedSeconds))) schema.seconds = quantity('second','Video generation unit price','视频生成单价');
  if (p.kind === 'video') schema.resolution = {enum:[...new Set([...(p.resolutions || []).map(v => v.toLowerCase()), '480p', '720p', '1080p'])],description:localized('Output video resolution','输出视频分辨率')};
  if (p.billImageSize) schema.image_size = {enum:p.imageSizes || [...new Set(Object.values(p.sizeTiers))],description:localized('Image resolution','图片分辨率')};
  if (p.qualityTier) schema.quality_tier = {enum:['standard','enhanced'],description:localized('Image quality','图片画质'),enumLabels:{standard:localized('Standard','标准'),enhanced:localized('Enhanced','增强')}};
  if (p.audio) schema.generate_audio = {type:'boolean',description:localized('Generate audio','生成音频')};
  return schema;
}
function exampleFor(p, schema) {
  const facts = {};
  for (const [field, value] of Object.entries(schema)) {
    facts[field] = value.enum ? value.enum[0] : value.type === 'boolean' ? (p.audioDefault || false) : field === 'seconds' ? p.defaultSeconds || p.secondsChoices?.[0] || p.minSeconds : 1;
  }
  return facts;
}
export function metadata(provider) {
  const models = Object.keys(provider.models).filter(name=>!provider.models[name].compatibilityAlias);
  const protocols = [], routes = [];
  for (const kind of ['image','video']) {
    const names = models.filter(n => provider.models[n].kind === kind);
    if (!names.length) continue;
    protocols.push({name:'openai_' + kind,models:names});
    for (const tail of kind === 'image' ? ['images/generations','images/edits'] : ['videos']) routes.push({method:'POST',path:'/' + provider.key + '/v1/' + tail,type:'submit',decode:'submit',render:'render',models:names});
  }
  routes.push({method:'GET',path:'/' + provider.key + '/v1/tasks/:task_id',type:'query',render:'render'});
  const description = protocols.length > 1 ? localized('Image and video task integration','图片与视频任务接入') : localized('Video task integration','视频任务接入');
  const meta = {apiVersion:1,key:provider.key,name:provider.name,version:pluginVersion,author:{name:'juhefuwu'},description,website:provider.website,models,fetchMode:'per_task',protocols,routes,usageProfiles:models.map(model => {
    const p = provider.models[model], schema = schemaFor(p);
    return {models:[model],schema,examples:[{label:'Standard request',facts:exampleFor(p,schema)}]};
  })};
  if (provider.baseUrl) meta.baseUrl = provider.baseUrl;
  if (provider.modelDiscovery) meta.modelDiscovery = provider.modelDiscovery;
  meta.parameterInterfaces = Object.fromEntries(Object.entries(provider.interfaces).map(([key,value]) => {
    const {codec,...contract}=value;
    if (contract.modelRules) contract.modelRules = Object.fromEntries(Object.entries(contract.modelRules).map(([model, rule]) => { const {codec,...definition}=rule; return [model,definition]; }));
    return [key,contract];
  }));
  return meta;
}

const runtime=fs.readFileSync(path.join(root,'runtime.js'),'utf8')+'\n'+fs.readFileSync(path.join(root,'interface-runtime.js'),'utf8');
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
const inputs=Object.fromEntries(['profiles.json','runtime.js','interface-runtime.js','interface_contracts.py','sources.lock.json','build.mjs'].map(name=>[name,digest(fs.readFileSync(path.join(root,name)))]));
const manifest={format:'six-provider-plugin-build/v2',version:pluginVersion,status:'candidate-not-installed',preserveKeys:true,inputs,plugins:[]};
const check=process.argv.includes('--check');
const only=process.argv.find(arg=>arg.startsWith('--provider='))?.split('=')[1];
if(only && !expected.includes(only))throw new Error('Unknown provider');
if(only){const previous=JSON.parse(fs.readFileSync(path.join(root,'dist/manifest.json'),'utf8'));manifest.plugins=previous.plugins.filter(p=>p.key!==only);}
function output(name,content){const target=path.join(root,'dist',name);if(check){if(!fs.existsSync(target)||fs.readFileSync(target,'utf8')!==content)throw new Error('Stale generated artifact: '+name)}else{fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content)}}
for(const provider of Object.values(profiles)){
 if(only && provider.key!==only)continue;
 const meta=metadata(provider);
 // Native edit routes claim only exact models whose source declares edits.
 for(const route of meta.routes)if(route.path.endsWith('/images/edits'))route.models=route.models.filter(name=>!!provider.models[name].edit);
 const source='// Generated six-provider v2 candidate. Do not edit this file.\n'+
  '// Source-backed definitions; not installed or account-verified.\n'+
  '// Profiles SHA256 '+inputs['profiles.json']+'; source lock SHA256 '+inputs['sources.lock.json']+'\n'+
  'const PROVIDER = '+JSON.stringify(provider,null,2)+';\nexport const meta = '+JSON.stringify(meta,null,2)+';\n'+runtime+(provider.key==='yuxibox_media'?'\n'+fs.readFileSync(path.join(root,'yuxibox-runtime.js'),'utf8'):'');
 const file=provider.key+'.plugin.js';output(file,source);
 manifest.plugins.push({key:provider.key,version:meta.version,file,models:meta.models.length,pendingModels:Object.keys(provider.pendingModels).length,sha256:digest(source)});
}
output('manifest.json',JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({status:manifest.status,plugins:manifest.plugins.map(({key,models,pendingModels})=>({key,models,pendingModels}))}));
