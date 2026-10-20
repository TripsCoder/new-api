"""Static, fail-closed extraction of YuxiBox's published video request tables.

The restricted expression reader never evaluates JavaScript. Unknown syntax is
an error with its source expression, rather than a silently missing parameter.
"""
import ast
import copy
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EVIDENCE = ROOT / 'evidence' / 'yuxibox-video-20261018'


def split_top(text, separator=','):
    parts, start, stack, quote, escaped = [], 0, [], '', False
    for i, char in enumerate(text):
        if quote:
            if escaped: escaped = False
            elif char == '\\': escaped = True
            elif char == quote: quote = ''
        elif char in '\"\'`': quote = char
        elif char in '[{(': stack.append(char)
        elif char in ']})':
            if not stack: raise ValueError('Unbalanced documentation expression')
            stack.pop()
        elif not stack and text.startswith(separator, i):
            parts.append(text[start:i]); start = i + len(separator)
    if quote or stack: raise ValueError('Unterminated documentation expression')
    parts.append(text[start:])
    return parts


def expression(raw, context):
    raw = raw.strip()
    conditional = split_top(raw, '?')
    if len(conditional) == 2:
        branches = split_top(conditional[1], ':')
        if len(branches) != 2: raise ValueError('Unsupported conditional: '+raw)
        return expression(branches[0] if expression(conditional[0], context) else branches[1], context)
    if len(conditional) != 1: raise ValueError('Unsupported nested conditional: '+raw)
    for operator in ['!==', '===']:
        operands = split_top(raw, operator)
        if len(operands) == 2:
            equal = expression(operands[0], context) == expression(operands[1], context)
            return equal if operator == '===' else not equal
    if raw in ['!0', 'true']: return True
    if raw in ['!1', 'false']: return False
    if re.fullmatch(r'\d+', raw): return int(raw)
    if raw.startswith(('"', "'")) and raw[-1:] == raw[:1]: return ast.literal_eval(raw)
    if raw.startswith('`') and raw.endswith('`'):
        return re.sub(r'\$\{([^{}]+)\}', lambda m: str(expression(m[1], context)), raw[1:-1])
    if re.fullmatch(r'[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*', raw):
        value = context
        for part in raw.split('.'):
            if part not in value: raise ValueError('Unknown documentation variable: '+raw)
            value = value[part]
        return copy.deepcopy(value)
    raise ValueError('Unsupported documentation expression: '+raw)


def arrays(text):
    for match in re.finditer(r'parameters:\[', text):
        start = match.end(); cursor = start; depth = 1; quote = ''; escaped = False
        while depth and cursor < len(text):
            char = text[cursor]
            if quote:
                if escaped: escaped = False
                elif char == '\\': escaped = True
                elif char == quote: quote = ''
            elif char in '\"\'`': quote = char
            elif char == '[': depth += 1
            elif char == ']': depth -= 1
            cursor += 1
        if depth: raise ValueError('Unterminated request parameter table')
        yield text[start:cursor-1]


def table(raw, context):
    result = []
    for item in split_top(raw):
        item = item.strip()
        if not item: continue
        if item in context:
            result.append(copy.deepcopy(context[item])); continue
        if not item.startswith('{') or not item.endswith('}'): raise ValueError('Unsupported parameter: '+item)
        row = {}
        for prop in split_top(item[1:-1]):
            key, sep, value = prop.partition(':')
            if not sep: raise ValueError('Missing parameter property value')
            row[key] = expression(value, context)
        if set(row) != {'name', 'type', 'required', 'description'}: raise ValueError('Unexpected documentation row: '+str(row))
        result.append(row)
    if len({r['name'] for r in result}) != len(result): raise ValueError('Duplicate documentation parameter')
    return result


def snapshots():
    lock = json.loads((EVIDENCE/'sources.json').read_text(encoding='utf8'))
    result = {}
    for item in lock:
        raw = (EVIDENCE/item['file']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != item['sha256']: raise ValueError('Changed documentation snapshot: '+item['file'])
        result[item['file']] = raw.decode('utf8')
    return result, lock


def video_documents():
    source, lock = snapshots()
    registry = {}
    pattern = r'"([^"\n]+)":\{defaultSeconds:(\d+),durationRange:"([^"]+)",images:(\d+),videos:(\d+),audios:(\d+)\}'
    for name, default, duration, images, videos, audios in re.findall(pattern, source['index.js']):
        registry[name] = dict(defaultSeconds=int(default), durationRange=duration, images=int(images), videos=int(videos), audios=int(audios))
    if len(registry) != 4: raise ValueError('YuxiBox document registry changed; review new expressions')
    sections = {}
    for raw in arrays(source['59316.js']):
        if 'name:"reference_images"' not in raw: continue
        kind = 'yx' if '${t.images}' in raw else 'minimax' if 'name:"seed"' in raw else 'wan' if 'name:"media"' in raw else 'official'
        if kind in sections: raise ValueError('Ambiguous video request table: '+kind)
        sections[kind] = raw
    if set(sections) != {'yx', 'minimax', 'wan', 'official'}: raise ValueError('Missing documented video interface')
    groups = {'yx':list(registry), 'official':['seedance-2.0（官渠）'], 'minimax':['minimax-h3-15s','minimax-h3-fast','minimax-h3-quality'], 'wan':['wan3.0-video','wan3.0-video-prime']}
    catalog = json.loads(source['pricing.json'])['data']
    video_ids = {r['model_name'] for r in catalog if set(r.get('supported_endpoint_types',[])) & {'video','openai-video','video-generation'}}
    if video_ids != {m for names in groups.values() for m in names}: raise ValueError('Video catalog changed; review documented model coverage')
    models = {}
    for kind, names in groups.items():
        for name in names:
            context = {'d':name, 'u':'seedance-2.0（官渠）', 'p':{'name':'model','type':'string','required':True,'description':name}, 't':registry.get(name,{})}
            rows = table(sections[kind], context)
            models[name] = {'kind':kind, 'rows':rows, 'registry':registry.get(name,{})}
    return models, lock


def fields_for(document):
    fields, uploads = {}, {}
    for row in document['rows']:
        typ, description = row['type'], row['description']
        schema = {'type':'array' if '[]' in typ else 'integer' if typ == 'integer' else 'string', 'description':description, 'required':row['required']}
        if schema['type'] == 'array': schema['items']={'type':'string' if typ=='string[]' else 'object'}
        if 'file' in typ:
            for name in row['name'].split(' / '):
                uploads[name] = {'kind':'video' if name=='videos' else 'audio' if name=='audios' else 'image', 'type':typ, 'transport':'multipart', 'description':description}
            if typ == 'file': continue
        for name in row['name'].split(' / '):
            rule = copy.deepcopy(schema)
            if name in ['reference_images','input_reference'] and document['kind']=='minimax' and row['required']:
                rule.update(required=False, requiredCondition='At least one image through reference_images OR input_reference upload')
            if name == 'input_reference': continue # upload/string alternative, not a second JSON control
            if name in ['ratio','resolution','size']:
                choices = re.findall(r'(?<![\d:])\d{1,2}:\d{1,2}(?![\d:])|adaptive|auto' if name=='ratio' else r'\b\d{3,4}x\d{3,4}\b' if name=='size' else r'480[Pp]|720[Pp]|768[Pp]|1080[Pp]', description)
                if choices: rule['enum']=list(dict.fromkeys(choices))
            if rule['type']=='array':
                limit = re.search(r'(?:最多|最[多大]|0\s*[–-])\s*(\d+)\s*(?:张|个|条|段|HTTPS)',description)
                if limit: rule['maxItems']=int(limit[1])
            if name=='prompt':
                bounds=re.search(r'(\d+)\s*[–-]\s*(\d+)\s*个字符',description)
                if bounds: rule.update(minLength=int(bounds[1]),maxLength=int(bounds[2]))
            if name=='seconds':
                bounds=re.search(r'(\d+)\s*[–-]\s*(\d+)\s*(?:秒|s)',description)
                if bounds: rule.update(minimum=int(bounds[1]),maximum=int(bounds[2]))
                elif document['kind']=='yx':
                    choices=[int(v) for v in re.findall(r'\b\d+\b',document['registry']['durationRange'])]
                    rule['enum']=[str(value) for value in choices] if rule['type']=='string' else choices
            fields[name]=rule
    # File alternatives are retained independently; they must not overwrite a
    # same-name JSON array (Wan videos/audios are the regression case).
    if document['kind']=='wan': fields['media']['items']={'type':'object','properties':{'type':{'type':'string','enum':['first_frame','last_frame','reference_image','reference_video','reference_audio']},'url':{'type':'string'}},'required':['type','url']}
    return fields, uploads
