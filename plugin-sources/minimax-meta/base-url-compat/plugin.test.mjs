import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const root=new URL('./',import.meta.url);
const read=file=>fs.readFileSync(new URL(file,root),'utf8');
const names=['meta','protocols','buildSubmitRequest','buildQueryRequest','parseSubmitResponse','parseTaskResult','extractUsage','extractUsageOnComplete','extractMediaSources','listArtifacts','buildContentRequest'];
const load=source=>vm.runInNewContext(source.replace(/^export /gm,'')+'\n({'+names.join(',')+'})',{});
const before=load(read('upstream-1.2.1.plugin.js'));
const plugin=load(read('dist/minimax-meta.plugin.js'));
const plain=value=>JSON.parse(JSON.stringify(value));
const manifest=JSON.parse(read('dist/manifest.json'));
assert.equal(crypto.createHash('sha256').update(read('dist/minimax-meta.plugin.js')).digest('hex'),manifest.sha256);
assert.deepEqual({...plain(plugin.meta),version:'1.2.1'},plain(before.meta));
assert.deepEqual(plain(plugin.meta.usageSchema.resolution.enum),['480p','768P','1080p','2K']);
const cases=[];
const add=(name,hook,args,expected,expectedError,path)=>cases.push({name,hook,args,...(expectedError?{expectedError}:{expected}),...(path?{path}:{})});
const decode=input=>before.protocols.openai_video.decodeRequest({model:'MiniMax-H3',body:{kind:'json',value:{model:'MiniMax-H3',prompt:'offline fixture',seconds:5,resolution:'480p',ratio:'9:16',...input}}}).requestBody;
const ctx=(baseUrl='https://metaso.cn',input={})=>({model:'MiniMax-H3',baseUrl,apiKey:'offline-only',requestBody:decode(input),files:[]});
const submitSuffix='/minimax/v2/video_generation';
const querySuffix='/minimax/v2/query/video_generation/';
const original=ctx();
assert.equal(before.buildSubmitRequest(original).url,'https://metaso.cn'+submitSuffix);
assert.equal(plugin.buildSubmitRequest(original).url,'https://metaso.cn/api'+submitSuffix);

for(const [base,expectedBase] of [
  ['https://metaso.cn','https://metaso.cn/api'],
  ['https://metaso.cn/','https://metaso.cn/api'],
  ['https://metaso.cn///','https://metaso.cn/api'],
  ['https://metaso.cn/api','https://metaso.cn/api'],
  ['https://metaso.cn/api/','https://metaso.cn/api'],
  [' https://metaso.cn/api/// ','https://metaso.cn/api'],
  ['https://proxy.example/prefix/api/','https://proxy.example/prefix/api'],
  ['https://proxy.example/custom/','https://proxy.example/custom'],
  ['http://localhost:3000','http://localhost:3000/api'],
]){
  const context=ctx(base);
  add('submit Base '+JSON.stringify(base),'buildSubmitRequest',[context],{...plain(before.buildSubmitRequest(context)),url:expectedBase+submitSuffix});
  for(const taskId of ['same-task','task/a b?']){
    const query={...context,taskId};
    add('query Base '+JSON.stringify(base)+' '+taskId,'buildQueryRequest',[query],{...plain(before.buildQueryRequest(query)),url:expectedBase+querySuffix+encodeURIComponent(taskId)});
  }
}
for(const [resolution,seconds] of [['480p',5],['480p',30],['768P',5],['768P',30],['1080p',5],['1080p',15],['2K',5],['2K',15]]){
  for(const ratio of ['9:16','16:9']){
    const context=ctx('https://metaso.cn/api',{resolution,seconds,ratio});
    add('unchanged body '+resolution+'/'+seconds+'/'+ratio,'buildSubmitRequest',[context],plain(before.buildSubmitRequest(context)));
    add('unchanged usage '+resolution+'/'+seconds+'/'+ratio,'extractUsage',[context],plain(before.extractUsage(context)));
  }
}
const image={type:'image_url',role:'reference_image',image_url:{url:'https://cdn.example/image.png'}};
const video={type:'video_url',role:'reference_video',video_url:{url:'https://cdn.example/reference.mp4'}};
const audio={type:'audio_url',role:'reference_audio',audio_url:{url:'https://cdn.example/reference.mp3'}};
for(const [name,input] of [
  ['image',{content:[image]}],
  ['extra images',{content:Array.from({length:7},()=>image)}],
  ['reference video',{content:[video]}],
  ['reference audio',{content:[audio]}],
  ['mixed references',{content:[image,video,audio]}],
  ['optional fields',{aigc_watermark:false,context_ir_enabled:false,callback_url:'https://callback.example/status',billing_policy:'fixture'}],
]){
  const context=ctx('https://metaso.cn/api',input);
  for(const hook of ['buildSubmitRequest','extractUsage','extractMediaSources']){
    add('unchanged '+name+' '+hook,hook,[context],plain(before[hook](context)));
  }
}
for(const input of [{resolution:'4K'},{resolution:'2K',seconds:16},{resolution:'480p',seconds:31},{seconds:3}]){
  for(const hook of ['buildSubmitRequest','extractUsage']){
    const context={model:'MiniMax-H3',baseUrl:'https://metaso.cn',apiKey:'offline-only',requestBody:{prompt:'offline',seconds:5,resolution:'480p',...input}};
    let message;
    try{before[hook](context);}catch(error){message=error.message;}
    assert.ok(message);
    add('unchanged invalid input '+hook+' '+JSON.stringify(input),hook,[context],null,message);
  }
}
const success={task:{id:'original-task',status:'succeeded',duration:5,resolution:'480p',content:{url:'https://cdn.example/result.mp4'},usage:{input_seconds:0}}};
const failure={task:{id:'original-task',status:'failed',error:{message:'provider rejected'}}};
for(const body of [success,failure,{task:{id:'original-task',status:'running'}},{task:{id:'original-task',status:'queued'}}]){
  add('unchanged poll '+body.task.status,'parseTaskResult',[{},body],plain(before.parseTaskResult({},body)));
}
add('unchanged submit receipt','parseSubmitResponse',[{},{body:{task_id:'original-task'}}],plain(before.parseSubmitResponse({},{body:{task_id:'original-task'}})));
add('unchanged completed usage','extractUsageOnComplete',[{},success],plain(before.extractUsageOnComplete({},success)));
const task={status:'SUCCESS',data:success};
add('unchanged artifacts','listArtifacts',[task],plain(before.listArtifacts(task)));
for(const method of ['GET','HEAD']){
  const content={data:success,clientRequest:{method},apiKey:'offline-only'};
  add('unchanged credentialless content '+method,'buildContentRequest',[content],plain(before.buildContentRequest(content)));
}
add('unchanged OpenAI decoder','protocols',[{model:'MiniMax-H3',body:{kind:'json',value:{model:'MiniMax-H3',prompt:'offline',seconds:5,resolution:'480p'}}}],plain(before.protocols.openai_video.decodeRequest({model:'MiniMax-H3',body:{kind:'json',value:{model:'MiniMax-H3',prompt:'offline',seconds:5,resolution:'480p'}}})),null,['openai_video','decodeRequest']);
for(const entry of cases){
  let hook=plugin[entry.hook];
  for(const key of entry.path||[])hook=hook[key];
  if(entry.expectedError)assert.throws(()=>hook(...entry.args),error=>error.message===entry.expectedError,entry.name);
  else assert.deepEqual(plain(hook(...entry.args)),entry.expected,entry.name);
}
fs.writeFileSync(new URL('fixture.json',root),JSON.stringify({unixNow:1,cases},null,2)+'\n');
console.log('MiniMax-Meta Base compatibility: '+cases.length+'/'+cases.length+' passed; provider calls: 0');
