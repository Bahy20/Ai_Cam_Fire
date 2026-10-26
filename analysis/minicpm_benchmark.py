"""Small, strictly validated visual benchmark contract; not a priority policy."""
import json

MODEL_ID='openbmb/MiniCPM-o-4_5'
MODEL_REVISION='d59117d19ddb8a28a62f1b5f4e3b34ac48d510a4'
FIELDS={'flame','smoke','burning_material','lighter','flame_relation','description'}
PRESENCE={'present','not_observed','uncertain'}
RELATIONS={'at_tool_tip','separate','not_observed','uncertain'}
PROMPT='''Inspect these chronological camera images. Report visible evidence only, considering every image. Return exactly one JSON object with these six keys:
"flame", "smoke", "burning_material", "lighter": each is "present", "not_observed", or "uncertain";
"flame_relation": "at_tool_tip", "separate", "not_observed", or "uncertain";
"description": one short sentence naming the visible objects and evidence.
Use burning_material for other material visibly burning, not merely a lighter's own flame. A lighter can coexist with material burning or smoke. Do not assume any tool is a lighter. Use not_observed only when the relevant feature is not visible in these images; use uncertain when it cannot be assessed. Do not infer ignition cause, danger, priority or safety. Return JSON only, without reasoning or Markdown.'''

def parse_assessment(value):
    if isinstance(value,str):
        if len(value)>8192:raise ValueError('output_too_large')
        def unique_fields(pairs):
            result={}
            for key,item in pairs:
                if key in result:raise ValueError('duplicate_field')
                result[key]=item
            return result
        try:value=json.loads(value,object_pairs_hook=unique_fields)
        except (ValueError,TypeError) as exc:raise ValueError('invalid_json') from exc
    if not isinstance(value,dict) or set(value)!=FIELDS:raise ValueError('invalid_fields')
    if any(not isinstance(value[k],str) or value[k] not in PRESENCE for k in ('flame','smoke','burning_material','lighter')):
        raise ValueError('invalid_presence')
    if not isinstance(value['flame_relation'],str) or value['flame_relation'] not in RELATIONS:raise ValueError('invalid_relation')
    if not isinstance(value['description'],str) or not 1<=len(value['description'].strip())<=600:
        raise ValueError('invalid_description')
    if value['flame_relation']=='at_tool_tip' and (value['lighter']!='present' or value['flame']!='present'):
        raise ValueError('contradictory_tool_relation')
    if value['flame_relation']=='separate' and value['flame']!='present':raise ValueError('contradictory_flame_relation')
    return dict(value)

def category_for(value):
    if value['burning_material']=='present':return 'material_burning'
    if value['smoke']=='present':return 'smoke'
    if 'uncertain' in (value[k] for k in FIELDS-{'description'}):return 'uncertain'
    if value['flame']=='present':
        return 'contained_lighter_candidate' if value['lighter']=='present' and value['flame_relation']=='at_tool_tip' else 'flame_visible'
    return 'no_visible_fire'
