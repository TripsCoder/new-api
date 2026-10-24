// Supplier-specific combination rules, evaluated after unsupported fields vanish.
function prepareXcmReferences(input, p) {
  const rules=p.xcmReferenceRules, refs={images:[],videos:[],audios:[]};
  const materials=input.materials;
  if(materials!==undefined && !Array.isArray(materials))fail('materials must be an array');
  for(const key of Object.keys(refs)){
    if(input[key]!==undefined && !Array.isArray(input[key]))fail(key+' must be an array');
    refs[key]=input[key] || [];
  }
  if(materials?.length){
    if(Object.values(refs).some(items=>items.length))fail('materials cannot be combined with media arrays');
    input.materials=materials.map(item=>{
      if(!object(item) || !['image','video','audio'].includes(item.type))fail('invalid material type');
      const {type,...reference}=item;
      const normalized=media(reference,type,{...p,httpsOnly:true,referenceMetadata:true});
      refs[type+'s'].push(normalized);
      return {type,...normalized};
    });
  }
  const resolution=input.resolution ?? p.parameterDefinitions.resolution?.definition.documentedDefault;
  const limits={...rules.limits,...rules.byResolution[resolution]};
  let referenceSeconds=0;
  for(const [key,items] of Object.entries(refs)){
    if(items.length>limits[key])fail(key+' exceeds documented reference limit for selected resolution');
    for(const item of items){
      const type=key.slice(0,-1);
      media(item,type,{...p,httpsOnly:true,referenceMetadata:true});
      const required=key==='videos' && rules.requireVideoDuration || key==='audios' && rules.requireAudioDuration;
      if(required && (!object(item) || typeof item.duration_seconds!=='number'))fail(key+' requires duration_seconds');
      if(key!=='images' && object(item))referenceSeconds+=item.duration_seconds || 0;
    }
  }
  if(rules.maxReferenceSeconds!==null && referenceSeconds>rules.maxReferenceSeconds)fail('combined reference duration exceeds documented limit');
  const frames=refs.images.filter(item=>object(item) && ['first_frame','end_frame'].includes(item.type));
  if(frames.length){
    const first=frames.filter(item=>item.type==='first_frame').length,last=frames.filter(item=>item.type==='end_frame').length;
    if(first>1 || last>1 || last && !first)fail('first/end frame combination is invalid');
    if(frames.length!==refs.images.length || refs.videos.length || refs.audios.length)fail('frames cannot be combined with ordinary references');
  }
}
