"""Build endpoint contracts; frozen legacy profiles only preserve old execution.

New parameter initialization never enumerates documentation model examples.
"""
from pathlib import Path
import hashlib
import json
import sys
from interface_contracts import attach_interfaces

root = Path(__file__).resolve().parent
selected = next((arg.split('=',1)[1] for arg in sys.argv if arg.startswith('--provider=')), None)
if selected == 'xcmapi_media':
    # Updating one supplier's documents must not replay frozen legacy imports.
    from interface_contracts import contract
    from xcm_contracts import documented_xcm_video
    providers = json.loads((root/'profiles.json').read_text(encoding='utf8'))
    entry = documented_xcm_video(providers[selected], contract)
    native = providers[selected]['interfaces']['interface:0d35f19e841e7b7f']
    native['modelRules'] = entry['modelRules']
    native['codec'].pop('modelRules', None)
    native['sourceConflicts'] = entry['sourceConflicts']
    native['sourceResolutions'] = entry['sourceResolutions']
else:
    raw = (root / 'legacy-profiles.json').read_bytes()
    assert hashlib.sha256(raw).hexdigest() == '5d886ba687a54c3032ee88830b177968888287d3f59ed2f9e6aa0ec1bc862a11'
    providers = attach_interfaces(json.loads(raw))
    if selected:
        assert selected == 'yuxibox_media'
        existing = json.loads((root/'profiles.json').read_text(encoding='utf8'))
        for key in providers:
            if key != selected: providers[key] = existing[key]
        for field in ['models','pendingModels']: providers[selected][field]=existing[selected][field]
        for key, entry in existing[selected]['interfaces'].items():
            if entry['kind']=='image': providers[selected]['interfaces'][key]=entry
(root / 'profiles.json').write_text(json.dumps(providers, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
lock = json.loads((root / 'sources.lock.json').read_text(encoding='utf8'))
lock['interfaceParameters'] = {'format': 'plugin-interface-contract/v1', 'legacyExecutionSHA256': '5d886ba687a54c3032ee88830b177968888287d3f59ed2f9e6aa0ec1bc862a11', 'builderSHA256': hashlib.sha256((root / 'interface_contracts.py').read_bytes()).hexdigest(), 'documentIndexSHA256': hashlib.sha256((root / 'evidence/parameters-20261017/index.json').read_bytes()).hexdigest(), 'modelExamplesCreateBindings': False}
lock['yuxiboxVideoParameters'] = {'extractorSHA256':hashlib.sha256((root/'yuxibox_contracts.py').read_bytes()).hexdigest(), 'sources':json.loads((root/'evidence/yuxibox-video-20261018/sources.json').read_text(encoding='utf8')), 'conflictsSHA256':hashlib.sha256((root/'evidence/yuxibox-video-20261018/conflicts.json').read_bytes()).hexdigest(), 'modelsCreateBindings':False,'pricesChanged':False}
lock['xcmVideoParameters'] = {'extractorSHA256':hashlib.sha256((root/'xcm_contracts.py').read_bytes()).hexdigest(),'sources':json.loads((root/'evidence/xcm-video-20261024/sources.json').read_text(encoding='utf8')),'modelsCreateBindings':False,'pricesChanged':False}
(root / 'sources.lock.json').write_text(json.dumps(lock, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
print(json.dumps({key: {'interfaces': len(value['interfaces']), 'legacyExecutionModels': len(value['models'])} for key, value in providers.items()}))
