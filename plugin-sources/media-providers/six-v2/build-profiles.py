"""Build endpoint contracts; frozen legacy profiles only preserve old execution.

New parameter initialization never enumerates documentation model examples.
"""
from pathlib import Path
import hashlib
import json
import sys
from interface_contracts import attach_interfaces

root = Path(__file__).resolve().parent
raw = (root / 'legacy-profiles.json').read_bytes()
assert hashlib.sha256(raw).hexdigest() == '5d886ba687a54c3032ee88830b177968888287d3f59ed2f9e6aa0ec1bc862a11'
providers = attach_interfaces(json.loads(raw))
if '--provider=yuxibox_media' in sys.argv:
    existing = json.loads((root/'profiles.json').read_text(encoding='utf8'))
    for key in providers:
        if key != 'yuxibox_media': providers[key] = existing[key]
    for field in ['models','pendingModels']: providers['yuxibox_media'][field]=existing['yuxibox_media'][field]
    for key, entry in existing['yuxibox_media']['interfaces'].items():
        if entry['kind']=='image': providers['yuxibox_media']['interfaces'][key]=entry
(root / 'profiles.json').write_text(json.dumps(providers, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
lock = json.loads((root / 'sources.lock.json').read_text(encoding='utf8'))
lock['interfaceParameters'] = {'format': 'plugin-interface-contract/v1', 'legacyExecutionSHA256': '5d886ba687a54c3032ee88830b177968888287d3f59ed2f9e6aa0ec1bc862a11', 'builderSHA256': hashlib.sha256((root / 'interface_contracts.py').read_bytes()).hexdigest(), 'documentIndexSHA256': hashlib.sha256((root / 'evidence/parameters-20261017/index.json').read_bytes()).hexdigest(), 'modelExamplesCreateBindings': False}
lock['yuxiboxVideoParameters'] = {'extractorSHA256':hashlib.sha256((root/'yuxibox_contracts.py').read_bytes()).hexdigest(), 'sources':json.loads((root/'evidence/yuxibox-video-20261018/sources.json').read_text(encoding='utf8')), 'conflictsSHA256':hashlib.sha256((root/'evidence/yuxibox-video-20261018/conflicts.json').read_bytes()).hexdigest(), 'modelsCreateBindings':False,'pricesChanged':False}
(root / 'sources.lock.json').write_text(json.dumps(lock, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
print(json.dumps({key: {'interfaces': len(value['interfaces']), 'legacyExecutionModels': len(value['models'])} for key, value in providers.items()}))
