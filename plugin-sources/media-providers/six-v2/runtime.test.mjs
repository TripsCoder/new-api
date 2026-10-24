import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
const profiles=JSON.parse(fs.readFileSync(new URL('./profiles.json',import.meta.url),'utf8'));
function load(key){const source=fs.readFileSync(new URL('./dist/'+key+'.plugin.js',import.meta.url),'utf8');return vm.runInNewContext(source.replace(/^export /gm,'')+'\n({meta,buildSubmitRequest,parseSubmitResponse,buildQueryRequest,parseTaskResult,extractUsage,listArtifacts,buildContentRequest,protocols,native});',{utils:{uuid:()=> 'task_fixture',unixNow:()=>1792094400}},{timeout:1000})}
const context=(model,input={},operation='video_generate')=>({model,upstreamModel:model,baseUrl:'https://provider.invalid',apiKey:'isolated-test-only',publicTaskId:'task_six_provider_fixture_00001',requestBody:{operation,input:{model,prompt:'Fixture only',...input},uploads:[]},files:[]});
const plain=value=>JSON.parse(JSON.stringify(value));

test('parameter corrections preserve pricing schemas, routes and discovery',()=>{
 const baseline=JSON.parse(fs.readFileSync(new URL('./evidence/parameter-workflow-preservation-20261017.json',import.meta.url),'utf8'));
 for(const [key,expected]of Object.entries(baseline)){
  const {meta}=load(key);
  for(const prior of expected.usageProfiles){const current=plain(meta.usageProfiles.find(p=>p.models[0]===prior.models[0]).schema);const previous=structuredClone(prior.schema);if(profiles[key].models[prior.models[0]].kind==='video'){assert.ok(['480p','720p','1080p'].every(value=>current.resolution.enum.includes(value)));for(const value of previous.resolution?.enum||[])assert.ok(current.resolution.enum.includes(value));delete current.resolution;delete previous.resolution;}assert.deepEqual(current,previous,key+' pricing quantities');}
  assert.deepEqual(plain(meta.routes),expected.routes,key+' routes');assert.deepEqual(plain(meta.modelDiscovery),expected.modelDiscovery,key+' discovery');
 }
});

test('reviewed parameter gaps use the exact supplier definitions without network',()=>{
 const paisio=load('paisio_media');
 for(const quality of ['low','medium','high','xhigh','max','auto'])assert.equal(paisio.buildSubmitRequest(context('gpt-image2.5-flare',{quality},'image_generate')).body.quality,quality);
 const zex=load('zhangyuge_media');
 assert.throws(()=>zex.buildSubmitRequest(context('nano_banana_2',{images:Array(9).fill('https://media.example/ref.png')},'image_generate')),/reference images/);
 assert.throws(()=>zex.buildSubmitRequest(context('nano_banana_2',{prompt:'x'.repeat(10001)},'image_generate')),/prompt/);
 assert.equal(zex.buildSubmitRequest(context('nano_banana_2',{aspect_ratio:'auto'},'image_generate')).body.aspect_ratio,'auto');
 assert.equal(zex.buildSubmitRequest(context('minimax-h3',{seconds:5,aspect_ratio:'16:9',resolution:'720p'})).body.resolution,'720p');
 const lxm=load('lxmone_media');
 for(const model of ['minimax-h3-b','minimax-h3-c','minimax-h3-d','minimax-h3-e'])assert.throws(()=>lxm.buildSubmitRequest(context(model,{seconds:5})),/reference/);
 assert.throws(()=>lxm.buildSubmitRequest(context('sd-2.5',{seconds:8})),/seconds/);
 const h3=lxm.buildSubmitRequest(context('minimax-h3-d',{seconds:5,images:['https://media.example/ref.png'],audios:['https://media.example/ref.mp3']}));assert.equal(h3.body.reference_audios.length,1);
 const yuxi=load('yuxibox_media');
 assert.equal(yuxi.buildSubmitRequest(context('wan3.0-video',{seconds:2,resolution:'1080p',aspect_ratio:'adaptive'})).body.seconds,2);
 assert.equal(yuxi.buildSubmitRequest(context('minimax-h3-fast',{seconds:5,seed:0,images:['https://media.example/ref.png']})).body.seed,0);
 assert.throws(()=>paisio.buildSubmitRequest(context('sd2-720p',{seconds:5,seed:0})),/unsupported field/);
});
test('exactly six final artifacts match their build manifest',()=>{const manifest=JSON.parse(fs.readFileSync(new URL('./dist/manifest.json',import.meta.url),'utf8'));assert.equal(manifest.plugins.length,6);for(const item of manifest.plugins){const source=fs.readFileSync(new URL('./dist/'+item.file,import.meta.url));assert.equal(crypto.createHash('sha256').update(source).digest('hex'),item.sha256);assert.equal(load(item.key).meta.version,['paisio_media','xcmapi_media'].includes(item.key)?'2.1.6':'2.1.5');assert.equal(item.version,['paisio_media','xcmapi_media'].includes(item.key)?'2.1.6':'2.1.5')}});
test('every final artifact model builds declared usage facts without network',()=>{let count=0;for(const [key,provider]of Object.entries(profiles)){const plugin=load(key);for(const [model,p]of Object.entries(provider.models)){const input={};if(p.secondsField||p.fixedSeconds)input.seconds=p.defaultSeconds??p.secondsChoices?.[0]??p.minSeconds;if(p.minImages||p.firstLastOnly)input.images=Array(p.minImages||1).fill('https://media.example.com/ref.png');if(p.minAudios)input.audios=Array(p.minAudios).fill('https://media.example.com/ref.mp3');if(p.anyImageOrAudio&&!input.images&&!input.audios)input.images=['https://media.example.com/ref.png'];const ctx=context(model,input,p.kind==='image'?'image_generate':'video_generate');let request;try{request=plugin.buildSubmitRequest(ctx)}catch(error){throw new Error(key+' '+model+': '+error.message)}assert.ok(request.url.startsWith('https://provider.invalid/'));assert.equal(request.method,'POST');const facts=plugin.extractUsage(ctx);const schema=plugin.meta.usageProfiles.find(profile=>profile.models.some(name=>name.toLowerCase()===(p.canonicalModel||model).toLowerCase())).schema;for(const name of Object.keys(facts))assert.ok(Object.hasOwn(schema,name),key+' '+model+' '+name);count++}}assert.ok(count>190)});
test('Paisio image explicit async false is not forced to async true',()=>{const plugin=load('paisio_media');const ctx=context('gpt-image2-high',{n:1,async:false},'image_generate');assert.equal(plugin.buildSubmitRequest(ctx).body.async,false);ctx.requestBody.input.async=true;assert.equal(plugin.buildSubmitRequest(ctx).body.async,true)});

test('every reviewed Paisio main-image video contract preserves first and extra image order',()=>{
 const plugin=load('paisio_media');let checked=0;
 for(const [name,p]of Object.entries(profiles.paisio_media.models)){
  if(p.kind!=='video'||!p.mainImage)continue;
  for(const count of [0,1,3]){
   if(count<(p.minImages||0)||count>p.maxImages)continue;
   const images=['https://media.example.com/main.png','https://media.example.com/second.png','https://media.example.com/third.png'].slice(0,count);
   const ctx=context(name,{seconds:p.defaultSeconds,images});const before=plain(ctx);
   const body=plain(plugin.buildSubmitRequest(ctx).body);
   assert.equal(body.image_url,images[0],name+' main image');
   assert.equal(typeof body.image_url,count?'string':'undefined',name+' scalar main image');
   if(count>1)assert.deepEqual(body.extra_images,images.slice(1),name+' remaining images');
   else assert.equal(Object.hasOwn(body,'extra_images'),false,name+' no empty extras');
   assert.equal(Object.hasOwn(body,'images'),false,name+' no normalized image field upstream');
   assert.deepEqual(plain(ctx),before,name+' input must remain unchanged');
  }
  checked++;
 }
 assert.equal(checked,18);
});

test('Paisio normalized aliases and explicit main/extras produce the same exact request',()=>{
 const plugin=load('paisio_media');const images=['https://media.example.com/a.png','https://media.example.com/b.png','https://media.example.com/a.png'];
 const prompt='@Image1 @Img1 main; @Image2 @Img2 second; @Image3 @Video1 @Audio1';
 const common={seconds:6,prompt,videos:['https://media.example.com/ref.mp4'],audios:['https://media.example.com/ref.mp3']};
 const expected=plain(plugin.buildSubmitRequest(context('video-pro-720p',{...common,images})).body);
 assert.equal(expected.image_url,images[0]);assert.deepEqual(expected.extra_images,images.slice(1));
 assert.deepEqual(expected.extra_videos,common.videos);assert.deepEqual(expected.extra_audios,common.audios);
 assert.equal(expected.prompt,prompt);assert.equal(expected.videos,undefined);assert.equal(expected.audios,undefined);
 for(const alias of ['images','image','image[]','reference_images','image_urls','reference_image_urls','input_reference','image_url']){
  const body=plain(plugin.buildSubmitRequest(context('video-pro-720p',{...common,[alias]:images})).body);
  assert.deepEqual(body,expected,alias);
 }
 const explicit={...common,image_url:images[0],extra_images:images.slice(1)};
 assert.deepEqual(plain(plugin.buildSubmitRequest(context('video-pro-720p',explicit)).body),expected);
 assert.deepEqual(plain(plugin.buildSubmitRequest(context('video-pro-720p',{...common,images:images.map(url=>({url}))})).body),expected);
 assert.throws(()=>plugin.buildSubmitRequest(context('video-pro-720p',{...common,images,image_url:images[0]})),/conflicts/);
});

test('Paisio multi-image video splitting does not change image edits or other providers',()=>{
 const images=['https://media.example.com/a.png','https://media.example.com/b.png'];
 const edit=plain(load('paisio_media').buildSubmitRequest(context('gpt-image2-high',{images},'image_edit')));
 assert.equal(edit.url,'https://provider.invalid/v1/images/edits');assert.deepEqual(edit.body.image,images);
 assert.equal(edit.body.image_url,undefined);assert.equal(edit.body.extra_images,undefined);
 const video=plain(load('yuxibox_media').buildSubmitRequest(context('wan3.0-video',{seconds:5,images})).body);
 assert.deepEqual(video.image_urls,images);assert.equal(video.image_url,undefined);assert.equal(video.extra_images,undefined);
});

test('Paisio decoded standard video input and manually selected templates retain the split',()=>{
 const plugin=load('paisio_media');const images=['https://media.example.com/a.png','https://media.example.com/b.png'];
 const decoded=plugin.protocols.openai_video.decodeRequest({model:'video-pro-720p',body:{kind:'json',value:{model:'video-pro-720p',prompt:'@Image1 @Image2',seconds:6,images}}});
 const ctx={...context('video-pro-720p'),requestBody:decoded.requestBody};
 const body=plain(plugin.buildSubmitRequest(ctx).body);
 assert.equal(body.image_url,images[0]);assert.deepEqual(body.extra_images,[images[1]]);assert.equal(body.prompt,'@Image1 @Image2');
 const manual=context('operator-confirmed-model',{seconds:6,images});manual.requestBody.protocolTemplate='video-pro-720p';
 const manualBody=plain(plugin.buildSubmitRequest(manual).body);
 assert.equal(manualBody.model,'operator-confirmed-model');assert.equal(manualBody.image_url,images[0]);assert.deepEqual(manualBody.extra_images,[images[1]]);
});
test('XCM stable identity and typed reference duration survive serialization',()=>{const plugin=load('xcmapi_media');const ctx=context('minimax-h3',{duration:5,videos:[{url:'https://media.example.com/ref.mp4',duration_seconds:4}]});const request=plugin.buildSubmitRequest(ctx);assert.equal(request.body.client_request_id,ctx.publicTaskId);assert.equal(request.body.videos[0].duration_seconds,4);assert.equal(plugin.buildSubmitRequest(ctx).body.client_request_id,ctx.publicTaskId);ctx.requestBody.input.videos=['https://media.example.com/ref.mp4'];assert.throws(()=>plugin.buildSubmitRequest(ctx),/duration_seconds/);ctx.requestBody.input.videos=[{url:'https://127.0.0.1/ref.mp4',duration_seconds:4}];assert.throws(()=>plugin.buildSubmitRequest(ctx),/public HTTPS/)});
test('LXM exact legacy asset contract keeps category and duration fields',()=>{const request=load('lxmone_media').buildSubmitRequest(context('seedance2.5-720s',{seconds:5,images:['https://media.example.com/ref.png']}));assert.equal(request.body.duration,5);assert.deepEqual(plain(request.body.assets),[{category:'image',url:'https://media.example.com/ref.png'}]);assert.equal(request.body.seconds,undefined)});
test('Zex seconds stay strings and mode-specific duration is enforced',()=>{const plugin=load('zhangyuge_media');const request=plugin.buildSubmitRequest(context('seedance-2.5-10s',{seconds:10}));assert.equal(request.body.seconds,'10');assert.throws(()=>plugin.buildSubmitRequest(context('seedance-2.5-10s',{seconds:15})),/between/)});
test('ArtBox unknown final result field cannot become fake success',()=>{const plugin=load('artbox_media');const ctx=context('Artdance 2.5-720p',{seconds:5});const result=plugin.parseTaskResult(ctx,{status:'completed',url:'https://media.example.com/guessed.mp4'});assert.equal(result.status,'UNKNOWN');assert.deepEqual(plain(plugin.listArtifacts({status:'SUCCESS',action:'video_generate',data:{url:'https://media.example.com/guessed.mp4'}})),[])});
test('new decoder defers strict validation until the host applies the overlay',()=>{const plugin=load('paisio_media');const decoded=plugin.protocols.openai_image.decodeRequest({model:'gpt-image2-high',body:{kind:'json',value:{model:'gpt-image2-high',custom_size:'2K',prompt:'fixture'}}});assert.equal(decoded.requestBody.input.custom_size,'2K');assert.throws(()=>plugin.buildSubmitRequest({...context('gpt-image2-high',{},'image_generate'),requestBody:decoded.requestBody}),/unsupported field/)});

test('native XCM h3 keeps its independent protocol, preset voices and terminal contract',()=>{
 const plugin=load('xcmapi_media');
 const ctx=context('h3',{duration:8,resolution:'720p',reference_images:[{url:'https://media.example.com/person.png'}],reference_audios:[{voice_id:'eve'}]});
 const request=plugin.buildSubmitRequest(ctx);
 assert.equal(request.url,'https://provider.invalid/v1/videos/generations');assert.equal(request.body.model,'h3');assert.equal(request.body.duration,8);
 assert.deepEqual(plain(request.body.reference_images),[{url:'https://media.example.com/person.png'}]);assert.deepEqual(plain(request.body.reference_audios),[{voice_id:'eve'}]);
 assert.equal(request.body.images,undefined);assert.equal(request.body.client_request_id,ctx.publicTaskId);
 const lastOnly=context('h3',{last_frame:{url:'https://media.example.com/end.png'},prompt:undefined});const lastRequest=plugin.buildSubmitRequest(lastOnly);assert.deepEqual(plain(lastRequest.body.last_frame),{url:'https://media.example.com/end.png'});assert.equal(lastRequest.body.prompt,undefined);
 assert.throws(()=>plugin.buildSubmitRequest(context('h3',{reference_audios:['https://media.example.com/custom.mp3']})),/voice_id/);
 assert.throws(()=>plugin.buildSubmitRequest(context('h3',{reference_audios:[{voice_id:'undocumented'}]})),/preset voice/);
 assert.throws(()=>plugin.buildSubmitRequest(context('h3',{images:Array(8).fill('https://media.example.com/ref.png')})),/reference images/);
 assert.throws(()=>plugin.buildSubmitRequest(context('h3',{resolution:'1080p',images:['https://media.example.com/ref.png']})),/not verified/);
 assert.equal(plugin.parseTaskResult(ctx,{status:'completed',video:{url:'https://media.example.com/result.mp4'}}).status,'SUCCESS');
 assert.ok(plugin.buildQueryRequest({...ctx,taskId:'upstream_fixture_task'}).url.endsWith('/v1/videos/upstream_fixture_task'));
});
test('three explicit Zex gateway compatibility names submit canonical documented model IDs',()=>{
 const plugin=load('zhangyuge_media');
 for(const [alias,canonical]of Object.entries({'MiniMax-H3':'minimax-h3','gpt-image-2-2k':'gpt-image-2-2K','gpt-image-2-4k':'gpt-image-2-4K'})){
  const p=profiles.zhangyuge_media.models[alias];assert.equal(p.compatibilityAlias,true);assert.equal(p.canonicalModel,canonical);
  const request=plugin.buildSubmitRequest(context(alias,p.kind==='video'?{seconds:5}:{},p.kind==='video'?'video_generate':'image_generate'));
  assert.equal(request.body.model,canonical);assert.notEqual(request.body.model,alias);
 }
 assert.throws(()=>plugin.buildSubmitRequest(context('MiniMax-h3',{seconds:5})),/interface settings/);
});

test('seventeen Paisio legacy names use the explicit compatibility contract and published exceptions',()=>{
 const plugin=load('paisio_media');const names=Object.entries(profiles.paisio_media.models).filter(([,p])=>p.paisioCompat);assert.equal(names.length,17);
 for(const [name,p]of names){
  const input={seconds:p.defaultSeconds};if(p.minImages)input.images=['https://media.example.com/first.png'];
  const ctx=context(name,input);const request=plugin.buildSubmitRequest(ctx);
  assert.equal(request.url,'https://provider.invalid/v1/contents/generations/tasks');assert.equal(request.body.model,name);assert.equal(request.body.duration,p.defaultSeconds);
  assert.ok(plugin.buildQueryRequest({...ctx,taskId:'compat_task'}).url.endsWith('/v1/contents/generations/tasks/compat_task'));
  assert.equal(plugin.parseTaskResult(ctx,{status:'completed',video_url:'https://media.example.com/result.mp4'}).status,'SUCCESS');
  assert.throws(()=>plugin.buildSubmitRequest(context(name,{...input,start_image_url:'https://media.example.com/first.png'})),/frame fields are unsupported/);
 }
 assert.throws(()=>plugin.buildSubmitRequest(context('grok-imagine-video-1.5',{seconds:6})),/reference images/);
 assert.throws(()=>plugin.buildSubmitRequest(context('grok-imagine-video-1.5-fast',{seconds:8})),/seconds/);
 assert.throws(()=>plugin.buildSubmitRequest(context('sd2-pro',{seconds:6})),/seconds/);
 assert.throws(()=>plugin.buildSubmitRequest(context('grok-imagine-video-1.5',{seconds:6,images:['https://media.example.com/a.png','https://media.example.com/b.png']})),/reference images/);
 assert.equal(plugin.extractUsage(context('video-pro-720p',{seconds:8})).seconds,8);
 assert.equal(plugin.extractUsage(context('seedance-2',{seconds:8})).request_count,1);
});

test('manual unknown IDs use only selected compiled contracts and pin polling across config changes',()=>{
 const key='xcmapi_media',plugin=load(key);
 const [template,p]=Object.entries(profiles[key].models).find(([,p])=>p.kind==='video' && p.defaultSeconds && !p.minImages && p.query);
 assert.ok(template); const ctx=context('future-video-model',{seconds:p.defaultSeconds});
 assert.throws(()=>plugin.buildSubmitRequest(ctx),/interface settings/);
 ctx.requestBody.protocolTemplate=template;
 const request=plugin.buildSubmitRequest(ctx);assert.equal(request.body.model,'future-video-model');
 const accepted=plugin.parseSubmitResponse(ctx,{statusCode:200,body:{id:'upstream_future',status:'queued'}});
 assert.equal(accepted.state.protocolTemplate,template);
 const poll={model:'future-video-model',upstreamModel:'future-video-model',taskId:'upstream_future',state:accepted.state,baseUrl:'https://provider.invalid',apiKey:'isolated'};
 assert.ok(plugin.buildQueryRequest(poll).url.endsWith(p.query+'upstream_future'));
 assert.equal(plugin.parseTaskResult(poll,{status:'completed',video_url:'https://media.example.com/result.mp4'}).status,'SUCCESS');
 ctx.requestBody.protocolTemplate='not-a-template';assert.throws(()=>plugin.buildSubmitRequest(ctx),/unknown protocol template/);
 const decoded=plugin.protocols.openai_video.decodeRequest({model:'future-video-model',body:{kind:'json',value:{model:'future-video-model',prompt:'test',protocolTemplate:template}}});
 assert.equal(decoded.requestBody.protocolTemplate,undefined);
});

test('all six artifacts retain explicit discovery declarations with truthful evidence status',()=>{for(const key of Object.keys(profiles)){const d=load(key).meta.modelDiscovery;assert.equal(d.path,'/v1/models');assert.equal(d.format,'openai');if(key==='artbox_media'){assert.equal(d.sourceStatus,'standard_unverified');assert.equal(d.sourceSha256,undefined)}else{assert.match(d.sourceSha256,/^[a-f0-9]{64}$/);assert.ok(d.sourceUrl.startsWith('https://'))}if(['paisio_media','yuxibox_media','xcmapi_media'].includes(key))assert.equal(d.sourceStatus,'historical_declaration')}});

test('XCM pending IDs do not disable confirmed h3 or minimax-h3 contracts',()=>{const p=load('xcmapi_media');for(const name of ['h3','minimax-h3'])assert.ok(p.buildSubmitRequest(context(name,{seconds:5})).url.includes('/v1/'));for(const name of ['gpt-image-2','seedance2.5-pro-G1'])assert.throws(()=>p.buildSubmitRequest(context(name,{seconds:5})),/interface settings/);assert.ok(p.buildSubmitRequest(context('h3',{seconds:5})).url.includes('/v1/videos/generations'))});


test('saved unrestricted values bypass both interface and wire choices while keeping shape and other fields',()=>{
 for(const [key,provider]of Object.entries(profiles)){
  const [id,entry]=Object.entries(provider.interfaces).find(([,p])=>p.kind==='video'&&p.parameters.seconds);
  const plugin=load(key),ctx=context('real-new-ID',{seconds:77,aspect_ratio:'31:17'});ctx.requestBody.protocolTemplate=id;
  const fields=['seconds'];if(entry.parameters.aspect_ratio)fields.push('aspect_ratio');else delete ctx.requestBody.input.aspect_ratio;
  if(entry.parameters.seconds.maximum!==undefined || entry.parameters.aspect_ratio?.enum?.length) assert.throws(()=>plugin.buildSubmitRequest(ctx),/documented|duration|range|shape|candidate/);
  ctx.requestBody.unrestrictedValueFields=fields;
  const request=plugin.buildSubmitRequest(ctx);assert.ok(request.body);assert.equal(JSON.stringify(request).includes('unrestrictedValueFields'),false);
  assert.equal(JSON.stringify(request.body).includes('77'),true,key+' duration preserved');
  if(fields.includes('aspect_ratio'))assert.equal(JSON.stringify(request.body).includes('31:17'),true,key+' ratio preserved');
  ctx.requestBody.input.seconds='5s';assert.throws(()=>plugin.buildSubmitRequest(ctx),/shape|integer|duration/);
 }
});

test('document interfaces ignore absent optional fields before parsing and usage extraction',()=>{
 for(const [key,provider]of Object.entries(profiles)){
  const [id,entry]=Object.entries(provider.interfaces).find(([,p])=>p.kind==='video'&&p.parameters.seconds);
  const plugin=load(key),ctx=context('actual-selected-model',{seconds:6});ctx.requestBody.protocolTemplate=id;
  ctx.requestBody.unrestrictedValueFields=['seconds'];
  const original=plain(ctx),expected=plain(plugin.buildSubmitRequest(ctx));
  const expectedUsage=plain(plugin.extractUsage(ctx));
  ctx.requestBody.input.unknown_other_model_option={nested:'ignored'};
  if(!entry.parameters.resolution)ctx.requestBody.input.resolution='invalid ignored value';
  if(!entry.parameters.generate_audio)ctx.requestBody.input.generate_audio='invalid ignored value';
  const supplied=plain(ctx);
  assert.deepEqual(plain(plugin.buildSubmitRequest(ctx)),expected,key+' ignored fields must not change wire');
  assert.deepEqual(plain(plugin.extractUsage(ctx)),expectedUsage,key+' ignored fields must not change usage');
  assert.deepEqual(plain(ctx),supplied,key+' input must remain unchanged');
  ctx.requestBody.input.seconds='bad';assert.throws(()=>plugin.buildSubmitRequest(ctx),/integer|shape|duration/);
  assert.equal(original.requestBody.input.seconds,6);
 }
});
test('HTTP 200 parameter errors retain supplier message and terminate without resubmission',()=>{
 const plugin=load('paisio_media');const [id]=Object.entries(profiles.paisio_media.interfaces).find(([,p])=>p.kind==='video'&&p.parameters.seconds);const ctx=context('actual-model',{seconds:5});ctx.requestBody.protocolTemplate=id;
 for(const body of [{error:{message:'duration must be 5s'}},{success:false,message:'ratio must be 16:9'},{data:{error:{message:'duration only supports 5 or 10'}}}]){
  const result=plugin.parseSubmitResponse(ctx,{statusCode:200,body});assert.equal(result.immediate.status,'FAILURE');assert.equal(result.immediate.reason,body.error?.message||body.message||body.data.error.message);
 }
});

test('configured video interfaces carry resolution facts without changing supplier fields',()=>{
 const plugin=load('lxmone_media');
 const [id]=Object.entries(profiles.lxmone_media.interfaces).find(([,entry])=>entry.kind==='video' && entry.parameters.resolution);
 for(const resolution of ['480p','720p','1080p']){
  const ctx=context('fresh-video',{seconds:6,resolution});ctx.requestBody.protocolTemplate=id;
  const request=plugin.buildSubmitRequest(ctx);assert.equal(request.body.resolution,resolution);
  assert.deepEqual(plain(plugin.extractUsage(ctx)),{request_count:1,seconds:6,resolution});
 }
 const ctx=context('fresh-video',{seconds:6});ctx.requestBody.protocolTemplate=id;
 assert.equal(Object.hasOwn(plugin.extractUsage(ctx),'resolution'),false);
 const h3id=Object.entries(profiles.lxmone_media.interfaces).find(([,entry])=>entry.modelRules?.['官方h3-720p']?.parameters.size)?.[0];assert.ok(h3id);
 const h3=context('官方h3-720p',{seconds:6,size:'1280x720'});h3.requestBody.protocolTemplate=h3id;
 assert.equal(plugin.extractUsage(h3).resolution,'720p');assert.equal(plugin.buildSubmitRequest(h3).body.size,'1280x720');assert.equal(plugin.buildSubmitRequest(h3).body.resolution,undefined);
 const image=context('fresh-image',{size:'1280x720'},'image_generate');image.requestBody.protocolTemplate=Object.entries(profiles.lxmone_media.interfaces).find(([,entry])=>entry.kind==='image')[0];
 assert.equal(Object.hasOwn(plugin.extractUsage(image),'resolution'),false);
});


test('YuxiBox ten documented models retain templates, model conditions and arbitrary optional subsets',()=>{
 const provider=profiles.yuxibox_media, plugin=load('yuxibox_media');let count=0;
 for(const [id,entry]of Object.entries(provider.interfaces))for(const [model,rule]of Object.entries(entry.modelRules||{})){
  const ctx=context(model,rule.codec.yuxibox.minimumImages?{images:['https://media.example/ref.png']}:{});ctx.requestBody.protocolTemplate=id;
  const request=plain(plugin.buildSubmitRequest(ctx));assert.equal(request.body.model,model);assert.equal(request.body.seconds,undefined,model+' no implicit default');
  for(const [field,parameter]of Object.entries(rule.parameters))assert.equal(JSON.stringify(parameter).includes('${'),false,model+' resolved '+field);
  if(rule.codec.yuxibox.group==='yx'){
   const input={seconds:rule.parameters.seconds.definition.documentedDefault,images:['https://media.example/ref.png'],videos:['https://media.example/ref.mp4'],audios:['https://media.example/ref.wav']};
   ctx.requestBody.input={prompt:'Fixture',...input};const result=plain(plugin.buildSubmitRequest(ctx).body);
   assert.deepEqual(result.reference_images,input.images);assert.deepEqual(result.videos,input.videos);assert.deepEqual(result.audios,input.audios);assert.equal(result.first_frame,undefined);
   ctx.requestBody.input={prompt:'Fixture',videos:input.videos};assert.deepEqual(plain(plugin.buildSubmitRequest(ctx).body.videos),input.videos);
   ctx.requestBody.input={prompt:'Fixture',videos:['data:video/mp4;base64,YQ=='],audios:['data:audio/mpeg;base64,YQ==']};assert.ok(plugin.buildSubmitRequest(ctx).body.videos);
   ctx.requestBody.input={prompt:'Fixture',videos:Array(rule.parameters.videos.definition.maxItems+1).fill(input.videos[0])};assert.throws(()=>plugin.buildSubmitRequest(ctx),/limit/);
  }
  if(model==='seedance-2.5（YX）-按次'){ctx.requestBody.input={prompt:'Fixture',seconds:15};assert.throws(()=>plugin.buildSubmitRequest(ctx),/shape|candidate/);}
  if(model==='seedance-2.5（YX）'||model==='seedance2.5-yx-count'){assert.equal(rule.parameters.seconds.minimum,undefined);assert.ok(rule.sourceConflicts.some(c=>c.field==='seconds.minimum'));}
  if(model==='minimax-h3-15s'){ctx.requestBody.input={prompt:'Fixture',seconds:1};assert.equal(plugin.buildSubmitRequest(ctx).body.seconds,1);}
  count++;
 }
 assert.equal(count,10);
});

test('YuxiBox uploads satisfy conditional images and retain per-kind multipart fields and joint limits',()=>{
 const plugin=load('yuxibox_media');
 const make=(model,input,files)=>{const [id]=Object.entries(profiles.yuxibox_media.interfaces).find(([,entry])=>entry.modelRules?.[model]);const ctx=context(model,input);ctx.requestBody.protocolTemplate=id;ctx.files=files;ctx.requestBody.uploads=files.map(({ref,field})=>({ref,field}));return ctx;};
 const image={ref:'image-ref',field:'input_reference',mimeType:'image/png',filename:'x.png',size:10};
 for(const model of ['minimax-h3-fast','minimax-h3-quality']){
  assert.throws(()=>plugin.buildSubmitRequest(make(model,{},[])),/at least one image/);
  const request=plain(plugin.buildSubmitRequest(make(model,{},[image])));assert.equal(request.bodyType,'multipart');assert.equal(request.parts.find(p=>p.fileRef)?.name,'input_reference');
  assert.ok(plugin.buildSubmitRequest(make(model,{images:['https://media.example/x.png']},[])).body.reference_images);
  assert.throws(()=>plugin.buildSubmitRequest(make(model,{images:Array(9).fill('https://media.example/x.png')},[image])),/combined.*limit/);
 }
 const files=[image,{ref:'video-ref',field:'videos',mimeType:'video/mp4',filename:'x.mp4',size:25*1024*1024},{ref:'audio-ref',field:'audios',mimeType:'audio/wav',filename:'x.wav',size:10}];
 for(const model of ['wan3.0-video','wan3.0-video-prime']){
  const request=plain(plugin.buildSubmitRequest(make(model,{videos:['https://media.example/a.mp4'],audios:['https://media.example/a.wav']},files)));
  assert.deepEqual(request.parts.filter(p=>p.fileRef).map(p=>p.name),['input_reference','videos','audios']);
  assert.equal(JSON.parse(request.parts.find(p=>p.name==='videos'&&p.value).value).length,1);
  assert.throws(()=>plugin.buildSubmitRequest(make(model,{last_frame:'https://media.example/last.png'},[])),/requires first/);
  assert.throws(()=>plugin.buildSubmitRequest(make(model,{first_frame:'https://media.example/first.png',videos:['https://media.example/a.mp4']},[])),/mutually exclusive/);
  assert.throws(()=>plugin.buildSubmitRequest(make(model,{videos:Array(5).fill('https://media.example/a.mp4')},[files[1]])),/combined.*limit/);
 }
 assert.throws(()=>plugin.buildSubmitRequest(make('seedance-2.0（官渠）',{},[image])),/absent/);
});

// Result download regression: no submission and no credentials sent to the CDN.
test('Paisio prefers saved public video URL and preserves authenticated fallback',()=>{
 const plugin=load('paisio_media');
 const ctx={artifactKey:'video',upstreamTaskId:'original',baseUrl:'https://provider.invalid',apiKey:'private',authHeader:'Bearer private',clientRequest:{method:'GET'},data:{video_url:'https://cdn.example/video.mp4'}};
 const direct=plugin.buildContentRequest(ctx);
 assert.deepEqual(plain(direct),{url:'https://cdn.example/video.mp4',method:'GET',credentialless:true});
 assert.equal(plugin.buildContentRequest({...ctx,clientRequest:{method:'HEAD'}}).method,'HEAD');
 const fallback=plugin.buildContentRequest({...ctx,data:{}});
 assert.ok(fallback.url.startsWith('https://provider.invalid/'));
 assert.equal(fallback.credentialless,undefined);
 assert.ok(fallback.headers.Authorization);
});


test('XCM generates transport identity for both document interfaces and legacy video profiles',()=>{
 const plugin=load('xcmapi_media');
 const cases=[{model:'h3'}, {model:'minimax-h3'}, ...Object.keys(profiles.xcmapi_media.interfaces).map(protocolTemplate=>({model:'seedance-2.5-G3-D1',protocolTemplate}))];
 for(const {model,protocolTemplate} of cases){
  const ctx=context(model,{seconds:5,client_request_id:{caller:'cannot override'}});
  if(protocolTemplate)ctx.requestBody.protocolTemplate=protocolTemplate;
  const before=plain(ctx);
  const request=plugin.buildSubmitRequest(ctx);
  assert.equal(request.body.client_request_id,ctx.publicTaskId,model+' '+protocolTemplate);
  assert.deepEqual(plain(ctx),before,'caller input remains unchanged');
  assert.equal(plugin.buildSubmitRequest({...ctx,requestId:'a-new-http-log-id'}).body.client_request_id,ctx.publicTaskId,'rebuild reuses host task identity');
  assert.equal(plugin.buildSubmitRequest({...ctx,publicTaskId:'task_another_order_0000001'}).body.client_request_id,'task_another_order_0000001');
  for(const publicTaskId of [undefined,'short','x'.repeat(129),'task_invalid_request / 00001'])assert.throws(()=>plugin.buildSubmitRequest({...ctx,publicTaskId}),/stable gateway task id|missing: client_request_id/);
  for(const publicTaskId of ['a'.repeat(16),'x'.repeat(128),'task_1234.5678:90-ab'])assert.equal(plugin.buildSubmitRequest({...ctx,publicTaskId}).body.client_request_id,publicTaskId);
  const {client_request_id,...wire}=plain(request.body);assert.ok(wire.model);assert.equal(client_request_id,ctx.publicTaskId);
  assert.equal(Object.hasOwn(plugin.extractUsage(ctx),'client_request_id'),false,'identity is never a billing field');
 }
});

test('XCM request identity is not added to other suppliers or query/download requests',()=>{
 for(const [key,provider] of Object.entries(profiles)){
  if(key==='xcmapi_media')continue;
  const [id]=Object.entries(provider.interfaces).find(([,entry])=>entry.kind==='video'&&entry.parameters.seconds);
  const ctx=context('actual-selected-model',{seconds:6,client_request_id:'caller-owned-value'});ctx.requestBody.protocolTemplate=id;ctx.requestBody.unrestrictedValueFields=['seconds'];
  const request=load(key).buildSubmitRequest(ctx);assert.equal(request.body.client_request_id,undefined,key);
 }
 const plugin=load('xcmapi_media');
 const poll=plugin.buildQueryRequest({model:'h3',upstreamModel:'h3',taskId:'upstream_existing_task',baseUrl:'https://provider.invalid',apiKey:'fixture'});
 assert.equal(poll.method,'GET');assert.equal(poll.body,undefined);
});


test('XCM current execution parameters cover 18 models on both saved interface identities',()=>{
 const provider=profiles.xcmapi_media,plugin=load('xcmapi_media');
 for(const [id,entry] of Object.entries(provider.interfaces)){
  assert.equal(Object.keys(entry.modelRules).length,18);
  assert.ok(!entry.modelRules.seedance2_5);
  for(const [model,rule] of Object.entries(entry.modelRules)){
   const fields=rule.parameters,min=fields.seconds.minimum,max=fields.seconds.maximum;
   const resolution=fields.resolution.enum[0];
   const ctx=context(model,{seconds:min,resolution,aspect_ratio:'16:9'});ctx.requestBody.protocolTemplate=id;
   const request=plugin.buildSubmitRequest(ctx);assert.equal(request.body.model,model);assert.equal(request.body.duration,min);assert.equal(request.body.ratio,'16:9');assert.equal(request.body.client_request_id,ctx.publicTaskId);
   assert.equal(request.body.aspect_ratio,undefined,'known Gway models use their documented wire shape even on the saved native-labelled entry');
   for(const seconds of [min,max])assert.equal(plugin.buildSubmitRequest({...ctx,requestBody:{...ctx.requestBody,input:{...ctx.requestBody.input,seconds}}}).body.duration,seconds);
   for(const seconds of [min-1,max+1])assert.throws(()=>plugin.buildSubmitRequest({...ctx,requestBody:{...ctx.requestBody,input:{...ctx.requestBody.input,seconds}}}),/range|documented/);
   for(const override of [{resolution:'invalid-tier'},{aspect_ratio:'31:17'}])assert.throws(()=>plugin.buildSubmitRequest({...ctx,requestBody:{...ctx.requestBody,input:{...ctx.requestBody.input,...override}}}),/candidate/);
   for(const key of ['images','videos','audios']){
    if(!fields[key]){assert.equal(plugin.buildSubmitRequest({...ctx,requestBody:{...ctx.requestBody,input:{...ctx.requestBody.input,[key]:{ignored:true}}}}).body[key],undefined);continue;}
    const count=fields[key].definition.maxItems;
    const item={url:'https://media.example.com/ref.'+(key==='images'?'png':key==='videos'?'mp4':'mp3'),...(key==='images'?{}:{duration_seconds:1})};
    assert.throws(()=>plugin.buildSubmitRequest({...ctx,requestBody:{...ctx.requestBody,input:{...ctx.requestBody.input,[key]:Array(count+1).fill(item)}}}),/limit/);
   }
  }
 }
 const entry=provider.interfaces['interface:1e862884de01a7c1'];
 assert.deepEqual(plain(entry.modelRules['seedance-2.5-g2-c1'].parameters.resolution.enum),['720p']);
 assert.equal(entry.modelRules['seedance-2.5-g2-c1'].parameters.videos,undefined);
 assert.equal(entry.modelRules['seedance-2.5-G3-D1'].parameters.seconds.maximum,30);
 assert.equal(entry.sourceConflicts[0].field,'resolution');assert.deepEqual(plain(entry.sourceConflicts[0].retained),['2k']);
 assert.ok(entry.referenceOnlyModels.includes('seedance2.5'));
});

test('XCM documented media conditions retain durations, material metadata and reference limits',()=>{
 const plugin=load('xcmapi_media'),id='interface:1e862884de01a7c1';
 const ctx=context('minimax-h3',{seconds:5,resolution:'2k',videos:[{url:'https://media.example.com/video.mp4',duration_seconds:8}],audios:[{url:'https://media.example.com/audio.mp3',duration_seconds:7}]});ctx.requestBody.protocolTemplate=id;
 const before=plain(ctx);assert.equal(plugin.buildSubmitRequest(ctx).body.audios[0].duration_seconds,7);assert.deepEqual(plain(ctx),before);
 const change=input=>({...ctx,requestBody:{...ctx.requestBody,input:{...ctx.requestBody.input,...input}}});
 assert.throws(()=>plugin.buildSubmitRequest(change({audios:[{url:'https://media.example.com/audio.mp3'}]})),/duration_seconds/);
 assert.throws(()=>plugin.buildSubmitRequest(change({audios:[{url:'https://media.example.com/audio.mp3',duration_seconds:8}]})),/combined reference duration/);
 const materials=change({videos:[],audios:[],materials:[{type:'video',url:'https://media.example.com/ref.mp4',duration_seconds:3,name:'reference'}]});
 assert.equal(plugin.buildSubmitRequest(materials).body.materials[0].name,'reference');
 assert.throws(()=>plugin.buildSubmitRequest(change({materials:[{type:'image',url:'https://media.example.com/ref.png'}]})),/cannot be combined/);
 assert.throws(()=>plugin.buildSubmitRequest(change({videos:[],audios:[],materials:[{type:'image',url:'https://127.0.0.1/ref.png'}]})),/public HTTPS/);
 const conditional=context('seedance-2.5-g2-1',{seconds:5,resolution:'480p',videos:[{url:'https://media.example.com/ref.mp4'}]});conditional.requestBody.protocolTemplate=id;
 assert.equal(plugin.buildSubmitRequest(conditional).body.videos.length,1);
 conditional.requestBody.input.resolution='720p';assert.throws(()=>plugin.buildSubmitRequest(conditional),/selected resolution/);
 const frames=context('seedance-2.5-G3-D1',{seconds:5,resolution:'720p',images:[{url:'https://media.example.com/end.png',type:'end_frame'}]});frames.requestBody.protocolTemplate=id;
 assert.throws(()=>plugin.buildSubmitRequest(frames),/frame combination/);
});
