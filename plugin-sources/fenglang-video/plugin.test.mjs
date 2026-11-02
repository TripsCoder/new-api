import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const source=fs.readFileSync(new URL('./dist/fenglang_video.plugin.js',import.meta.url),'utf8');
const plugin=vm.runInNewContext(source.replace(/^export /gm,'')+'\n({meta,protocols,buildSubmitRequest,parseSubmitResponse,buildQueryRequest,parseTaskResult,extractUsage,extractUsageOnComplete,listArtifacts,buildContentRequest})',{utils:{uuid:()=> 'task_fixture'}});
const id=Object.keys(plugin.meta.parameterInterfaces)[0];
const ctx=(input={},model='seedance-2.5')=>({model,upstreamModel:model,baseUrl:'https://supplier.example/open/v1',apiKey:'fixture-only',publicTaskId:'task_public',files:[],requestBody:{operation:'video_generate',protocolTemplate:id,input:{prompt:'Fixture',...input},uploads:[]}});
const descriptor=body=>({url:'https://supplier.example/open/v1/videos',method:'POST',headers:{Authorization:'Bearer fixture-only',Accept:'application/json','Content-Type':'application/json'},body:{model:'seedance-2.5',prompt:'Fixture',mode:'t2v',...body}});
const cases=[];
const add=(name,hook,args,expected,expectedError,path)=>cases.push({name,hook,args,...(path?{path}:{}),...(expectedError?{expectedError}:{expected})});
const image='https://media.example/a.png?sig=a%2Fb%2B';
add('no example defaults forwarded','buildSubmitRequest',[ctx()],descriptor({}));
add('false and zero survive','buildSubmitRequest',[ctx({seconds:'5',generate_audio:false,watermark:false,seed:0,resolution:'720p',aspect_ratio:'16:9',output_format:'mov'})],descriptor({seconds:5,generate_audio:false,watermark:false,seed:0,resolution:'720p',aspect_ratio:'16:9',output_format:'mov'}));
add('i2v has independent first frame','buildSubmitRequest',[ctx({input_reference:image,seconds:4})],descriptor({mode:'i2v',input_reference:image,seconds:4}));
add('firstlast preserves frame roles','buildSubmitRequest',[ctx({start_image_url:image,last_frame:'https://media.example/end.png'})],descriptor({mode:'firstlast',input_reference:image,last_frame:'https://media.example/end.png'}));
add('reference order and all media types preserved','buildSubmitRequest',[ctx({images:[image,'https://media.example/b.png'],videos:['https://media.example/v.mp4'],audios:['https://media.example/a.wav']})],descriptor({mode:'reference',reference_image_urls:[image,'https://media.example/b.png'],reference_video_urls:['https://media.example/v.mp4'],reference_audio_urls:['https://media.example/a.wav']}));
for(const input of [{seconds:3},{seconds:31},{seconds:3601},{seconds:0},{seconds:-1},{seconds:4.5},{seconds:false},{seconds:9007199254740992}])add('invalid seconds '+JSON.stringify(input),'buildSubmitRequest',[ctx(input)],null,'seconds');
add('duration alias equal','buildSubmitRequest',[ctx({duration:30,seconds:'30',seed:-1})],descriptor({seconds:30,seed:-1}));
add('duration conflict','buildSubmitRequest',[ctx({duration:5,seconds:6})],null,'冲突');
add('fast rejects 1080p','buildSubmitRequest',[ctx({resolution:'1080p'},'seedance-2.0-fast')],null,'resolution');
add('H3 rejects reference video','buildSubmitRequest',[ctx({videos:['https://media.example/v.mp4']},'minimax-video-h3')],null,'数量');
add('H3 unsupported audio control','buildSubmitRequest',[ctx({generate_audio:false},'minimax-video-h3')],null,'未被');
for(const input of [{images:Array(31).fill(image)},{videos:Array(11).fill('https://media.example/v.mp4')},{audios:Array(11).fill('https://media.example/a.wav')}])add('reference count '+Object.keys(input)[0],'buildSubmitRequest',[ctx(input)],null,'数量');
for(const input of [{input_reference:image,images:[image]},{last_frame:image},{mode:'i2v'},{mode:'t2v',input_reference:image},{mode:'reference'},{mode:'firstlast',input_reference:image},{mode:'bad'}])add('mode conflict '+JSON.stringify(input),'buildSubmitRequest',[ctx(input)],null,input.images?'混用':input.last_frame?'首帧':'mode');
for(const value of ['http://media.example/a.png','https://user:pass@media.example/a.png','https://media.example\\@evil.example/a.png','data:image/png;base64,AAAA'])add('invalid media '+value,'buildSubmitRequest',[ctx({images:[value]})],null,'HTTPS');
add('unknown optional fields omitted','buildSubmitRequest',[ctx({n:100,metadata:{seconds:30},unknown:'x',protocolTemplate:'spoof'})],descriptor({}));
add('unknown model has no guessed per-model limits','buildSubmitRequest',[ctx({seconds:45,resolution:'4k'},'account-new')],descriptor({model:'account-new',seconds:45,resolution:'4k'}));
add('missing confirmed interface','buildSubmitRequest',[{...ctx(),requestBody:{operation:'video_generate',input:{prompt:'Fixture'}}}],null,'确认');
add('decoder defers malformed optional members to host','protocols',[{model:'actual',body:{kind:'json',value:{model:'actual',prompt:'Fixture',images:false,watermark:0}}}],{kind:'submit',model:'actual',action:'video_generate',requestBody:{operation:'video_generate',input:{model:'actual',prompt:'Fixture',images:false,watermark:0},uploads:[]}},null,['openai_video','decodeRequest']);
add('multipart not mislabeled JSON','protocols',[{model:'actual',body:{kind:'multipart',fields:{},files:[]}}],null,'JSON',['openai_video','decodeRequest']);
add('vendor first frame classified before host capability filtering without value validation','protocols',[{model:'actual',body:{kind:'json',value:{prompt:'Fixture',input_reference:false}}}],{kind:'submit',model:'actual',action:'video_generate',requestBody:{operation:'video_generate',input:{prompt:'Fixture',start_image_url:false},uploads:[]}},null,['openai_video','decodeRequest']);
const envelope={success:true,task:{id:'private_A/B',done:false,status:'queued'}};
add('nested submit ID','parseSubmitResponse',[ctx(),{statusCode:202,body:envelope}],{taskId:'private_A/B',taskData:envelope,state:{protocolTemplate:id}});
add('escaped polling ID retains full base','buildQueryRequest',[{...ctx(),taskId:'private_A/B'}],{url:'https://supplier.example/open/v1/tasks/private_A%2FB',method:'GET',headers:{Authorization:'Bearer fixture-only',Accept:'application/json'}});
add('completed status with done false keeps polling','parseTaskResult',[{},{success:true,task:{status:'completed',done:false,videoUrl:'https://media.example/v.mp4'}}],{status:'IN_PROGRESS',progress:'0%'});
add('queued polling','parseTaskResult',[{},envelope],{status:'QUEUED',progress:'0%'});
add('public completed video','parseTaskResult',[{},{success:true,task:{done:true,status:'completed',videoUrl:'https://media.example/v.mp4'}}],{status:'SUCCESS',progress:'100%',url:'https://media.example/v.mp4'});
add('completed protected video','parseTaskResult',[{},{success:true,task:{done:true,status:'completed',downloadUrl:'https://evil.example/steal'}}],{status:'SUCCESS',progress:'100%'});
add('failed refunded task','parseTaskResult',[{},{success:true,task:{done:true,status:'failed',error:'bad material',refunded:true}}],{status:'FAILURE',progress:'100%',reason:'bad material'});
add('unknown terminal state','parseTaskResult',[{},{success:true,task:{done:true,status:'new-state'}}],{status:'UNKNOWN',reason:'未识别上游终态'});
add('missing done','parseTaskResult',[{},{success:true,task:{status:'completed'}}],{status:'UNKNOWN',reason:'任务响应缺少明确的 success、task 或 done'});
const failure={success:false,code:'BAD',message:'Bearer sk-fixture https://secret.example/key'};
add('HTTP 200 failure settles without retry','parseSubmitResponse',[ctx(),{statusCode:200,body:failure}],{taskId:'task_public',taskData:failure,immediate:{status:'FAILURE',progress:'100%',reason:'Bearer [redacted] [URL]'}});
add('missing submit ID fails uncertain','parseSubmitResponse',[ctx(),{statusCode:202,body:{success:true,task:{}}}],null,'task.id');
add('requested seconds reserve after effective filtering','extractUsage',[ctx({seconds:8,n:50})],{request_count:1,seconds:8});
for(const resolution of ['480p','720p'])add('pricing dimension '+resolution,'extractUsage',[ctx({seconds:4,resolution},'seedance-2.0-mini')],{request_count:1,seconds:4,resolution});
add('saved duration alias feeds usage with resolution','extractUsage',[ctx({duration:'8',resolution:'720p'},'seedance-2.0-mini')],{request_count:1,seconds:8,resolution:'720p'});
add('unknown resolution retains legacy seconds-only usage','extractUsage',[ctx({seconds:45,resolution:'4k'},'account-new')],{request_count:1,seconds:45});
add('missing requested seconds cannot bill as zero','extractUsage',[ctx()],null,'预扣');
add('no invented actual duration or refund','extractUsageOnComplete',[{}, {}, {success:true,task:{seconds:99,refunded:true,cost:5}}],{});
const content={...ctx(),artifactKey:'video',status:'SUCCESS',upstreamTaskId:'private_A/B',data:{success:true,task:{downloadUrl:'https://evil.example/key',contentUrl:'https://other.example/content'}},clientRequest:{method:'HEAD',headers:{Range:'bytes=0-15'}}};
add('authenticated download ignores response-controlled URLs','buildContentRequest',[content],{url:'https://supplier.example/open/v1/tasks/private_A%2FB/download',method:'HEAD',headers:{Authorization:'Bearer fixture-only'}});
add('public video never receives supplier credentials','buildContentRequest',[{...content,data:{success:true,task:{videoUrl:'https://cdn.example/v.mov'}}}],{url:'https://cdn.example/v.mov',method:'HEAD',credentialless:true});
add('unfinished content rejected','buildContentRequest',[{...content,status:'IN_PROGRESS'}],null,'不可用');
add('artifact does not assume mp4','listArtifacts',[{status:'SUCCESS',data:{success:true,task:{}}}],[{key:'video',type:'video'}]);
add('renderer hides private ID and uses host content','protocols',[{},{task_id:'task_public',status:'SUCCESS',data:envelope}],{url:'/v1/videos/task_public/content'},null,['openai_video','render']);
const officialID=Object.keys(plugin.meta.parameterInterfaces).find(key=>plugin.meta.parameterInterfaces[key].path==='/api/v3/contents/generations/tasks');
const official=(input={},model='doubao-seedance-2-5-260628')=>({...ctx({resolution:'720p',...input},model),requestBody:{...ctx({resolution:'720p',...input},model).requestBody,protocolTemplate:officialID}});
const officialBody={model:'doubao-seedance-2-5-260628',content:[{type:'text',text:'Fixture'}],resolution:'720p'};
const officialDescriptor=body=>({...descriptor(),url:'https://supplier.example/api/v3/contents/generations/tasks',body:{...officialBody,...body}});
add('official omission does not inject supplier defaults','buildSubmitRequest',[official()],officialDescriptor({}));
add('official scalars preserve explicit false and zero','buildSubmitRequest',[official({duration:6,ratio:'1:1',seed:0,generate_audio:false,watermark:false,return_last_frame:false,draft:false,priority:0,output_format:'mov',unknown:'ignored'})],officialDescriptor({duration:6,ratio:'1:1',seed:0,generate_audio:false,watermark:false,return_last_frame:false,draft:false,priority:0,output_format:'mov'}));
add('official exact -s ID is not rewritten','buildSubmitRequest',[official({},'doubao-seedance-2-5-260628-s')],officialDescriptor({model:'doubao-seedance-2-5-260628-s'}));
add('official frame roles','buildSubmitRequest',[official({start_image_url:image,end_image_url:'https://media.example/end.png'})],officialDescriptor({content:[{type:'text',text:'Fixture'},{type:'image_url',image_url:{url:image},role:'first_frame'},{type:'image_url',image_url:{url:'https://media.example/end.png'},role:'last_frame'}]}));
add('official reference roles and order','buildSubmitRequest',[official({images:[image],videos:['https://media.example/v.mp4'],audios:['https://media.example/a.wav']})],officialDescriptor({content:[{type:'text',text:'Fixture'},{type:'image_url',image_url:{url:image},role:'reference_image'},{type:'video_url',video_url:{url:'https://media.example/v.mp4'},role:'reference_video'},{type:'audio_url',audio_url:{url:'https://media.example/a.wav'},role:'reference_audio'}]}));
for(const [input,model,error] of [
  [{resolution:'4k'},'doubao-seedance-2-5-260628','resolution'],
  [{resolution:'480p'},'doubao-seedance-2-5-260628-s','resolution'],
  [{resolution:'1080p'},'doubao-seedance-2-0-fast-260128-s','resolution'],
  [{seconds:16},'doubao-seedance-2-0-260128','seconds'],
  [{seconds:31},'doubao-seedance-2-5-260628','seconds'],
  [{images:Array(10).fill(image)},'doubao-seedance-2-0-260128','数量'],
  [{start_image_url:image,videos:['https://media.example/v.mp4']},'doubao-seedance-2-5-260628','混用'],
  [{resolution:''},'doubao-seedance-2-5-260628','resolution'],
  [{priority:10},'doubao-seedance-2-5-260628','priority'],
])add('official validates '+JSON.stringify(input),'buildSubmitRequest',[official(input,model)],null,error);
add('official model cannot use original endpoint','buildSubmitRequest',[ctx({seconds:5},'doubao-seedance-2-5-260628')],null,'官方协议');
add('official unreviewed model fails closed','buildSubmitRequest',[official({},'future-official')],null,'适用性');
add('official submit persists protocol for polling','parseSubmitResponse',[official(),{body:{id:'private_A/B'}}],{taskId:'private_A/B',taskData:{id:'private_A/B'},state:{protocolTemplate:officialID}});
const officialQuery={...ctx(),state:{protocolTemplate:officialID},taskId:'private_A/B'};
add('official poll recovers protocol without request body','buildQueryRequest',[officialQuery],{url:'https://supplier.example/api/v3/contents/generations/tasks/private_A%2FB',method:'GET',headers:{Authorization:'Bearer fixture-only',Accept:'application/json'}});
add('official queued state','parseTaskResult',[officialQuery,{status:'queued'}],{status:'QUEUED',progress:'0%'});
add('official processing state','parseTaskResult',[officialQuery,{status:'processing'}],{status:'IN_PROGRESS',progress:'0%'});
const officialSuccess={status:'succeeded',content:{video_url:'https://cdn.example/v.mp4',last_frame_url:image},usage:{total_tokens:1000,completion_tokens:900}};
add('official completion URL','parseTaskResult',[officialQuery,officialSuccess],{status:'SUCCESS',progress:'100%',url:'https://cdn.example/v.mp4'});
add('official missing artifact cannot become successful','parseTaskResult',[officialQuery,{status:'succeeded',content:{}}],{status:'UNKNOWN',reason:'官方协议成功响应缺少有效视频 URL'});
add('official failure is a terminal failure','parseTaskResult',[officialQuery,{status:'failed',error:{message:'invalid_resolution'}}],{status:'FAILURE',progress:'100%',reason:'invalid_resolution'});
add('official HTTP 200 error does not retry','parseSubmitResponse',[official(),{body:{error:{code:'bad',message:'invalid_resolution'}}}],{taskId:'task_public',taskData:{error:{code:'bad',message:'invalid_resolution'}},immediate:{status:'FAILURE',progress:'100%',reason:'invalid_resolution'}});
add('official draft rejects non-480p','buildSubmitRequest',[official({draft:true})],null,'480p');
add('official draft accepts explicit 480p','buildSubmitRequest',[official({draft:true,resolution:'480p'})],officialDescriptor({draft:true,resolution:'480p'}));
add('official missing ID is uncertain','parseSubmitResponse',[official(),{body:{}}],null,'task.id');
add('official token reservation uses documented omitted duration','extractUsage',[official()],{tokens:86400,resolution:'720p',video_input:'none'});
add('official ratio changes reservation','extractUsage',[official({seconds:6,aspect_ratio:'1:1'})],{tokens:72900,resolution:'720p',video_input:'none'});
add('official reference estimate includes all media classes','extractUsage',[official({seconds:4,images:[image],videos:['https://media.example/v.mp4'],audios:['https://media.example/a.wav']})],{tokens:199800,resolution:'720p',video_input:'video'});
add('official total tokens settle instead of completion tokens','extractUsageOnComplete',[officialQuery,{status:'SUCCESS'},officialSuccess],{tokens:1000});
for(const value of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'1000',null]) add('official invalid actual usage keeps reservation '+value,'extractUsageOnComplete',[officialQuery,{status:'SUCCESS'},{status:'succeeded',usage:{total_tokens:value,completion_tokens:1}}],{});
add('official failure cannot settle usage','extractUsageOnComplete',[officialQuery,{status:'FAILURE'},officialSuccess],{});
add('official content is credentialless','buildContentRequest',[{...officialQuery,status:'SUCCESS',artifactKey:'video',data:officialSuccess,clientRequest:{method:'HEAD'}}],{url:'https://cdn.example/v.mp4',method:'HEAD',credentialless:true});
add('official last frame is credentialless','buildContentRequest',[{...officialQuery,status:'SUCCESS',artifactKey:'last_frame',data:officialSuccess}],{url:image,method:'GET',credentialless:true});
add('official exposes last frame only when present','listArtifacts',[{status:'SUCCESS',data:officialSuccess}],[{key:'video',type:'video'},{key:'last_frame',type:'image'}]);
for(const entry of cases) {
  const args=structuredClone(entry.args),before=JSON.stringify(args);
  let fn=plugin[entry.hook];for(const member of entry.path || []) fn=fn[member];
  if(entry.expectedError) assert.throws(()=>fn(...args),new RegExp(entry.expectedError),entry.name);
  else assert.deepEqual(JSON.parse(JSON.stringify(fn(...args))),entry.expected,entry.name);
  assert.equal(JSON.stringify(args),before,entry.name+' must not mutate arguments');
}
assert.deepEqual(Array.from(plugin.meta.models),['seedance-2.5',...Object.keys(plugin.meta.parameterInterfaces[officialID].modelRules)]);
assert.equal(plugin.meta.parameterInterfaces[id].parameters.seconds.definition.default,undefined);
assert.deepEqual(Array.from(plugin.meta.usageSchema.resolution.enum),[...new Set(Object.values(plugin.meta.parameterInterfaces[id].modelRules).flatMap(rule=>Array.from(rule.parameters.resolution.enum)))]);
assert.equal(crypto.createHash('sha256').update(source).digest('hex'),JSON.parse(fs.readFileSync(new URL('./dist/manifest.json',import.meta.url))).sha256);
fs.writeFileSync(new URL('./fixture.json',import.meta.url),JSON.stringify({cases},null,2)+'\n');
// Exercise the actual generator against both checkout line endings, including
// source hashes, catalog projection and compiled plugin bytes.
const tempBase=fileURLToPath(new URL('../../.tmp/',import.meta.url));
fs.mkdirSync(tempBase,{recursive:true});
const temp=fs.mkdtempSync(path.join(tempBase,'fenglang-repro-'));
assert.equal(path.dirname(temp),path.resolve(tempBase));
try {
  const outputs=[];
  for(const newline of ['\n','\r\n']) {
    const root=path.join(temp,newline==='\n'?'lf':'crlf');
    const provider=path.join(root,'plugin-sources/fenglang-video');
    fs.mkdirSync(path.join(provider,'evidence'),{recursive:true});
    fs.mkdirSync(path.join(provider,'dist'),{recursive:true});
    fs.mkdirSync(path.join(root,'pkg/modelconfig'),{recursive:true});
    for(const name of ['build.mjs','plugin.js','official.js','official-contract.mjs','evidence/discovery-20261102-models.js.txt','evidence/openapi.js.txt','evidence/models.js.txt','evidence/official-20261102-official.html.txt','evidence/official-20261102-models.js.txt','evidence/official-20261102-openapi.js.txt','evidence/ark-create-20261102.md.txt']) {
      const value=fs.readFileSync(new URL(name,import.meta.url),'utf8').replace(/\r\n/g,'\n').replace(/\n/g,newline);
      fs.writeFileSync(path.join(provider,name),value);
    }
    execFileSync(process.execPath,[path.join(provider,'build.mjs'),'--sync-catalog'],{stdio:'pipe'});
    execFileSync(process.execPath,[path.join(provider,'build.mjs'),'--check'],{stdio:'pipe'});
    outputs.push(['dist/fenglang_video.plugin.js','dist/manifest.json','sources.lock.json','../../pkg/modelconfig/fenglang_video.catalog.json'].map(name=>fs.readFileSync(path.join(provider,name),'utf8')));
  }
  assert.deepEqual(outputs[0],outputs[1],'LF and CRLF checkouts must produce identical plugin, hashes and catalog');
} finally {
  fs.rmSync(temp,{recursive:true,force:true});
}
assert.equal(fs.existsSync(temp),false);
console.log('Fenglang offline regression: '+cases.length+'/'+cases.length+' passed; LF/CRLF reproducibility passed; host fixture written');
