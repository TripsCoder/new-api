import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source=fs.readFileSync(new URL('./dist/apipath_video.plugin.js',import.meta.url),'utf8');
const names=['meta','protocols','buildSubmitRequest','parseSubmitResponse','parseTaskResult','buildQueryRequest','extractUsage','extractUsageOnComplete','listArtifacts','buildContentRequest'];
const plugin=vm.runInNewContext(source.replace(/^export /gm,'')+'\n({'+names.join(',')+'})',{utils:{uuid:()=> 'offline_public_task'}});
const id=Object.keys(plugin.meta.parameterInterfaces)[0], cases=[];
const ctx=(input={},model='seedance-2.5-YZ')=>({model:'client-alias',upstreamModel:model,publicTaskId:'offline_public_task',baseUrl:'https://supplier.example/v1',authHeader:'offline-only',apiKey:'offline-only',requestBody:{operation:'video_generate',protocolTemplate:id,input:{prompt:'Offline fixture',...input},uploads:[]}});
const add=(name,hook,args,expected,expectedError,path)=>cases.push({name,hook,args,...(expectedError?{expectedError}:{expected}),...(path?{path}:{})});
const descriptor=(body,model='seedance-2.5-YZ')=>({url:'https://supplier.example/v1/video/generations',method:'POST',headers:{Authorization:'Bearer offline-only',Accept:'application/json','Content-Type':'application/json'},body:{model,prompt:'Offline fixture',...body}});
add('no undocumented or business defaults','buildSubmitRequest',[ctx()],descriptor({}));
// The host supplies both fields for vendor api_key auth; authHeader can be raw.
// Exercise both request builders, including legacy apiKey-only contexts.
for(const [name,credentials]of [
  ['raw host header',{authHeader:'offline-only',apiKey:'unused-key'}],
  ['complete header',{authHeader:'Bearer offline-only',apiKey:'unused-key'}],
  ['mixed case and outer spaces',{authHeader:'  bEaReR offline-only  ',apiKey:'unused-key'}],
  ['legacy raw key',{authHeader:'',apiKey:'offline-only'}],
  ['legacy complete key',{authHeader:'',apiKey:'Bearer offline-only'}],
]){
  const context={...ctx({},'Seedance2.0-mini-720-GK'),...credentials};
  add('submit auth '+name,'buildSubmitRequest',[context],descriptor({},'Seedance2.0-mini-720-GK'));
  add('poll auth '+name,'buildQueryRequest',[{...context,taskId:'offline_task',state:{protocolTemplate:id,query:'/v1/tasks/'}}],{url:'https://supplier.example/v1/tasks/offline_task',method:'GET',headers:{Authorization:'Bearer offline-only',Accept:'application/json'}});
}
for(const credentials of [
  {authHeader:'',apiKey:''},
  {authHeader:'Bearer ',apiKey:'valid-fallback-must-not-hide-invalid-header'},
  {authHeader:'Bearer Bearer offline-only'},
  {authHeader:'Basic offline-only'},
  {authHeader:'offline-only\r\nX-Injected: yes'},
  {authHeader:'\n',apiKey:'offline-only'},
  {authHeader:'',apiKey:'offline-only\n'},
  {authHeader:'Bearer\toffline-only'},
  {authHeader:'offline-only\u0000'},
]){
  const context={...ctx(),...credentials};
  for(const hook of ['buildSubmitRequest','buildQueryRequest'])add(hook+' rejects invalid auth '+cases.length,hook,[{...context,taskId:'offline_task',state:{protocolTemplate:id,query:'/v1/tasks/'}}],null,'channel API key is missing or invalid');
}
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
const state={protocolTemplate:id,pluginVersion:plugin.meta.version,configurationRevision:0,operation:'video_generate',query:'/v1/tasks/'};
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
const outputEvidence=JSON.parse(fs.readFileSync(new URL('./evidence/video-output-contract.json',import.meta.url),'utf8'));
const observed=outputEvidence.observedResponse.sanitizedSample;
const videoURL='https://cdn.example/video.mp4';
const completed={status:'SUCCESS',progress:'100%',url:videoURL};
const unknown={status:'UNKNOWN',reason:'completed video task has no documented output URL'};
const muse=ctx({},'Muse-Video-720-10S');
add('original Muse completed response retains nested video','parseTaskResult',[muse,observed],completed);
add('wrapped original completed response retains nested video','parseTaskResult',[muse,{data:observed}],completed);
add('observed videos array is usable without video_url','parseTaskResult',[muse,{...observed,output:{videos:[{url:videoURL}]}}],completed);
add('nested video takes precedence over a legacy stale URL','parseTaskResult',[muse,{...observed,url:'https://cdn.example/stale.mp4'}],completed);
add('legacy top-level video_url remains supported','parseTaskResult',[muse,{status:'succeeded',video_url:videoURL}],completed);
for(const status of ['succeeded','completed','success','done']){
  add('nested terminal status '+status,'parseTaskResult',[muse,{...observed,status}],completed);
}
for(const output of [null,{},[],{thumbnail:videoURL},{videos:[]},{video_url:99},{videos:[null,'invalid',{}]}]){
  add('incomplete nested output remains unknown '+JSON.stringify(output),'parseTaskResult',[muse,{...observed,output}],unknown);
  add('incomplete output cannot list artifacts '+JSON.stringify(output),'listArtifacts',[{status:'SUCCESS',action:'video_generate',data:{...observed,output}}],[]);
}
for(const url of ['javascript:alert(1)','data:video/mp4;base64,AA==','file:///video.mp4','https://user:password@cdn.example/video.mp4','https://cdn.example/a b.mp4']){
  const data={...observed,output:{video_url:url,videos:[{url}]}};
  add('unsafe nested result remains unknown '+url,'parseTaskResult',[muse,data],unknown);
  add('unsafe nested result cannot download '+url,'buildContentRequest',[{artifactKey:'video',data}],null,'artifact_not_found');
}
add('invalid first candidate does not hide a valid videos entry','parseTaskResult',[muse,{...observed,output:{video_url:'javascript:invalid',videos:[null,{url:'file:///invalid'},{url:videoURL}]}}],completed);
for(const status of ['failed','error','expired','cancelled','canceled']){
  const data={...observed,status,error:{message:'provider terminal failure'}};
  add('terminal failure with nested stale video '+status,'parseTaskResult',[muse,data],{status:'FAILURE',progress:'100%',reason:'provider terminal failure'});
  add('failed task never lists nested stale video '+status,'listArtifacts',[{status:'FAILURE',action:'video_generate',data}],[]);
}
add('processing never becomes success from a stale nested URL','parseTaskResult',[muse,{...observed,status:'processing',progress:50}],{status:'IN_PROGRESS',progress:'50%'});
add('explicit failure cannot become success from nested output','parseTaskResult',[muse,{...observed,success:false,error:{message:'provider rejected'}}],{status:'FAILURE',progress:'100%',reason:'provider rejected'});
add('immediate successful submission uses nested video','parseSubmitResponse',[muse,{statusCode:200,body:observed}],{taskId:'upstream_task',taskData:{...observed,id:'upstream_task'},state,immediate:completed});
add('success lists nested video artifact','listArtifacts',[{status:'SUCCESS',action:'video_generate',data:observed}],[{key:'video',type:'video',mimeType:'video/mp4'}]);
for(const method of ['GET','HEAD']){
  add('nested content '+method+' keeps credentials out of CDN request','buildContentRequest',[{artifactKey:'video',data:observed,apiKey:'offline-only',authHeader:'Bearer offline-only',clientRequest:{method}}],{url:videoURL,method,credentialless:true});
}
add('nested result renderer exposes URL only','protocols',[{}, {status:'SUCCESS',data:{...observed,authorization:'private'}}],{url:videoURL},null,['openai_video','render']);
add('nested failure renderer does not expose stale video','protocols',[{}, {status:'FAILURE',data:{...observed,error:{message:'provider rejected'}}}],{error:{code:'video_generation_failed',message:'provider rejected'}},null,['openai_video','render']);
add('nested result cost is not invented actual usage','extractUsageOnComplete',[muse,{status:'SUCCESS'},observed],{});
add('previous plugin state queries the original task without resubmitting','buildQueryRequest',[{...muse,taskId:'upstream_task',state:{...state,pluginVersion:'2.1.1'}}],{url:'https://supplier.example/v1/tasks/upstream_task',method:'GET',headers:{Authorization:'Bearer offline-only',Accept:'application/json'}});
for(const item of cases){
  let hook=plugin[item.hook];for(const key of item.path || [])hook=hook[key];
  if(item.expectedError)assert.throws(()=>hook(...item.args),error=>error.message.includes(item.expectedError),item.name);
  else assert.deepEqual(JSON.parse(JSON.stringify(hook(...item.args))),item.expected,item.name);
}
fs.writeFileSync(new URL('./fixture.json',import.meta.url),JSON.stringify({unixNow:1,cases},null,2)+'\n');
console.log('APIPath offline regression: '+cases.length+'/'+cases.length+' passed; host fixture written');
