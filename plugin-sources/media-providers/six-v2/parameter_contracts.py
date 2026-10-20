"""Document parameters for the existing editor; never infer required from defaults."""
from pathlib import Path
import copy
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parent
EVIDENCE = ROOT / 'evidence' / 'parameters-20261017'
INDEX = json.loads((EVIDENCE / 'index.json').read_text(encoding='utf-8'))
OPENAPI = json.loads((EVIDENCE / 'openapi.json').read_text(encoding='utf-8'))
BASE = json.loads((ROOT / 'evidence/public-catalog.json').read_text(encoding='utf-8'))
IMAGE = {'image', 'images', 'image_url', 'image_urls', 'reference_images', 'extra_images', 'mask', 'mask_url', 'input_reference'}
VIDEO = {'videos', 'video_url', 'video_urls', 'reference_videos', 'extra_videos'}
AUDIO = {'audios', 'audio_url', 'audio_urls', 'reference_audios', 'extra_audios', 'audio_durations'}
FRAMES = {'start_image_url', 'end_image_url', 'first_frame', 'last_frame', 'first_last_frame'}
SYSTEM = {'model', 'client_request_id'}


def canonical_url(url):
    return url.split('#')[0].removesuffix('.md').rstrip('/')


def resolve(schema, document, depth=0):
    if depth > 12 or not isinstance(schema, dict):
        return {}
    if '$ref' in schema and schema['$ref'].startswith('#/'):
        value = document
        for part in schema['$ref'][2:].split('/'):
            value = value.get(part, {})
        return resolve(value, document, depth + 1)
    result = copy.deepcopy(schema)
    for branch in result.pop('allOf', []):
        other = resolve(branch, document, depth + 1)
        result.setdefault('properties', {}).update(other.get('properties', {}))
        result.setdefault('required', []).extend(other.get('required', []))
    return result


def markdown_parameters(text):
    """Read request tables only; response tables never define request parameters."""
    result = {}
    headers = []
    request_scope = True
    for line in text.splitlines():
        if line.startswith('#'):
            headers = []
            if re.search(r'响应|返回|查询|计费', line):
                request_scope = False
            elif re.search(r'请求参数|请求体|JSON|参数说明|参数（', line):
                request_scope = True
        if not request_scope or not line.strip().startswith('|'):
            continue
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if any('类型' in c for c in cells) and any('必填' in c for c in cells):
            headers = cells
            continue
        if not headers or len(cells) != len(headers) or set(''.join(cells)) <= {'-', ':', ' '}:
            continue
        name = cells[0].strip('` *')
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name) or name.lower() in {'authorization', 'content_type', 'contenttype'}:
            continue
        typ = cells[next(i for i, h in enumerate(headers) if '类型' in h)].lower().strip('`')
        required = cells[next(i for i, h in enumerate(headers) if '必填' in h)]
        description = cells[-1]
        rule = {'description': description}
        if '[]' in typ or 'array' in typ:
            rule.update(type='array', items={'type': 'string'})
        elif 'bool' in typ:
            rule['type'] = 'boolean'
        elif 'int' in typ:
            rule['type'] = 'integer'
        elif 'number' in typ or 'float' in typ:
            rule['type'] = 'number'
        elif 'object' in typ:
            rule['type'] = 'object'
        else:
            rule['type'] = 'string'
        if required in ['是', '必填', 'true', 'Yes']:
            rule['required'] = True
        elif required in ['否', '可选', 'false', 'No']:
            rule['required'] = False
        else:
            rule['requiredCondition'] = required
        if re.search(r'可选值|取值|枚举', description):
            values = re.findall(r'`([^`]+)`', description)
            values = [v for v in values if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_:.-]*', v)]
            if len(values) > 1:
                rule['enum'] = list(dict.fromkeys(values))
        result[name] = rule
    return result


def yuxi_parameters(name):
    """Extract literal documentation arrays; never execute the downloaded JS."""
    entry = next(e for e in INDEX if '63071' in e['url'])
    text = (EVIDENCE / entry['file']).read_text(encoding='utf-8')
    text = text[text.index('function x(e)'):]
    arrays = []
    for match in list(re.finditer(r'parameters:\[', text))[:6]:
        start = match.end()
        cursor, depth, quote, escaped = start, 1, '', False
        while depth and cursor < len(text):
            char = text[cursor]
            if quote:
                if escaped:
                    escaped = False
                elif char == '\\':
                    escaped = True
                elif char == quote:
                    quote = ''
            elif char in ['"', "'", '`']:
                quote = char
            elif char == '[':
                depth += 1
            elif char == ']':
                depth -= 1
            cursor += 1
        arrays.append(text[start:cursor - 1])
    if isinstance(name, int):
        index = name
        name = ''
    elif name.startswith('nano-banana'):
        index = 0
    elif name in ['gpt-image-2', 'gpt-image-2.5']:
        index = 1
    elif name == 'seedance-2.0（官渠）':
        index = 2
    elif name in ['wan3.0-video', 'wan3.0-video-prime']:
        index = 3
    elif name in ['minimax-h3-fast', 'minimax-h3-quality', 'minimax-h3-15s']:
        index = 4
    elif name.startswith('seedance-'):
        index = 5
    else:
        return {}
    fields = {}
    pattern = r'\{name:("(?:[^"\\]|\\.)*"),type:("(?:[^"\\]|\\.)*"),required:(![01]|true|false),description:("(?:[^"\\]|\\.)*")'
    for match in re.finditer(pattern, arrays[index]):
        field, typ, description = [json.loads(match.group(i)) for i in [1, 2, 4]]
        required = match.group(3) in ['!0', 'true']
        schema = {'type': 'array' if '[]' in typ else 'integer' if typ in ['int', 'integer'] else 'number' if typ == 'number' else 'string', 'description': description, 'required': required}
        if schema['type'] == 'array':
            schema['items'] = {'type': 'string'}
        if field in ['ratio', 'aspect_ratio', 'generationConfig.imageConfig.aspectRatio']:
            choices = re.findall(r'(?<![0-9])[0-9]{1,2}:[0-9]{1,2}|adaptive|auto', description)
            if choices: schema['enum'] = list(dict.fromkeys(choices))
        if field in ['resolution','generationConfig.imageConfig.imageSize']:
            choices = re.findall(r'480[Pp]|720[Pp]|768[Pp]|1080[Pp]|[124]K', description)
            if choices: schema['enum'] = list(dict.fromkeys(choices))
        if field == 'size' and name.startswith('seedance-'):
            choices = re.findall(r'[0-9]{3,4}x[0-9]{3,4}', description)
            if choices: schema['enum'] = list(dict.fromkeys(choices))
        if ' / ' in field:
            for part in field.split(' / '):
                fields[part] = copy.deepcopy(schema)
        else:
            fields[field] = schema
    return fields


def document_fields(provider, name, profile):
    old = BASE['providers'][provider]['models'].get(profile.get('canonicalModel', name), {})
    raw = copy.deepcopy(old.get('parameters', {}))
    url = profile['source'].get('url', '')
    source = copy.deepcopy(profile['source'])
    matched = next((e for e in INDEX if canonical_url(e['url']) == canonical_url(url)), None)
    if matched:
        content = (EVIDENCE / matched['file']).read_bytes()
        assert hashlib.sha256(content).hexdigest() == matched['sha256']
        source.update(url=matched['url'], sha256=matched['sha256'], readAt='2026-10-17', status='public-documentation')
    doc = next((v for u, v in OPENAPI.items() if canonical_url(u) == canonical_url(url)), None)
    if doc:
        for path, methods in doc.get('paths', {}).items():
            if path != profile['submit'] and path != profile.get('edit'):
                continue
            op = methods.get('post', {})
            schema = {}
            for content in op.get('requestBody', {}).get('content', {}).values():
                candidate = resolve(content.get('schema', {}), doc)
                if candidate.get('properties'):
                    schema = candidate
                    break
            if schema.get('properties'):
                raw = {k: {'definition': v, 'type': v.get('type'), 'required': k in schema.get('required', [])} for k, v in schema['properties'].items()}
            for field, rule in markdown_parameters(op.get('description', '')).items():
                raw[field] = {**raw.get(field, {}), **rule}
    if profile.get('nativeH3'):
        schema = json.loads((ROOT / 'evidence/native-h3-reviewed-schema.json').read_text(encoding='utf-8'))['schema']
        raw = {k: {'definition': v, 'type': v.get('type'), 'required': k in schema.get('required', [])} for k, v in schema['properties'].items()}
    if provider == 'yuxibox_media':
        fresh = yuxi_parameters(name)
        if fresh: raw = fresh
    # This exact six-option table is explicit in the retained image endpoint.
    if provider == 'paisio_media' and name in ['gpt-image2.5-flare', 'gpt-image2.5-sunburst']:
        raw['quality'] = {'type': 'string', 'enum': ['low', 'medium', 'high', 'xhigh', 'max', 'auto'], 'default': 'auto', 'required': False}
    return raw, old, source


def attach(providers):
    for provider, data in providers.items():
        for name, p in data['models'].items():
            vendor, old, source = document_fields(provider, name, p)
            fields = {}
            for original, raw in vendor.items():
                if original.lower() in {'authorization', 'content-type'}:
                    continue
                normalized = original
                if original in ['contents', 'generationConfig.responseModalities']:
                    continue  # Protocol containers/constants are generated by the existing adapter.
                paths = {'contents[].parts[].text': 'prompt', 'contents[].parts[].inlineData': 'images', 'generationConfig.imageConfig.imageSize': 'image_size', 'generationConfig.imageConfig.aspectRatio': 'aspect_ratio'}
                if original in paths:
                    normalized = paths[original]
                if original in ['seconds', 'duration', 'duration_seconds']:
                    normalized = 'seconds'
                elif original in ['aspectRatio', 'ratio']:
                    normalized = 'aspect_ratio'
                elif original == 'imageSize':
                    normalized = 'image_size'
                elif original in IMAGE and original not in ['mask', 'mask_url'] and not (p.get('nativeH3') and original == 'image'):
                    normalized = 'images'
                elif original in VIDEO:
                    normalized = 'videos'
                elif original in AUDIO and original != 'audio_durations':
                    normalized = 'audios'
                capabilities = ['base']
                if original in FRAMES or (p.get('nativeH3') and original == 'image'):
                    capabilities = ['first_frame', 'frames'] if original not in ['end_image_url', 'last_frame'] else ['frames']
                elif original in IMAGE:
                    capabilities = ['edit_image'] if p['kind'] == 'image' else ['image_video', 'first_frame', 'frames', 'mixed_ref']
                elif original in VIDEO:
                    capabilities = ['video_ref', 'mixed_ref']
                elif original in AUDIO:
                    capabilities = ['audio_ref', 'mixed_ref']
                elif original == 'materials':
                    capabilities = ['image_video', 'first_frame', 'frames', 'video_ref', 'audio_ref', 'mixed_ref']
                if normalized == 'images' and original in paths:
                    capabilities = ['edit_image']
                schema = copy.deepcopy(raw.get('definition', raw))
                if schema.get('type') == 'enum':
                    schema['x-document-type']='enum';schema['type']='string'
                    if raw.get('enum'):schema['enum']=copy.deepcopy(raw['enum'])
                required = raw.get('required')
                if isinstance(required, bool):
                    schema.pop('required', None) if not isinstance(schema.get('required'), list) else None
                required_in = [mode for mode, value in old.get('modes', {}).items() if original in value.get('required', [])]
                item = fields.setdefault(normalized, {'vendorFields': [], 'capabilities': capabilities, 'schema': schema, 'requiredIn': [], 'source': source, 'status': 'documented'})
                item['vendorFields'].append(original)
                item['requiredIn'] = sorted(set(item['requiredIn'] + required_in))
                if isinstance(required, bool):
                    item['required'] = bool(item.get('required', False) or required)
                else:
                    item.setdefault('requiredStatus', 'manual-verification-required')
                if raw.get('requiredCondition'):
                    item['condition'] = raw['requiredCondition']
                if normalized in SYSTEM:
                    item.update(required=False, systemGenerated=True)
                if provider == 'zhangyuge_media' and '424561006' in p['source']['url'] and normalized == 'image_size' and name != 'nano-banana-2.1':
                    item.update(workflowManaged=True, condition='Resolution is fixed by the model; image_size is selectable only for nano-banana-2.1')
                if original == 'response_format':
                    item.update(workflowManaged=True, condition='The existing asynchronous artifact workflow requests URL results')
            p['parameterContract'] = {'fields': fields, 'source': source, 'status': 'documented-with-explicit-unknowns'}
    return providers
