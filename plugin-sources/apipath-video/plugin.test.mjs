import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source=fs.readFileSync(new URL('./dist/apipath_video.plugin.js',import.meta.url),'utf8');
const names=['meta','protocols','buildSubmitRequest','parseSubmitResponse','parseTaskResult','buildQueryRequest','extractUsage','extractUsageOnComplete','listArtifacts','buildContentRequest'];
const plugin=vm.runInNewContext(source.replace(/^export /gm,'')+'\n({'+names.join(',')+'})',{utils:{uuid:()=> 'offline_public_task'}});
const id=Object.keys(plugin.meta.parameterInterfaces)[0], cases=[];
const ctx=(input={},model='seedance-2.5-YZ')=>({model:'client-alias',upstreamModel:model,publicTaskId:'offline_public_task',baseUrl:'https://supplier.example/v1',apiKey:'offline-only',requestBody:{operation:'video_generate',protocolTemplate:id,input:{prompt:'Offline fixture',...input},uploads:[]}});
const add=(name,hook,args,expected,expectedError,path)=>cases.push({name,hook,args,...(expectedError?{expectedError}:{expected}),...(path?{path}:{})});
const descriptor=(body,model='seedance-2.5-YZ')=>({url:'https://supplier.example/v1/video/generations',method:'POST',headers:{Authorization:'Bearer offline-only',Accept:'application/json','Content-Type':'application/json'},body:{model,prompt:'Offline fixture',...body}});
add('no undocumented or business defaults','buildSubmitRequest',[ctx()],descriptor({}));
add('known values reach canonical JSON wire fields','buildSubmitRequest',[ctx({seconds:5,resolution:'720p',aspect_ratio:'9:16',count:1,orientation:'portrait',size:'720x1280'})],descriptor({duration:5,resolution:'720p',aspect_ratio:'9:16',count:1,orientation:'portrait',size:'720x1280'}));
add('URL references and frames preserve explicit roles and order','buildSubmitRequest',[ctx({images:['https://media.example/a.png?sig=a%2Fb'],videos:['https://media.example/v.mp4'],audios:['https://media.example/a.wav'],start_image_url:'https://media.example/f.png',end_image_url:'https://media.example/l.png'})],descriptor({reference_images:['https://media.example/a.png?sig=a%2Fb'],reference_videos:['https://media.example/v.mp4'],reference_audios:['https://media.example/a.wav'],first_frame:'https://media.example/f.png',last_frame:'https://media.example/l.png'}));
add('documented aliases deduplicate','buildSubmitRequest',[ctx({duration:5,input_reference:['https://media.example/a.png']})],descriptor({duration:5,reference_images:['https://media.example/a.png']}));
add('unknown and unsupported fields never reappear','buildSubmitRequest',[ctx({seed:0,watermark:false,generate_audio:false,metadata:{duration:99999},unknown:'x'})],descriptor({}));
add('model without reference videos filters optional invalid videos','buildSubmitRequest',[ctx({videos:false},'dola2.5')],descriptor({},'dola2.5'));
for(const [model,rule]of Object.entries(plugin.meta.parameterInterfaces[id].modelRules)){
  const p=rule.parameters.seconds;
  for(const seconds of p.enum || [p.minimum,p.maximum])add(model+' duration '+seconds,'buildSubmitRequest',[ctx({seconds},model)],descriptor({duration:seconds},model));
  add(model+' rejects high duration','buildSubmitRequest',[ctx({seconds:p.maximum+1},model)],null,'seconds');
  add(model+' keeps its resolution candidates','buildSubmitRequest',[ctx({resolution:'unsupported'},model)],null,'resolution');
}
for(const seconds of [0,-1,3601,5.5,false,'5s',Number.MAX_SAFE_INTEGER+1])add('unsafe duration '+seconds,'buildSubmitRequest',[ctx({seconds})],null,'seconds');
add('count cannot produce an extra billable video','buildSubmitRequest',[ctx({count:2})],null,'count');
add('blank prompt remains invalid','buildSubmitRequest',[ctx({prompt:' '})],null,'prompt');
add('no file upload invented from URL alias','protocols',[{model:'seedance-2.5-YZ',body:{kind:'multipart',fields:{},files:[]}}],null,'JSON',['openai_video','decodeRequest']);
for(const input of [{images:['data:image/png;base64,YQ==']},{videos:['http://127.0.0.1/a']},{start_image_url:'https://user:password@media.example/a'}])add('invalid public reference '+JSON.stringify(input),'buildSubmitRequest',[ctx(input)],null,'reference');
const unrestricted=ctx({seconds:3,resolution:'8k'});unrestricted.requestBody.unrestrictedValueFields=['seconds','resolution'];
add('saved unrestricted scalar values preserve protocol types','buildSubmitRequest',[unrestricted],descriptor({duration:3,resolution:'8k'}));
add('unrestricted resolution is not an invented pricing category','extractUsage',[unrestricted],{request_count:1,seconds:3});
const unsafe=ctx({seconds:99999});unsafe.requestBody.unrestrictedValueFields=['seconds'];
add('unrestricted duration retains billing safety','buildSubmitRequest',[unsafe],null,'seconds');
const accepted={task_no:'upstream_task',status:'pending',estimated_cost:999,poll_url:'https://evil.example/steal'};
const state={protocolTemplate:id,pluginVersion:'2.1.0',configurationRevision:0,operation:'video_generate',query:'/v1/tasks/'};
add('documented task_no becomes pinned task identity','parseSubmitResponse',[ctx(),{statusCode:200,body:accepted}],{taskId:'upstream_task',taskData:{...accepted,id:'upstream_task'},state});
add('task query never follows response poll_url','buildQueryRequest',[{...ctx(),taskId:'a/b',state}],{url:'https://supplier.example/v1/tasks/a%2Fb',method:'GET',headers:{Authorization:'Bearer offline-only',Accept:'application/json'}});
add('missing task identity is not invented','parseSubmitResponse',[ctx(),{statusCode:200,body:{status:'queued'}}],null,'task_id_missing');
add('conflicting identities are rejected','parseSubmitResponse',[ctx(),{statusCode:200,body:{task_no:'one',id:'two',status:'queued'}}],null,'conflicting');
add('HTTP 200 explicit failure is terminal','parseSubmitResponse',[ctx(),{statusCode:200,body:{error:{message:'duration invalid'},success:false}}],{taskId:'offline_public_task',taskData:{error:{message:'duration invalid'},success:false},state,immediate:{status:'FAILURE',progress:'100%',reason:'duration invalid'}});
for(const [status,result]of [['pending','QUEUED'],['queued','QUEUED'],['processing','IN_PROGRESS'],['running','IN_PROGRESS'],['in_progress','IN_PROGRESS']])add('poll '+status,'parseTaskResult',[ctx(),{status,progress:101}],{status:result,progress:result==='QUEUED'?'0%':'99%'});
add('completed direct URL','parseTaskResult',[ctx(),{status:'completed',url:'https://cdn.example/video.mp4'}],{status:'SUCCESS',progress:'100%',url:'https://cdn.example/video.mp4'});
add('failed result cannot reuse stale URL','parseTaskResult',[ctx(),{status:'failed',error:{message:'bad reference'},url:'https://cdn.example/stale.mp4'}],{status:'FAILURE',progress:'100%',reason:'bad reference'});
add('unknown result stays unknown','parseTaskResult',[ctx(),{status:'new_status'}],{status:'UNKNOWN',reason:'unrecognized upstream status: new_status'});
add('completed without output stays unknown','parseTaskResult',[ctx(),{status:'completed'}],{status:'UNKNOWN',reason:'completed video task has no documented output URL'});
add('unconfigured optional duration supports request-count fact only','extractUsage',[ctx()],{request_count:1});
add('supplied duration and resolution are explicit requested usage','extractUsage',[ctx({seconds:5,resolution:'720p'})],{request_count:1,seconds:5,resolution:'720p'});
add('cost and echoed duration are never actual usage','extractUsageOnComplete',[ctx(),{status:'SUCCESS'},{estimated_cost:100,duration:99}],{});
add('artifact URL never carries supplier credentials','buildContentRequest',[{artifactKey:'video',data:{status:'completed',url:'https://cdn.example/video.mp4'},apiKey:'offline-only'}],{url:'https://cdn.example/video.mp4',method:'GET',credentialless:true});
add('public renderer exposes only the reviewed URL','protocols',[{}, {status:'SUCCESS',data:{task_no:'private',url:'https://cdn.example/video.mp4',authorization:'private'}}],{url:'https://cdn.example/video.mp4'},null,['openai_video','render']);
for(const item of cases){
  let hook=plugin[item.hook];for(const key of item.path || [])hook=hook[key];
  if(item.expectedError)assert.throws(()=>hook(...item.args),error=>error.message.includes(item.expectedError),item.name);
  else assert.deepEqual(JSON.parse(JSON.stringify(hook(...item.args))),item.expected,item.name);
}
fs.writeFileSync(new URL('./fixture.json',import.meta.url),JSON.stringify({unixNow:1,cases},null,2)+'\n');
console.log('APIPath offline regression: '+cases.length+'/'+cases.length+' passed; host fixture written');
