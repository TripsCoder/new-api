"""XCM execution parameters from locked public documents; never create bindings."""
import copy
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def documented_xcm_video(provider, contract):
    folder = ROOT / 'evidence/xcm-video-20261024'
    sources = json.loads((folder / 'sources.json').read_text(encoding='utf8'))
    documents = {}
    for item in sources:
        raw = (folder / item['file']).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == item['sha256']
        if item['file'].endswith('.json'):
            documents[item['file']] = json.loads(raw)
    document, api = documents['video-contract.json'], documents['openapi.json']
    source = next(item for item in sources if item['file'] == 'video-contract.json')
    source = {key: source[key] for key in ['url', 'sha256']}
    source.update(readAt='2026-10-24', status='public-documentation')

    def resolved(value):
        if isinstance(value, list):
            return [resolved(item) for item in value]
        if not isinstance(value, dict):
            return value
        if '$ref' in value:
            return resolved(api['components']['schemas'][value['$ref'].split('/')[-1]])
        result = {key: resolved(item) for key, item in value.items() if key != 'description'}
        if result.get('exclusiveMinimum') is True:
            result['exclusiveMinimum'] = result.pop('minimum', 0)
        return result

    schema = api['components']['schemas']['GwayVideoCreate']
    common = {key: {**resolved(value), 'required': key in schema['required']}
              for key, value in schema['properties'].items() if key != 'aspect_ratio'}
    material = common['materials']['items']['oneOf'][0]
    material['properties']['type']['enum'] = ['image', 'video', 'audio']
    common['materials']['items'] = material
    codec = dict(clientRequestId='publicTaskId', publicReferences=True, referenceMetadata=True,
                 frameEncoding=dict(roleField='type', firstRole='first_frame', lastRole='end_frame', requiresFirstForLast=True))
    _, entry = contract('视频综合区 JSON 接口', 'video', document['create']['path'], '/v1/videos/', common, source, **codec)
    assert entry['id'] == 'interface:1e862884de01a7c1', 'saved interface identity must remain stable'
    rules, conflicts = {}, []
    for model in document['models']:
        if model.get('parameter_status') != 'executable':
            continue
        fields = {}
        for parameter in model['parameters']:
            name = parameter['name']
            field = copy.deepcopy(common[name])
            field['required'] = parameter.get('required', False)
            if 'description' in parameter:
                field['description'] = parameter['description']
            if parameter.get('type') == 'enum':
                field.update(type='string', enum=[item.strip() for item in parameter['range'].split(',')])
            elif parameter.get('type') == 'integer' and '-' in parameter.get('range', ''):
                lower, upper = parameter['range'].split('-')
                field.update(type='integer', minimum=int(lower), maximum=int(upper))
            if 'default' in parameter:
                field['default'] = int(parameter['default']) if field.get('type') == 'integer' else parameter['default']
            if 'max_items' in parameter:
                field['maxItems'] = parameter['max_items']
            if name in ['videos', 'audios'] and model.get('require_' + ('video' if name == 'videos' else 'audio') + '_duration_seconds'):
                item = resolved(api['components']['schemas']['VideoRef' if name == 'videos' else 'AudioRef'])
                item['required'] = ['url', 'duration_seconds']
                field['items'] = item
            fields[name] = field
        if model['id'] == 'minimax-h3' and '768p' in fields['resolution'].get('enum', []) and '2k' in schema['properties']['resolution'].get('description', ''):
            # Conflicting publisher prose/table: keep the prior reviewed value.
            prior = provider['models']['minimax-h3']['resolutions']
            fields['resolution'].update(enum=prior, default=prior[0])
            conflicts.append(dict(model=model['id'], field='resolution', table=['768p'], prose=['2k'], retained=prior, status='publisher-confirmation-required'))
        constraints = dict(limits={key: model['max_reference_' + key] for key in ['images', 'videos', 'audios']},
                           byResolution=model.get('media_limits_by_resolution', {}),
                           requireVideoDuration=model.get('require_video_duration_seconds', False),
                           requireAudioDuration=model.get('require_audio_duration_seconds', False),
                           maxReferenceSeconds=model.get('max_reference_duration_seconds'))
        _, rule = contract(entry['title'], 'video', entry['path'], '/v1/videos/', fields, source,
                           **codec, nativeH3=False, voicePresets=False, xcmReferenceRules=constraints)
        rules[model['id']] = {key: rule[key] for key in ['parameters', 'mapping', 'modes', 'capabilities', 'codec']}
    assert len(rules) == document['parameter_verified_model_count']
    entry['modelRules'] = rules
    entry['sourceConflicts'] = conflicts
    entry['referenceOnlyModels'] = [model['id'] for model in document['models'] if model.get('parameter_status') != 'executable']
    provider['interfaces'][entry['id']] = entry
    return entry
