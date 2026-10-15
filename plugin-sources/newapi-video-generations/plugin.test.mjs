import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import crypto from 'node:crypto';
import * as plugin from './dist/newapi_video_generations.plugin.js';

const profile=JSON.parse(fs.readFileSync(new URL('./profiles.json',import.meta.url))).newapi_video_generations;
const model='sd2.0-c1';
const ctx=(fields={},name=model)=>({model:name,upstreamModel:name,baseUrl:'https://supplier.example',apiKey:'fixture',...plugin.protocols.openai_video.decodeRequest({model:name,body:{kind:'json',value:{model:name,prompt:'A quiet landscape',seconds:5,...fields}}})});
const refs=(n,type)=>Array.from({length:n},(_,i)=>`https://media.example/${type}-${i}`);

test('exact model claims and source manifest are fixed',()=>{
  assert.deepEqual(plugin.meta.models,['sd2.0-c1','sd2.0-c2','sd2.5-c1']);
  assert.equal(plugin.meta.key,'newapi_video_generations');
  for(const name of plugin.meta.models) assert.equal(profile.models[name].submit,'/v1/video/generations');
  const manifest=JSON.parse(fs.readFileSync(new URL('./dist/manifest.json',import.meta.url)));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(new URL('./dist/newapi_video_generations.plugin.js',import.meta.url))).digest('hex'),manifest.plugins[0].sha256);
});
test('string seconds and explicit ordered multimodal arrays reach the supplier',()=>{
  const fields={seconds:'15',aspect_ratio:'9:16',resolution:'720P',images:refs(9,'image'),videos:refs(3,'video'),audios:refs(3,'audio')};
  const out=plugin.buildSubmitRequest(ctx(fields));
  assert.equal(out.url,'https://supplier.example/v1/video/generations');
  assert.deepEqual(out.body,{model,prompt:'A quiet landscape',seconds:'15',aspect_ratio:'9:16',resolution:'720p',image_urls:fields.images,video_urls:fields.videos,audio_urls:fields.audios});
});
test('all three models enforce independent media and duration boundaries',()=>{
  for(const [name,p] of Object.entries(profile.models)){
    for(const seconds of [p.minSeconds,p.maxSeconds]) assert.equal(plugin.buildSubmitRequest(ctx({seconds},name)).body.seconds,String(seconds));
    for(const seconds of [p.minSeconds-1,p.maxSeconds+1,5.5,'bad',true]) assert.throws(()=>ctx({seconds},name));
    for(const [field,type,limit] of [['images','image',p.maxImages],['videos','video',p.maxVideos],['audios','audio',p.maxAudios]]){
      assert.doesNotThrow(()=>plugin.buildSubmitRequest(ctx({[field]:refs(limit,type)},name)));
      assert.throws(()=>ctx({[field]:refs(limit+1,type)},name),/reference/);
    }
  }
});
test('unsupported capabilities never inherit global video defaults',()=>{
  for(const fields of [{resolution:'1080p'},{generate_audio:true},{first_last_frame:true},{aspect_ratio:'1:1'},{size:'1792x1024'},{seed:1}]) assert.throws(()=>ctx(fields));
  assert.throws(()=>plugin.buildSubmitRequest({...ctx(),upstreamModel:'sd2.5-c2'}),/reviewed catalog/);
  assert.throws(()=>ctx({image_urls:['data:image/png;base64,YQ==']}),/format/);
});
test('per-video count and requested-second facts stay separate and contain no prices',()=>{
  assert.deepEqual(plugin.extractUsage(ctx({seconds:15})),{request_count:1});
  assert.deepEqual(plugin.extractUsage(ctx({seconds:15},'sd2.0-c2')),{seconds:15});
  assert.deepEqual(plugin.extractUsage(ctx({seconds:30},'sd2.5-c1')),{request_count:1});
  assert.deepEqual(plugin.extractUsageOnComplete(ctx(),{status:'SUCCESS'},{seconds:5}),{});
});
test('submit, encoded poll IDs, completion, failure and missing artifacts retain semantics',()=>{
  const task=plugin.parseSubmitResponse(ctx(),{statusCode:200,body:{data:{task_id:'task-1',status:'queued'}}});
  assert.equal(task.taskId,'task-1');
  assert.equal(plugin.buildQueryRequest({...ctx(),taskId:'a/b',state:task.state}).url,'https://supplier.example/v1/video/generations/a%2Fb');
  assert.equal(plugin.parseTaskResult(ctx(),{data:{status:'completed',video_url:'https://media.example/result.mp4'}}).status,'SUCCESS');
  assert.equal(plugin.parseTaskResult(ctx(),{status:'completed'}).status,'UNKNOWN');
  assert.equal(plugin.parseTaskResult(ctx(),{status:'failed',video_url:'https://media.example/stale.mp4'}).status,'FAILURE');
  assert.throws(()=>plugin.parseSubmitResponse(ctx(),{statusCode:503,body:{}}),/503/);
  assert.throws(()=>plugin.parseSubmitResponse(ctx(),{statusCode:200,body:{}}),/task_id_missing/);
});
test('artifact download never includes the channel credential',()=>{
  const data={data:{status:'completed',video_url:'https://cdn.example/result.mp4'}};
  assert.deepEqual(plugin.listArtifacts({status:'SUCCESS',action:'video_generate',data}),[{key:'video',type:'video',mimeType:'video/mp4'}]);
  const out=plugin.buildContentRequest({...ctx(),artifactKey:'video',data});
  assert.equal(out.credentialless,true);assert.equal(out.headers,undefined);assert.equal(out.url,'https://cdn.example/result.mp4');
  assert.deepEqual(plugin.listArtifacts({status:'FAILURE',data}),[]);
});
