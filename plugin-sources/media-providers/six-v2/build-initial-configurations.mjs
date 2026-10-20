// Build reviewable configuration drafts only. This script has no database,
// network, key loading, activation or production-cache mutation capability.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
const root=path.dirname(fileURLToPath(import.meta.url));
const catalogPath=path.resolve(root,'../../../pkg/modelconfig/catalog.json');
const text=fs.readFileSync(catalogPath,'utf8');
const catalog=JSON.parse(text);
const expected=['paisio_media','yuxibox_media','xcmapi_media','artbox_media','lxmone_media','zhangyuge_media'];
if(JSON.stringify(Object.keys(catalog.providers).sort())!==JSON.stringify([...expected].sort()))throw new Error('Exactly the six reviewed providers are required');
// Inputs must be reviewed real-discovery selections, never model examples.
const selectionArg=process.argv.indexOf('--models-file');
const selection=selectionArg<0 ? {} : JSON.parse(fs.readFileSync(process.argv[selectionArg+1],'utf8'));
const configurations={};
const summary=[];
for(const key of expected){
 const provider=catalog.providers[key];
 const document={format:'channel-model-configuration/v1',revision:0,provider:key,groups:{},bindings:{},sources:[]};
 for(const selected of selection[key]??[]){
  if(typeof selected.id!=='string'||!selected.id.trim()||selected.discoverySource!=='upstream-fetch')throw new Error('Only reviewed upstream-fetch IDs may initialize bindings');
  const baseline=provider.interfaces[selected.interfaceId];
  const reference=baseline ? {...baseline,...baseline.modelRules?.[selected.id]} : undefined;
  if(!reference||reference.kind!==selected.kind)throw new Error('Choose a documented interface/category for '+selected.id);
  const groupId='interface-'+crypto.createHash('sha256').update(selected.interfaceId+'|'+selected.id).digest('hex').slice(0,16);
  document.groups[groupId]??={name:reference.title,modes:{}};
  document.bindings[selected.id]={};
  const base=selected.kind==='image'?'text_image':'text_video';
  for(const mode of Object.keys(reference.modes)){
   const parameters=Object.fromEntries(Object.entries(reference.parameters).filter(([,p])=>p.required||p.definition['x-channel-parameter'].capabilities.includes('base')||p.definition['x-channel-parameter'].capabilities.includes(mode)));
   const mapping=Object.fromEntries(Object.keys(parameters).map(field=>[field,field]));
   document.groups[groupId].modes[mode]={strictMapping:true,enabled:mode===base||(!reference.modes[base]&&mode===Object.keys(reference.modes)[0]),input:{},parameters,mapping,cost:{amount:null,confirmed:false},source:reference.source};
   document.bindings[selected.id][mode]={groupId,protocol:{templateModel:selected.interfaceId,confirmed:selected.confirmed===true}};
  }
 }
 configurations[key]=document;
 summary.push({provider:key,selectedRealModels:Object.keys(document.bindings).length,documentedInterfaces:Object.keys(provider.interfaces).length,accountPriceVerified:false});
}
const output={format:'six-provider-initialization-drafts/v1',status:'review-plan-requires-real-discovery-and-interface-confirmation',catalogSHA256:crypto.createHash('sha256').update(text).digest('hex'),preserveKeys:true,mutatesDatabase:false,summary,configurations};
const outputArg=process.argv.indexOf('--output');
const target=outputArg<0 ? path.join(root,'initial-configurations.json') : process.argv[outputArg+1];
const content=JSON.stringify(output,null,2)+'\n';
if(process.argv.includes('--check')){if(!fs.existsSync(target)||fs.readFileSync(target,'utf8')!==content)throw new Error('Initialization drafts are stale')}
else fs.writeFileSync(target,content);
console.log(JSON.stringify({status:output.status,mutatesDatabase:false,summary},null,2));
