import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
const argument = name => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error('Missing value for ' + name);
  return path.resolve(process.argv[index + 1]);
};
const profilesPath = argument('--profiles') || path.join(root, 'profiles.json');
const sourceLockPath = argument('--source-lock') || path.join(root, 'sources.lock.json');
const outputRoot = argument('--out') || path.join(root, 'dist');
export const providers = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
const localized = (en, zh) => ({en, 'zh-CN':zh});
const quantity = (unit, en, zh) => ({type:'number',unit,description:localized(en,zh)});
function schemaFor(p) {
  const schema = {};
  if (p.billing === 'unconfirmed' || p.billing === 'request_count') schema.request_count = p.kind === 'video' ? quantity('count','Video request unit price','视频请求单价') : quantity('count','Image request unit price','图片请求单价');
  if (p.billing === 'image_count' || (p.billing === 'unconfirmed' && p.kind === 'image')) schema.image_count = quantity('count','Image generation unit price','图片生成单价');
  if (p.billing === 'seconds' || (p.billing === 'unconfirmed' && p.kind === 'video' && (p.secondsField || p.fixedSeconds))) schema.seconds = quantity('second','Video generation unit price','视频生成单价');
  if (p.kind === 'video' && (p.resolutions || []).length > 1) schema.resolution = {enum:p.resolutions.map(v => v.toLowerCase()),description:localized('Resolution','分辨率')};
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
  const models = Object.keys(provider.models);
  const protocols = [], routes = [];
  for (const kind of ['image','video']) {
    const names = models.filter(n => provider.models[n].kind === kind);
    if (!names.length) continue;
    protocols.push({name:'openai_' + kind,models:names});
    for (const tail of kind === 'image' ? ['images/generations','images/edits'] : ['videos']) routes.push({method:'POST',path:'/' + provider.key + '/v1/' + tail,type:'submit',decode:'submit',render:'render',models:names});
  }
  routes.push({method:'GET',path:'/' + provider.key + '/v1/tasks/:task_id',type:'query',render:'render'});
  const description = protocols.length > 1 ? localized('Image and video task integration','图片与视频任务接入') : localized('Video task integration','视频任务接入');
  const meta = {apiVersion:1,key:provider.key,name:provider.name,version:provider.version || '1.0.1',author:{name:'juhefuwu'},description,website:provider.website,models,fetchMode:'per_task',protocols,routes,usageProfiles:models.map(model => {
    const p = provider.models[model], schema = schemaFor(p);
    return {models:[model],schema,examples:[{label:'Standard request',facts:exampleFor(p,schema)}]};
  })};
  if (provider.baseUrl) meta.baseUrl = provider.baseUrl;
  if (provider.modelDiscovery) meta.modelDiscovery = provider.modelDiscovery;
  return meta;
}
const runtime = fs.readFileSync(path.join(root,'runtime.js'),'utf8');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const sources = JSON.parse(fs.readFileSync(sourceLockPath,'utf8'));
const inputPaths = {'build.mjs':path.join(root,'build.mjs'),'profiles.json':profilesPath,'runtime.js':path.join(root,'runtime.js'),'sources.lock.json':sourceLockPath};
const manifest = {hostBaseCommit:sources.review20261015.hostBaseCommit,reviewedOn:'2026-10-15',status:'candidate-not-installed',inputs:Object.fromEntries(Object.entries(inputPaths).map(([file,target])=>[file,hash(fs.readFileSync(target))])),plugins:[]};
const check = process.argv.includes('--check');
function output(file, content) {
  const target = path.join(outputRoot,file);
  if (check) {
    if (!fs.existsSync(target) || fs.readFileSync(target,'utf8') !== content) throw new Error('Generated file differs: '+file);
  } else { fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,content); }
}
for (const provider of Object.values(providers)) {
  const meta = metadata(provider);
  const source = '// Generated by build.mjs from profiles.json and runtime.js; edit the sources.\n' +
    '// Historical baseline 2026-10-11; partial review 2026-10-15. See sources.lock.json limitations.\n' +
    '// Source lock SHA256: '+manifest.inputs['sources.lock.json']+'; candidate only, not installed.\n' +
    sources.review20261015.publicSources.filter(s=>new URL(s.url).hostname===new URL(provider.website).hostname || (provider.key==='xcmapi_media' && new URL(s.url).hostname==='xcmapi.org')).map(s=>'// Documentation: '+s.url+' SHA256 '+s.sha256+'\n').join('') +
    'const PROVIDER = ' + JSON.stringify(provider,null,2) + ';\n' +
    'export const meta = ' + JSON.stringify(meta,null,2) + ';\n' + runtime;
  output(provider.key + '.plugin.js',source);
  manifest.plugins.push({key:provider.key,version:meta.version,file:provider.key + '.plugin.js',models:meta.models.length,sha256:hash(source),modelDiscovery:!!meta.modelDiscovery});
}
output('manifest.json',JSON.stringify(manifest,null,2)+'\n');
console.log((check?'Verified ':'Built ') + manifest.plugins.length + ' candidate plugins (' + manifest.plugins.reduce((n,p) => n+p.models,0) + ' provider/model entries); no installed snapshots changed');
