// Additive supplier contract. The existing /open/v1 interface stays immutable.
export function officialContract(source, digest) {
  const id = 'interface:' + digest('fenglang_video:POST:/api/v3/contents/generations/tasks').slice(0, 16);
  const parameter = (type, vendorFields, capabilities, description, definition = {}) => ({
    type, required: false, description, source,
    definition: {type, description, 'x-channel-parameter': {vendorFields, capabilities, requiredIn: [], status: 'documented'}, ...definition},
  });
  const parameters = {
    model: {...parameter('string', ['model'], ['base'], '官方协议模型 ID'), required: true},
    prompt: {...parameter('string', ['content[].text'], ['base'], '视频提示词', {minLength: 1}), required: true},
    resolution: {...parameter('string', ['resolution'], ['base'], '输出分辨率'), required: true},
    seconds: parameter('integer', ['duration'], ['base'], '输出视频时长', {minimum: 1, maximum: 3600, default: 4}),
    aspect_ratio: parameter('string', ['ratio'], ['base'], '画面比例', {enum: ['16:9','9:16','1:1','21:9','4:3','3:4'], default: '16:9'}),
    seed: parameter('integer', ['seed'], ['base'], '随机种子'),
    generate_audio: parameter('boolean', ['generate_audio'], ['base'], '生成音频'),
    watermark: parameter('boolean', ['watermark'], ['base'], '添加水印'),
    return_last_frame: parameter('boolean', ['return_last_frame'], ['base'], '返回尾帧'),
    draft: parameter('boolean', ['draft'], ['base'], '生成样片'),
    output_format: parameter('string', ['output_format'], ['base'], '输出格式', {enum: ['mp4','mov']}),
    priority: parameter('integer', ['priority'], ['base'], '执行优先级', {minimum: 0, maximum: 9}),
    start_image_url: parameter('string', ['content[].image_url.url'], ['image_video','frames'], '首帧图片 URL', {format: 'uri'}),
    end_image_url: parameter('string', ['content[].image_url.url'], ['frames'], '尾帧图片 URL', {format: 'uri'}),
    images: parameter('array', ['content[].image_url.url'], ['image_video','mixed_ref','video_ref','audio_ref'], '参考图片 URL 数组', {items: {type: 'string', format: 'uri'}}),
    videos: parameter('array', ['content[].video_url.url'], ['video_ref','mixed_ref'], '参考视频 URL 数组', {items: {type: 'string', format: 'uri'}}),
    audios: parameter('array', ['content[].audio_url.url'], ['audio_ref','mixed_ref'], '参考音频 URL 数组', {items: {type: 'string', format: 'uri'}}),
  };
  const models = [
    ['doubao-seedance-2-0-260128', 15, ['480p','720p','1080p','4k'], [9,3,3]],
    ['doubao-seedance-2-0-fast-260128', 15, ['480p','720p'], [9,3,3]],
    ['doubao-seedance-2-0-mini-260615', 15, ['480p','720p'], [9,3,3]],
    ['doubao-seedance-2-5-260628', 30, ['480p','720p','1080p'], [30,10,10], true],
  ];
  const contract = {
    id, title: 'sd-官key · 官方协议', kind: 'video', method: 'POST', path: '/api/v3/contents/generations/tasks',
    status: 'documented-interface-not-account-verification', source, parameters, modelRules: {},
    mapping: Object.fromEntries(Object.keys(parameters).map(key => [key, key])),
    modes: Object.fromEntries(['text_video','image_video','frames','video_ref','audio_ref','mixed_ref'].map(mode => [mode, {required: []}])),
    capabilities: {firstFrame: true, lastFrame: true, multipleReferences: true},
    pending: [
      'Official protocol models are excluded from /open/v1/pricing; discovery also reads the live supplier video catalog without confirming account access or prices; interface confirmation remains required',
      'Supplier documentation and public UI disagree on discount labels; no cost or selling price is imported',
      'Supplier proxy requires nonempty text and explicit resolution; omitted duration and ratio retain documented supplier defaults without injecting channel defaults',
      'Reference video/audio duration is estimated at five seconds per URL as documented; completion settles on positive safe-integer usage.total_tokens',
      'Draft task continuation, callback and unlisted fields are not implemented; unknown parameters are not forwarded',
      'The proxy documents positive duration and six fixed ratios, unlike Ark adaptive and automatic-duration workflows; edit and extend are not claimed as verified',
      'Reference file dimensions, bytes and duration require supplier media inspection; no paid request has verified model permissions or outputs',
    ],
  };
  for (const [model, maximum, resolutions, counts, advanced] of models) {
    for (const suffix of ['', '-s']) {
      const values = structuredClone(parameters);
      if (!advanced) { delete values.draft; delete values.output_format; }
      Object.assign(values.seconds, {minimum: 4, maximum});
      Object.assign(values.seconds.definition, {minimum: 4, maximum});
      const tiers = suffix ? resolutions.filter(tier => ['720p','1080p'].includes(tier)) : resolutions;
      values.resolution.enum = tiers;
      values.resolution.definition.enum = tiers;
      for (const [index, key] of ['images','videos','audios'].entries()) values[key].definition.maxItems = counts[index];
      contract.modelRules[model + suffix] = {...contract, parameters: values, modelRules: undefined};
    }
  }
  return contract;
}
