"""Endpoint-first parameter contracts. Model examples never create bindings.

Raw source snapshots are data only. No supplier JavaScript is executed.
Legacy model profiles remain solely for existing task/version compatibility.
"""
import ast
import copy
import hashlib
import json
import re
from pathlib import Path
from parameter_contracts import INDEX, OPENAPI, EVIDENCE, resolve, markdown_parameters, yuxi_parameters

ROOT = Path(__file__).resolve().parent
ALIASES = {'duration': 'seconds', 'duration_seconds': 'seconds', 'ratio': 'aspect_ratio', 'aspectRatio': 'aspect_ratio', 'imageSize': 'image_size'}
MEDIA = {
    'images': ['image', 'images', 'image_url', 'image_urls', 'extra_images', 'reference_images', 'reference_image_urls', 'input_reference'],
    'videos': ['videos', 'video_urls', 'extra_videos', 'reference_videos', 'reference_video_urls'],
    'audios': ['audios', 'audio_urls', 'extra_audios', 'reference_audios', 'reference_audio_urls'],
}


def evidence(url):
    item = next(x for x in INDEX if x['url'] == url)
    raw = (EVIDENCE / item['file']).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == item['sha256'], url
    return raw.decode('utf8'), {'url': url, 'sha256': item['sha256'], 'readAt': '2026-10-17', 'status': 'public-documentation'}


def normalized(field):
    paths = {'contents[].parts[].text': 'prompt', 'contents[].parts[].inlineData': 'images', 'generationConfig.imageConfig.imageSize': 'image_size', 'generationConfig.imageConfig.aspectRatio': 'aspect_ratio'}
    if field in paths: return paths[field]
    for name, fields in MEDIA.items():
        if field in fields:
            return name
    return ALIASES.get(field, field)


def capabilities(field, kind):
    if field in ['start_image_url', 'end_image_url', 'first_frame', 'last_frame', 'first_last_frame']:
        return ['first_frame', 'frames'] if field not in ['end_image_url', 'last_frame'] else ['frames']
    name = normalized(field)
    if name == 'images': return ['edit_image'] if kind == 'image' else ['image_video', 'mixed_ref']
    if name == 'videos': return ['video_ref', 'mixed_ref']
    if name == 'audios': return ['audio_ref', 'mixed_ref']
    if field == 'materials': return ['image_video', 'frames', 'video_ref', 'audio_ref', 'mixed_ref']
    return ['base']


def lxm_request_fields(text, model, original):
    """Transcribe documented request branches, not defaults from sample IDs."""
    fields = copy.deepcopy(original); codec = {}
    name = model['name'].lower()
    def names(constant):
        literal = re.search(r'const '+constant+r' = new Set\((\[[^\]]+\])\)', text)
        return set(ast.literal_eval(literal[1]))
    common = {'model': {'type':'string','required':True}, 'prompt': {'type':'string','description':'Vendor requiredness is not explicitly stated in the retained request documentation; choose handling manually'}}
    def video(duration, ratio='aspect_ratio', images='reference_images', videos='reference_videos', audios='reference_audios', size=False):
        result = {**copy.deepcopy(common), duration:{'type':'integer','required':False}, ratio:{'type':'string','required':False}, 'size' if size else 'resolution':{'type':'string','required':False}}
        for field in [images,videos,audios]:
            if field: result[field]={'type':'array','required':False}
        return result
    if name in names('SNUMOM_SEEDANCE_VIDEO_MODELS'):
        fields = video('seconds')
    elif name in names('URL_ONLY_SEEDANCE_MODELS') or name == 'wan3-720':
        prefix = 'reference_' if name == 'wan3-720' else ''
        fields = video('seconds', 'aspect_ratio' if name=='wan3-720' else 'ratio', prefix+'image_urls', prefix+'video_urls', prefix+'audio_urls')
        if name=='seedance2.0-933': fields.pop('resolution',None)
        if name=='wan3-720': fields['audio_durations']={'type':'array','items':{'type':'number','exclusiveMinimum':0},'required':False}
    elif name in names('NATIVE_ASSETS_MODELS'):
        fields = video('duration', 'size', 'reference_images', None, 'reference_audios', size=True)
        codec['assets'] = True
    elif name in names('SNUMOM_GROK_VIDEO_MODELS'):
        fields = video('seconds', images='reference_images', videos=None, audios=None, size=True)
        codec['referenceRole'] = 'first_frame' if name=='grok-imagine-video-1.5-lite' else 'reference_image'
    else:
        seconds = name in ['wan3.0-image','wan3.0-image-prime','wan30-720p','omni-flash-720p','seedance2.5-480v','seedance2.5-720v']
        if seconds:
            fields = {('seconds' if normalized(k)=='seconds' else k):v for k,v in fields.items()}
        if name.startswith('官方h3-') or name in ['wan3.0-image','wan3.0-image-prime']:
            fields.pop('resolution',None);fields.pop('aspect_ratio',None);fields['size']={'type':'string','required':False}
        if name in ['seedance2.5-480v','seedance2.5-720v']:
            fields = {k.removeprefix('reference_') if k.startswith('reference_') else k:v for k,v in fields.items()}
        if name in ['wan3.0-video-p','wan3.0-video-prime-p']: codec['nestedWan'] = True
        if name=='seedance2.5d': codec['camelReferences'] = True
    return fields, codec


def contract(title, kind, submit, query, fields, source, **codec):
    fields = copy.deepcopy(fields)
    if not codec.get('gemini'): fields.setdefault('model', {'type': 'string', 'required': True})
    identifier = 'interface:' + hashlib.sha256((source['url'] + '|' + submit + '|' + kind + '|' + title).encode()).hexdigest()[:16]
    parameters, mapping, wire = {}, {}, {}
    for original, raw in fields.items():
        schema = copy.deepcopy(raw)
        field = original if codec.get('nativeH3') and original == 'image' else normalized(original)
        required = schema.pop('required', None)
        if isinstance(required, list): schema['required'] = required; required = None
        if field == 'model': schema.pop('enum', None); schema.pop('examples', None)
        entry = parameters.setdefault(field, {'definition': {}, 'required': False, 'source': source})
        detail = entry['definition']
        membership = detail.setdefault('x-channel-parameter', {'vendorFields': [], 'capabilities': ['first_frame', 'frames'] if codec.get('nativeH3') and original == 'image' else capabilities(original, kind), 'requiredIn': [], 'status': 'documented'})
        membership['vendorFields'].append(original)
        condition = schema.pop('requiredCondition', None)
        if condition:
            membership['condition'] = condition
            if '图生图' in condition: membership['requiredIn'] = ['edit_image']
            elif '图生视频' in condition: membership['requiredIn'] = ['image_video']
        if required is None: membership['requiredStatus'] = 'manual-verification-required'
        if isinstance(required, bool): entry['required'] |= required
        wire[original] = {'field': field, 'schema': schema, 'required': required is True}
        # Multiple vendor representations are one normalized field, never a
        # second independent duration/reference control or invented wire field.
        if len(membership['vendorFields']) == 1:
            if field in MEDIA:
                schema = {**schema, 'type': 'array', 'items': copy.deepcopy(schema.get('items', {'anyOf': [{'type': 'string'}, {'type': 'object'}]}))}
                schema.pop('oneOf', None)
                schema.pop('anyOf', None)
                schema.pop('format', None)
                if codec.get('nativeH3') and field=='images' and schema['items'].get('type')=='object': schema['items']={'anyOf':[{'type':'string'},schema['items']]}
            if field == 'seconds':
                choices = schema.pop('enum', None)
                schema = {**schema, 'anyOf': [{'type': 'integer'}, {'type': 'string', 'pattern': '^[0-9]+$'}]}
                schema.pop('type', None)
                if choices:
                    membership['documentedEnum'] = choices
                    numeric = [int(v) for v in choices if str(v).isdigit()]
                    schema['anyOf'] = [{'type':'integer','enum':numeric}, {'type':'string','enum':[str(v) for v in numeric]}]
            for key in ['type', 'enum', 'minimum', 'maximum', 'description']:
                if key in schema: entry[key] = copy.deepcopy(schema[key])
            if 'default' in schema: detail['documentedDefault'] = schema.pop('default')
            detail.update(schema)
        if field in ['model', 'client_request_id']:
            entry['required'] = False
            detail['serverGenerated'] = True
            membership['systemGenerated'] = True
        mapping[field] = field
    modes = {'text_image' if kind == 'image' else 'text_video': {'required': []}}
    first = bool(set(fields) & {'start_image_url','first_frame','first_last_frame'}) or codec.get('nativeH3', False) or codec.get('referenceRole')=='first_frame'
    last = bool(set(fields) & {'end_image_url','last_frame','first_last_frame'})
    if 'image_url' in fields and '首帧' in fields['image_url'].get('description',''): first = True
    if (codec.get('framesInImages') or codec.get('frameEncoding') or 'first_last_frame' in fields) and 'images' in parameters:
        first = True; last = True
        if 'images' in parameters: parameters['images']['definition']['x-channel-parameter']['capabilities'] += ['first_frame','frames']
        if codec.get('frameEncoding'): parameters['images']['definition']['x-channel-parameter']['frameEncoding']=copy.deepcopy(codec['frameEncoding'])
    caps = {c for p in parameters.values() for c in p['definition']['x-channel-parameter']['capabilities']}
    for mode in ['edit_image'] if kind == 'image' else ['image_video', 'frames', 'video_ref', 'audio_ref', 'mixed_ref']:
        if mode in caps: modes[mode] = {'required': []}
    if first or last: modes['frames']={'required':[]}
    if submit.endswith('/edits'):
        modes.pop('text_image', None)
        modes['edit_image']={'required':['images']}
        if 'images' in parameters: parameters['images']['definition']['x-channel-parameter']['requiredIn']=['edit_image']
    for mode in modes:
        modes[mode]['required'] = [field for field, parameter in parameters.items() if mode in parameter['definition']['x-channel-parameter']['requiredIn']]
    if kind=='video' and any(parameters.get(field,{}).get('required') for field in ['images','videos','audios']): modes.pop('text_video',None)
    return identifier, {'id': identifier, 'title': title, 'kind': kind, 'method': 'POST', 'path': submit, 'status': 'documented-interface-not-account-verification', 'parameters': parameters, 'mapping': mapping, 'modes': modes, 'source': source, 'capabilities': {'firstFrame': bool(first), 'lastFrame': bool(last), 'multipleReferences': bool(caps - {'base'})}, 'codec': {'submit': submit, 'query': query, 'kind': kind, 'billing': 'unconfirmed', 'documentInterface': True, 'wire': wire, **codec}}


def restricted_rule(entry, changes):
    raw = {name: {**copy.deepcopy(rule['schema']), 'required':rule['required']} for name,rule in entry['codec']['wire'].items()}
    for field, rule in changes.items(): raw.setdefault(field, {}).update(rule)
    codec = {k:copy.deepcopy(v) for k,v in entry['codec'].items() if k not in ['wire','modelRules','documentInterface','kind','query','submit','billing']}
    _, result = contract(entry['title'], entry['kind'], entry['path'], entry['codec']['query'], raw, entry['source'], **codec)
    return {k:result[k] for k in ['parameters','mapping','modes','capabilities','codec']}


def attach_interfaces(providers):
    for data in providers.values(): data['interfaces'] = {}; data['version'] = '2.1.0'
    def add(provider, *args, **kwargs):
        key, value = contract(*args, **kwargs)
        providers[provider]['interfaces'][key] = value
        return value
    # Apifox request schemas/descriptions define independent endpoint contracts.
    for url, document in OPENAPI.items():
        provider = 'paisio_media' if 'y5dprsil1i' in url else 'zhangyuge_media'
        _, source = evidence(url)
        for path, methods in document.get('paths', {}).items():
            op = methods.get('post')
            if not op or ':generateContent' in path: continue  # separate existing Gemini codec below
            schema = {}
            for content in op.get('requestBody', {}).get('content', {}).values():
                candidate = resolve(content.get('schema', {}), document)
                if candidate.get('properties'): schema = candidate; break
            fields = {k: {**resolve(v, document), 'required': k in schema.get('required', [])} for k, v in schema.get('properties', {}).items()}
            for name, rule in markdown_parameters(op.get('description', '')).items(): fields[name] = {**fields.get(name, {}), **rule}
            kind = 'image' if ('images/' in path or any(s in op.get('summary', '') for s in ['香蕉', 'image'])) else 'video'
            if provider == 'paisio_media' and '475784237' in url:
                # The endpoint's prose explicitly documents these fields. quality
                # is restricted to the two named models, not an image baseline.
                fields = {'model': {'type': 'string', 'required': True}, 'prompt': {'type': 'string', 'required': True}, 'image': {'anyOf': [{'type': 'string'}, {'type': 'array', 'items': {'type': 'string'}}], 'required': False}, 'imageSize': {'type': 'string', 'enum': ['1K', '2K', '4K'], 'required': False}, 'aspectRatio': {'type': 'string', 'enum': ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '9:21'], 'required': False}, 'size': {'type': 'string', 'required': False}, 'async': {'type': 'boolean', 'required': False}, 'n': {'type': 'integer', 'required': False}}
            if not fields: continue
            query = '/v1/images/generations/' if kind == 'image' and provider == 'paisio_media' else path.rstrip('/') + '/'
            if path.endswith('/edits'): query = '/v1/images/generations/'
            if provider == 'paisio_media' and '483061436' in url:
                fields['aspect_ratio']['enum'] = ['16:9', '9:16', '1:1', '21:9', '3:4', '4:3']
                fields['prompt']['maxLength'] = 2500
                for f, n in [('extra_images', 9), ('extra_videos', 3), ('extra_audios', 3)]: fields[f]['maxItems'] = n
            entry = add(provider, op.get('summary', path), kind, path, query if kind == 'video' or provider == 'paisio_media' or path == '/v1/videos' else None, fields, source, mainImage=provider == 'paisio_media' and kind == 'video', framesInImages=provider=='zhangyuge_media' and kind=='video' and '首尾帧' in op.get('description',''), uploadFields=['input_reference'] if 'input_reference' in op.get('description', '') else [])
            entry['modelRules'] = {}
            if provider=='paisio_media' and '475784237' in url:
                for name in ['gpt-image2.5-flare','gpt-image2.5-sunburst']:
                    entry['modelRules'][name] = restricted_rule(entry, {'quality':{'type':'string','enum':['low','medium','high','xhigh','max','auto'],'default':'auto','required':False}})
            if provider=='paisio_media' and '483061436' in url:
                for name in ['sd2-fast-pro','sd2-pro']: entry['modelRules'][name] = restricted_rule(entry, {'duration':{'enum':[10,15]}})
                entry['modelRules']['grok-imagine-video-1.5'] = restricted_rule(entry, {'duration':{'minimum':1,'maximum':15},'image_url':{'required':True}})
                entry['modelRules']['grok-imagine-video-1.5']['parameters']['images']['definition']['maxItems']=1
                entry['modelRules']['grok-imagine-video-1.5-fast'] = restricted_rule(entry, {'duration':{'enum':[6,10]}})
                entry['modelRules']['grok-imagine-video-1.5-fast']['parameters']['images']['definition']['maxItems']=7
            if provider=='zhangyuge_media' and 'seconds' in fields:
                # Only explicit request/model table cells declare restrictions;
                # digits embedded in a model name are never parsed as defaults.
                for line in op.get('description','').splitlines():
                    cells=[v.strip() for v in line.strip().strip('|').split('|')]
                    if len(cells)<3 or not cells[0].startswith('`'): continue
                    values=re.findall(r'"(\d+)"', cells[-1])
                    if not values: continue
                    rule={'minimum':int(values[0]),'maximum':int(values[-1])} if re.search(r'[～–~]', cells[-1]) else {'enum':values}
                    for name in re.findall(r'`([^`]+)`',cells[0]): entry['modelRules'][name]=restricted_rule(entry,{'seconds':rule})
            if entry['modelRules']: entry['codec']['modelRules']=entry['modelRules']
    # Yuxi publishes six *interface sections* in its documentation bundle. The
    # section index selects documentation, never a fetched model name.
    url = next(x['url'] for x in INDEX if '63071' in x['url'])
    _, source = evidence(url)
    for index, title in enumerate(['Gemini 图片接口', 'OpenAI 图片接口', '视频接口（官渠请求格式）', '视频接口（Wan 请求格式）', '视频接口（MiniMax 请求格式）', '视频接口（参考素材请求格式）']):
        fields = yuxi_parameters(index)
        if not fields: raise ValueError('Missing Yuxi documentation section '+str(index))
        kind = 'image' if index < 2 else 'video'
        for name, rule in fields.items():
            description = rule.get('description', '')
            if '例如' in description: rule.pop('enum', None)
            if name in ['seconds', 'duration']:
                bounds = re.search(r'(\d+)\s*[–～-]\s*(\d+)\s*秒', description)
                if bounds: rule.update(minimum=int(bounds[1]), maximum=int(bounds[2]))
            if rule.get('type') == 'array':
                limit = re.search(r'最多\s*(\d+)\s*[张个条]', description)
                if limit: rule['maxItems'] = int(limit[1])
            if name == 'size':
                values = re.findall(r'\b\d{3,4}x\d{3,4}\b', description)
                if values: rule['enum'] = list(dict.fromkeys(values))
            if name == 'response_format': rule['enum'] = ['b64_json', 'url']
        path = '/v1beta/models/{model}:generateContent' if index == 0 else '/v1/images/generations' if index == 1 else '/v1/videos'
        add('yuxibox_media', title, kind, path, None if kind == 'image' else '/v1/videos/', fields, source, gemini=index == 0)
    # Keep interface identities and legacy execution intact. Only replace the
    # video documentation with a complete, statically extracted revision.
    from yuxibox_contracts import video_documents, fields_for, EVIDENCE as YUXI_EVIDENCE
    documents, snapshots = video_documents()
    conflicts = json.loads((YUXI_EVIDENCE/'conflicts.json').read_text(encoding='utf8'))
    yuxi = providers['yuxibox_media']
    yuxi['pluginVersion'] = '2.1.4'
    for group, title in zip(['official','wan','minimax','yx'], ['视频接口（官渠请求格式）','视频接口（Wan 请求格式）','视频接口（MiniMax 请求格式）','视频接口（参考素材请求格式）']):
        key = next(k for k,v in yuxi['interfaces'].items() if v['title']==title)
        previous = yuxi['interfaces'][key]
        rules = {}
        for model, document in documents.items():
            if document['kind'] != group: continue
            fields, uploads = fields_for(document)
            unresolved = [c for c in conflicts if c['model']==model]
            # Conflicting duration minima remain evidence, never a newly chosen
            # restriction. Saved operator constraints are not rewritten.
            if any(c['field']=='seconds.minimum' for c in unresolved): fields['seconds'].pop('minimum',None)
            fresh_source = {'url':snapshots[1]['url'], 'sha256':snapshots[1]['sha256'], 'readAt':'2026-10-18','status':'public-documentation','model':model,'snapshots':snapshots}
            _, rule = contract(title, 'video', '/v1/videos', '/v1/videos/', fields, fresh_source, uploadFields=list(uploads), yuxibox={'group':group,'uploads':uploads,'minimumImages':1 if group=='minimax' and any(r['name']=='reference_images' and r['required'] for r in document['rows']) else 0})
            rule['id']=key
            rule['sourceConflicts']=unresolved
            rule['codec']['yuxibox']['conflicts']=unresolved
            rule['codec']['yuxibox']['documentedDefaults']={}
            for field, raw in fields.items():
                description=raw.get('description','')
                default = re.search(r'(?:默认|default[：:]?)\s*(\d+)',description)
                if field=='seconds' and document['registry']: default_value=document['registry']['defaultSeconds']
                elif field=='seconds' and default: default_value=int(default[1])
                else: continue
                rule['parameters'][field]['definition']['documentedDefault']=default_value
                rule['codec']['yuxibox']['documentedDefaults'][field]=default_value
            for upload, detail in uploads.items():
                canonical = 'videos' if detail['kind']=='video' else 'audios' if detail['kind']=='audio' else 'images'
                if canonical in rule['parameters']:
                    metadata=rule['parameters'][canonical]['definition']['x-channel-parameter']
                    metadata.setdefault('uploadAlternatives',{})[upload]=detail
                    if upload not in metadata['vendorFields']: metadata['vendorFields'].append(upload)
            for field, parameter in rule['parameters'].items():
                parameter['definition']['x-channel-parameter']['sourceConflicts']=[c for c in unresolved if c['field'].startswith(field+'.')]
            rules[model]={k:rule[k] for k in ['parameters','mapping','modes','capabilities','codec','source','sourceConflicts']}
        base=copy.deepcopy(next(iter(rules.values())))
        # Unknown model IDs get the documented field shapes without inheriting
        # one example model's bounds or conditional requirements.
        def common_shape(schema):
            if not isinstance(schema,dict): return
            for field in ['minimum','maximum','enum','minItems','maxItems','minLength','maxLength']: schema.pop(field,None)
            for field in ['anyOf','oneOf','allOf']:
                for branch in schema.get(field,[]): common_shape(branch)
        for p in base['parameters'].values():
            common_shape(p);common_shape(p['definition'])
            p['definition'].pop('documentedDefault',None)
        for wire in base['codec']['wire'].values(): common_shape(wire['schema'])
        base['codec']['yuxibox']['minimumImages']=0
        base['codec']['modelRules']=rules
        yuxi['interfaces'][key]={**previous, **base, 'modelRules':rules, 'sourceConflicts':[c for c in conflicts if c['model'] in rules]}
    # XCM's contract has genuinely documented model-specific constraints. Keep
    # them as overrides, while unknown real IDs receive only the common schema.
    url = 'https://xcmapi.org/docs/video-contract.json'
    raw, source = evidence(url); data = json.loads(raw)
    common = {'model': {'type': 'string', 'required': True}, 'prompt': {'type': 'string', 'required': True}, 'client_request_id': {'type': 'string', 'required': True, 'pattern': data['client_request_id']['pattern']}}
    for field, typ in [('duration', 'integer'), ('ratio', 'string'), ('resolution', 'string'), ('images', 'array'), ('videos', 'array'), ('audios', 'array'), ('materials', 'array')]: common[field] = {'type': typ, 'required': False}
    frame_encoding={'roleField':'type','firstRole':'first_frame','lastRole':'end_frame','requiresFirstForLast':True}
    entry = add('xcmapi_media', '视频综合区 JSON 接口', 'video', data['create']['path'], '/v1/videos/', common, source, clientRequestId='publicTaskId', publicReferences=True, referenceMetadata=True, frameEncoding=frame_encoding)
    entry['modelRules'] = {}
    for model in data['models']:
        fields = {}
        for raw in model['parameters']:
            rule = {k: copy.deepcopy(v) for k, v in raw.items() if k not in ['name', 'range', 'default']}
            if rule.get('type') == 'enum':
                rule['type'] = 'string'; rule['enum'] = [v.strip() for v in raw['range'].split(',')]
            elif rule.get('type') == 'integer' and re.fullmatch(r'\d+-\d+', raw.get('range', '')):
                a, b = raw['range'].split('-'); rule.update(minimum=int(a), maximum=int(b))
            if 'default' in raw: rule['default'] = int(raw['default']) if rule.get('type') == 'integer' else raw['default']
            if raw['name'] in ['images', 'videos', 'audios']:
                rule['maxItems'] = model['max_reference_'+{'images':'images','videos':'videos','audios':'audios'}[raw['name']]]
                rule['items'] = {'anyOf': [{'type': 'string'}, {'type': 'object', 'properties': {'url': {'type': 'string'}, 'duration_seconds': {'type': 'number', 'exclusiveMinimum': 0, 'maximum': 120}}, 'required': ['url'] + (['duration_seconds'] if raw['name']=='videos' and model.get('require_video_duration_seconds') else [])}]}
                if raw['name']=='videos' and model.get('require_video_duration_seconds'): rule['items']=rule['items']['anyOf'][1]
            fields[raw['name']] = rule
        _, rule = contract(entry['title'], 'video', entry['path'], '/v1/videos/', fields, source, clientRequestId='publicTaskId', publicReferences=True, referenceMetadata=True, frameEncoding=frame_encoding)
        entry['modelRules'][model['id']] = {k: rule[k] for k in ['parameters', 'mapping', 'modes', 'capabilities', 'codec']}
    entry['codec']['modelRules'] = entry['modelRules']
    _, source = evidence('https://xcmapi.org/docs/QuickStart.html')
    schema = json.loads((ROOT / 'evidence/native-h3-reviewed-schema.json').read_text(encoding='utf8'))['schema']
    fields = {k: {**v, 'required': k in schema['required']} for k, v in schema['properties'].items()}
    add('xcmapi_media', '原生视频 JSON 接口（QuickStart）', 'video', '/v1/videos/generations', '/v1/videos/', fields, source, nativeH3=True, voicePresets=True, voiceChoices=['eve', 'leo'])
    # ArtBox prose, including the text/video/audio reference section, is the
    # source. Recommendations are not promoted to absolute request ceilings.
    raw, source = evidence('https://artbox.top/docs')
    fields = {k: {'type': 'string', 'required': True} for k in ['model', 'prompt', 'seconds']}
    for k in ['image_urls', 'video_urls', 'audio_urls']:
        assert k in raw; fields[k] = {'type': 'array', 'items': {'type': 'string'}, 'required': False}
    for k in ['start_image_url', 'end_image_url']:
        assert k in raw; fields[k] = {'type': 'string', 'required': False}
    assert 'generate_audio' in raw
    fields['generate_audio'] = {'type':'boolean','required':False,'description':'Only the documented 2.5 family supports native generated audio; verify other models manually'}
    for field in ['video_urls','audio_urls']: fields[field]['maxItems']=3
    add('artbox_media', '视频生成接口', 'video', '/v1/video/generations', '/v1/video/generations/', fields, source)
    # Fresh request documentation provides the fields; the public model catalog
    # only supplies explicitly declared per-model limits, never a model preset.
    raw, model_source = evidence('https://lxmone.xyz/api/v1/docs/model-catalog')
    declared = json.loads(raw)['data']['models']
    text, source = evidence('https://lxmone.xyz/docs/assets/catalog.js?v=20261011-task-tabs')
    for kind, path in [('image', '/v1/images/generations'), ('video', '/v1/videos/generations'), ('video', '/v1/videos')]:
        fields = {'model': {'type': 'string', 'required': True}, 'prompt': {'type': 'string', 'description':'Vendor requiredness is not explicitly stated in the request documentation; choose handling manually'}}
        if kind == 'video':
            duration = 'duration_seconds' if path.endswith('generations') else 'duration'
            for field, typ in [(duration, 'integer'), ('resolution', 'string'), ('aspect_ratio', 'string'), ('generate_audio', 'boolean'), ('reference_images', 'array'), ('reference_videos', 'array'), ('reference_audios', 'array')]:
                assert field in text; fields[field] = {'type': typ, 'required': False}
        else:
            _, source = evidence('https://lxmone.xyz/docs')
            fields.update(size={'type': 'string', 'required': False}, n={'type': 'integer', 'required': False}, response_format={'type': 'string', 'required': False}, images={'type': 'array', 'items': {'type': 'string'}, 'maxItems': 3, 'required': False})
        entry = add('lxmone_media', '图片接口' if kind == 'image' else '视频接口 '+path, kind, path, None if kind == 'image' else '/v1/videos/', fields, source, edit='/v1/images/edits' if kind == 'image' else None, uploadFields=['image', 'image[]'] if kind == 'image' else [])
        entry['modelRules'] = {}
        for model in declared:
            if model.get('purpose') != kind: continue
            expected = 'openai-images' if kind == 'image' else 'async-video-generations' if path.endswith('generations') else 'async-video-videos'
            if model.get('protocol_id') != expected: continue
            limits = model.get('capabilities', {})
            specific, model_codec = lxm_request_fields(text, model, fields) if kind=='video' else (copy.deepcopy(fields), {})
            if kind == 'video':
                duration = next(k for k in specific if normalized(k)=='seconds')
                for name, key in [('minimum', 'min_seconds'), ('maximum', 'max_seconds'), ('enum', 'fixed_seconds')]:
                    if key in limits: specific[duration][name] = limits[key]
                if limits.get('resolutions') and 'resolution' in specific: specific['resolution']['enum'] = limits['resolutions']
                if limits.get('aspect_ratios') and 'aspect_ratio' in specific: specific['aspect_ratio']['enum'] = limits['aspect_ratios']
                if not limits.get('audio_output'): specific.pop('generate_audio', None)
                for media in ['images', 'videos', 'audios']:
                    for field in [f for f in specific if normalized(f)==media]:
                        if not limits.get('reference_'+media): specific.pop(field, None)
                        elif limits.get('max_reference_'+media): specific[field]['maxItems'] = limits['max_reference_'+media]
            _, rule = contract(entry['title'], kind, path, '/v1/videos/' if kind=='video' else None, specific, model_source, edit='/v1/images/edits' if kind=='image' else None, **model_codec)
            entry['modelRules'][model['name']] = {k: rule[k] for k in ['parameters', 'mapping', 'modes', 'capabilities', 'codec']}
        entry['codec']['modelRules'] = entry['modelRules']
    for provider in providers.values():
        assert provider['interfaces'], provider['key']
    return providers
