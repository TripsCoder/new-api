"""Build the editor's normalized contract; retain original vendor schemas separately."""
from pathlib import Path
import copy, json, sys
out=Path(__file__).resolve().parent
root=out.parents[2]
original=json.loads((out/'evidence/public-catalog.json').read_text(encoding='utf-8'))
profiles=json.loads((out/'profiles.json').read_text(encoding='utf-8'))
selected = next((arg.split('=',1)[1] for arg in sys.argv if arg.startswith('--provider=')), None)
if selected:
 assert selected in ['yuxibox_media','xcmapi_media']
 catalog=json.loads((root/'pkg/modelconfig/catalog.json').read_text(encoding='utf8'))
 catalog['providers'][selected]['interfaces']=copy.deepcopy(profiles[selected]['interfaces'])
 (root/'pkg/modelconfig/catalog.json').write_bytes((json.dumps(catalog,ensure_ascii=False,indent=2)+'\n').encode())
 print(json.dumps({'provider':selected,'interfaces':len(profiles[selected]['interfaces']),'otherProvidersAndLegacyModelsPreserved':True}))
 sys.exit(0)
paisioCompat=json.loads((out/'evidence/paisio-compatibility-openapi.json').read_text(encoding='utf-8'))
h3Schema=json.loads((out/'evidence/native-h3-reviewed-schema.json').read_text(encoding='utf-8'))['schema']
catalog=copy.deepcopy(original)
for key,provider in profiles.items():
 target=catalog['providers'][key];old=target['models'];models={}
 for name,p in provider['models'].items():
  m=copy.deepcopy(old.get(p.get('canonicalModel',name),{'id':name}));m.update(id=name,kind=p['kind'],status='candidate-not-installed',source=p['source'],priceConfirmed=False)
  m['documentedParameters']=copy.deepcopy(h3Schema['properties']) if p.get('nativeH3') else copy.deepcopy(paisioCompat['submit']['components']['schemas']['VideoRequest']['properties']) if p.get('paisioCompat') else m.get('parameters',{});m['parameters']={};m['modes']={};m['mapping']={}
  params=m['parameters'];mapping=m['mapping']
  def parameter(field,definition):
   raw=copy.deepcopy(m['documentedParameters'].get(field,{}))
   rules=copy.deepcopy(definition)
   # Parameter.required is membership, while an object schema's required array
   # belongs inside the retained JSON Schema definition only.
   if 'required' in rules and not isinstance(rules['required'],bool):rules.pop('required')
   params[field]={**rules,'definition':{**definition,'vendorDefinition':raw.get('definition',raw)},'source':p['source']}
  parameter('prompt',{'type':'string','required':not p.get('promptOptional',False),'minLength':1,**({'maxLength':p['maxPrompt']} if p.get('maxPrompt') else {})})
  if p['kind']=='image':
   m['modes']['text_image']={'required':[]}
   if p.get('edit'):m['modes']['edit_image']={'required':[]}
   if not p.get('omitCount'):parameter('n',{'type':'integer','minimum':1,'maximum':p['nMax'],'default':1})
   if p.get('imageSizes'):
    parameter('image_size',{'type':'string','enum':p['imageSizes']});mapping.update(imageSize='image_size',resolution='image_size')
   if p.get('imageRatios'):parameter('aspect_ratio',{'type':'string','enum':p['imageRatios']});mapping['aspectRatio']='aspect_ratio'
   if p.get('allowAsync'):parameter('async',{'type':'boolean'})
   if p.get('qualities'):parameter('quality',{'type':'string','enum':p['qualities']})
  else:
   if not p.get('minImages') and not p.get('minAudios') and not p.get('firstLastOnly') and not p.get('anyImageOrAudio'):m['modes']['text_video']={'required':[]}
   refs=not p.get('referenceContractPending')
   if refs and p.get('maxImages') and not p.get('firstLastOnly') and not p.get('onlyFirstFrame'):m['modes']['image_video']={'required':[]}
   if refs and (p.get('frames') or p.get('firstLast') or p.get('firstLastOnly') or p.get('onlyFirstFrame') or p.get('mainImage')):m['modes']['frames']={'required':[]}
   if refs and p.get('maxVideos') and not p.get('blockReferenceVideoBilling'):m['modes']['video_ref']={'required':[]}
   if refs and p.get('maxAudios'):m['modes']['audio_ref']={'required':[]}
   if 'video_ref'in m['modes'] and 'audio_ref'in m['modes']:m['modes']['mixed_ref']={'required':[]}
   if p.get('secondsField') or p.get('fixedSeconds'):
    seconds={'anyOf':[{'type':'integer','minimum':p.get('minSeconds',1),'maximum':p.get('maxSeconds',p.get('fixedSeconds',900))},{'type':'string','pattern':'^[0-9]+$'}]}
    if p.get('secondsChoices'):seconds['anyOf'][0]['enum']=p['secondsChoices']
    if p.get('defaultSeconds') is not None:seconds['default']=p['defaultSeconds']
    # Required membership comes from the document contract, never from absence of a default.
    parameter('seconds',seconds);mapping.update(duration='seconds',duration_seconds='seconds')
   if p.get('ratios'):parameter('aspect_ratio',{'type':'string','enum':p['ratios']});mapping['ratio']='aspect_ratio'
   if p.get('resolutions'):parameter('resolution',{'type':'string','enum':p['resolutions']})
   if p.get('audio'):parameter('generate_audio',{'type':'boolean'})
  # Expose only media inputs accepted by the reviewed compiled contract. The
  # runtime still enforces aggregate minima, mutually exclusive representations,
  # upload-only edits and vendor-specific combinations. No UI mode invents a
  # per-field material requirement.
  if not p.get('referenceContractPending'):
   for field,maximum,mediaType in [('images',p.get('maxImages',0),'image'),('videos',p.get('maxVideos',0),'video'),('audios',p.get('maxAudios',0),'audio')]:
    if not maximum or (field=='videos' and p.get('blockReferenceVideoBilling')):continue
    if p['kind']=='image' and (field!='images' or not p.get('edit') or p.get('fileOnlyEdit')):continue
    properties={'url':{'type':'string'},'role':{'type':'string'}}
    if p.get('referenceMetadata'):properties.update(type={'type':'string'},name={'type':'string'},duration_seconds={'type':'number','exclusiveMinimum':0,'maximum':120})
    required=['url']
    if field=='videos' and p.get('requireVideoDuration'):
     properties['duration_seconds']={'type':'number','exclusiveMinimum':0,'maximum':120};required.append('duration_seconds')
    reference={'type':'object','properties':properties,'required':required,'additionalProperties':False}
    item={'anyOf':[{'type':'string'},reference]}
    if field=='videos' and p.get('requireVideoDuration'):item=reference
    if field=='audios' and p.get('voicePresets'):
     voice={'type':'string'}
     if p.get('voiceChoices'):voice['enum']=p['voiceChoices']
     item={'type':'object','properties':{'voice_id':voice},'required':['voice_id'],'additionalProperties':False}
    parameter(field,{'type':'array','items':item,'maxItems':maximum,'description':'Optional normalized references accepted by the reviewed plugin contract; vendor combination constraints are checked by the plugin.'})
    mapping[field]=field
   if p.get('frames'):
    for field in ['start_image_url','end_image_url']:parameter(field,{'type':'string'})
   if p.get('firstLast') or p.get('firstLastOnly'):parameter('first_last_frame',{'type':'boolean'})
   if p.get('audioDurations'):parameter('audio_durations',{'type':'array','items':{'type':'number','exclusiveMinimum':0}})
  if p.get('nativeH3'):
   for field in ['image','last_frame','reference_images','reference_audios']:
    definition=copy.deepcopy(h3Schema['properties'][field])
    if field in ['image','last_frame']:definition={'anyOf':[{'type':'string','format':'uri'},definition]}
    if field=='reference_images':definition['items']={'anyOf':[{'type':'string','format':'uri'},definition['items']]}
    parameter(field,definition)
  m['billingUnit']={'seconds':'second','image_count':'image','request_count':'request'}.get(p.get('billing'),'')
  referenceKnown=not p.get('referenceContractPending')
  m['capabilities']={'firstFrame':referenceKnown and bool(p.get('frames') or p.get('firstLast') or p.get('firstLastOnly') or p.get('onlyFirstFrame') or p.get('mainImage')),'lastFrame':referenceKnown and bool(p.get('frames') or p.get('firstLast') or p.get('firstLastOnly')) and not p.get('onlyFirstFrame',False),'multipleReferences':referenceKnown and not p.get('firstLastOnly',False) and (p.get('maxImages',0)+p.get('maxVideos',0)+p.get('maxAudios',0)>1)}
  # The retained document contract, rather than the common-form whitelist,
  # determines field coverage, required membership and capability ownership.
  contract=p['parameterContract']
  m['documentedParameters']={}
  for field,entry in contract['fields'].items():
   for vendorField in entry['vendorFields']:m['documentedParameters'][vendorField]=copy.deepcopy(entry['schema'])
   if field not in params:parameter(field,entry['schema'])
   current=params[field]
   schema=copy.deepcopy(entry['schema'])
   # Normalized references retain the existing accepted input shape. Their
   # original vendor shape remains separately inspectable, not applied twice.
   reference=field in ['images','videos','audios','reference_images','reference_audios']
   for key in ['type','enum','minimum','maximum','default','description']:
    if key in schema and not (reference and key=='type'):current[key]=copy.deepcopy(schema[key])
   current['required']=entry.get('required',False)
   if entry.get('systemGenerated'):current['required']=False
   detail=current.setdefault('definition',{})
   if not reference:
    detail.update({k:v for k,v in schema.items() if k not in ['required','type','enum','default']})
   if 'enum'in schema:detail['enum']=copy.deepcopy(schema['enum'])
   detail['x-channel-parameter']={k:copy.deepcopy(v)for k,v in entry.items()if k not in ['schema','source']}
   detail.pop('vendorDefinition',None)
   if 'enum'in schema:detail['x-channel-parameter']['documentedEnum']=copy.deepcopy(schema['enum'])
   if field=='seconds':
    # Client inputs accept both numeric seconds and their documented string
    # transport spelling. Vendor wire schemas do not replace that input codec.
    current.pop('type',None);current.pop('enum',None)
    detail.pop('enum',None);detail.pop('pattern',None)
    if schema.get('enum'):
     values=[int(v)for v in schema['enum']if str(v).isdigit()]
     if values:
      detail['anyOf']=[{'type':'integer','enum':values},{'type':'string','enum':[str(v)for v in values]}]
   if entry.get('systemGenerated'):detail['serverGenerated']=True
   current['source']=entry['source']
   mapping.setdefault(field,field)
  m['unconfirmedPluginInputs']={}
  for field,current in list(params.items()):
   if field not in contract['fields'] and field not in ['images','videos','audios','start_image_url','end_image_url','first_last_frame','audio_durations','image','last_frame','reference_images','reference_audios']:
    m['unconfirmedPluginInputs'][field]=copy.deepcopy(current);del params[field];mapping.pop(field,None);continue
   if 'x-channel-parameter'not in current.get('definition',{}):
    capabilities=['base']
    if field=='images':capabilities=['edit_image']if p['kind']=='image'else['first_frame','frames','image_video','mixed_ref']
    elif field=='videos':capabilities=['video_ref','mixed_ref']
    elif field=='audios' or field=='audio_durations':capabilities=['audio_ref','mixed_ref']
    elif field in ['start_image_url','first_frame','first_last_frame']:capabilities=['first_frame','frames']
    elif field in ['end_image_url','last_frame']:capabilities=['frames']
    entry={'vendorFields':[],'capabilities':capabilities,'requiredIn':[],'status':'manual-verification-required','source':contract['source'],'schema':{},'requiredStatus':'manual-verification-required'}
    current.setdefault('definition',{})['x-channel-parameter']=entry
    current['required']=False
   current['definition'].pop('vendorDefinition',None)
   description=current['definition'].pop('description',None)
   if description and not current.get('description'):current['description']=description
   entry=current['definition']['x-channel-parameter']
   if field=='images' and p.get('minImages') and not p.get('framesAsReferenceArray'):entry['requiredIn']=list(m['modes'])
   if field=='audios' and p.get('minAudios'):entry['requiredIn']=list(m['modes'])
   if p.get('anyImageOrAudio')and field in ['images','audios']:entry['condition']='At least one image or audio reference is required';entry['requiredAlternatives']=[['images'],['audios']]
   if p.get('framesAsReferenceArray') and field in ['images','start_image_url','end_image_url']:
    entry['requiredIn']=[];entry['requiredAlternatives']=[['images'],['start_image_url','end_image_url']];entry['condition']='Both first and last frames are required; use two images or the two frame fields'
  for mode,definition in m['modes'].items():
   definition['required']=[field for field,rule in params.items()if mode in rule['definition']['x-channel-parameter'].get('requiredIn',[])]
  # Alias spellings are not independent configurable reference parameters.
  for alias,targetField in [('reference_images','images'),('reference_audios','audios')]:
   if alias in params and targetField in params:
    del params[alias];mapping[alias]=targetField
  mapping={key:value for key,value in mapping.items()if value in params or(value.startswith('@')and key in params)}
  m['mapping']=mapping
  m['parameterContractStatus']='source-backed-with-explicit-unknowns' 
  warnings=m.setdefault('warnings',[])
  
  if p.get('compatibilityAlias'):warnings.append('Gateway compatibility name; request model is '+p['canonicalModel']+'. This is not a vendor-declared alias.')
  if p.get('nativeH3'):warnings.append('Independent native h3 protocol: requires current selected-key visibility; not minimax-h3. Preset audio only; reference resolution above 720p remains unverified.')
  warnings.append('Candidate contract; account availability and effective account cost require verification.')
  if p.get('paisioCompat'):warnings.append('Documented compatibility endpoint; no undocumented first/last-frame fields are enabled. Reference prices are not account costs; shared-schema reference ceilings remain a conservative subset.')
  if p.get('modelSpecificLimitsPending'):warnings.append('Shared endpoint rules only; exact model limits remain unverified.')
  models[name]=m
 for name,p in provider['pendingModels'].items():
  m=copy.deepcopy(old.get(name,{'id':name,'kind':'unknown'}));m.update(status='manual-verification-required',parameters={},modes={},mapping={},source=p.get('source',{}));m.setdefault('warnings',[]).append(p['reason']);models[name]=m
 target['models']=models
 target['interfaces']=copy.deepcopy(provider['interfaces'])
 # Legacy entries are retained for old saved bindings, never new presets.
 target['parameterSource']='plugin-interface-contract/v1'
 if key=='paisio_media':target['documents'].append({'id':'paisio-explicit-compat-video-models','title':'Paisio exact seventeen-model compatibility contract','method':'POST','path':'/v1/contents/generations/tasks','schema':{'$ref':'#/components/schemas/VideoRequest'},'components':paisioCompat['submit']['components'],'description':paisioCompat['submit']['components']['schemas']['VideoRequest']['properties']['model']['description'],'source':provider['models']['video-pro-720p']['source']})
 if key=='xcmapi_media':target['documents'].append({'id':'native-h3-current-contract','title':'Native h3 independent protocol (reviewed documented subset)','method':'POST','path':'/v1/videos/generations','schema':copy.deepcopy(h3Schema),'description':'Native h3 is not minimax-h3. Current selected-key visibility is required. Preset voices eve/leo only; no uploaded/custom audio contract. Reference 1080p remains pending.','source':provider['models']['h3']['source']})
(root/'pkg/modelconfig/catalog.json').write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({key:{'models':len(p['models']),'documentedModes':sum(len(m['modes'])for m in p['models'].values())}for key,p in catalog['providers'].items()}))
