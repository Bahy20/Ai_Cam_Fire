import json,types,unittest
from analysis.visual_stream import VisualSession

ROW={'flame':'not_observed','smoke':'not_observed','burning_material':'not_observed','lighter':'not_observed',
     'flame_relation':'not_observed','occlusion':'not_observed','description':'An unlit room.'}

class Model:
    def __init__(self):
        self.cache=0;self.resets=0;self.prefills=[];self.generates=[];self.responses=[]
        self.streaming_window_config=types.SimpleNamespace(text_window_high_tokens=8000,text_window_low_tokens=6000)
    def prepare(self,**kw):pass
    def reset_session(self,**kw):self.cache=0;self.resets+=1
    def _get_kv_cache_length(self):return self.cache
    def streaming_prefill(self,**kw):self.prefills.append(kw);self.cache+=300;return {'success':True}
    def streaming_generate(self,**kw):
        self.generates.append(kw);self.cache+=100
        if 'generate_audio' not in kw:return {'text':'[0,0,0,0,0,0]','end_of_turn':True}
        text=self.responses.pop(0) if self.responses else json.dumps(ROW)+'<|im_end|>'
        return iter([(text[:30],False),(text[30:],True)])

class VisualStreamTests(unittest.TestCase):
    def test_uses_native_visual_prefill_and_streaming_generator_with_current_image_question(self):
        m=Model();s=VisualSession(m,'source');r=s.push('image',{'ts_ms':1000,'sequence':1})
        self.assertIn('msgs',m.prefills[0]);self.assertEqual(m.prefills[0]['msgs'][0]['content'][0],'image')
        self.assertIn('Inspect this camera image',m.prefills[0]['msgs'][0]['content'][1])
        self.assertFalse(m.generates[0]['generate_audio']);self.assertFalse(m.generates[0]['use_tts_template'])
        self.assertEqual(r['assessment']['flame'],'not_observed');self.assertEqual(r['engine'],'minicpm-native-visual')
        self.assertEqual(r['assessment_source_ts_ms'],1000);self.assertEqual(r['assessment']['frame_id'],'frame-1000')
    def test_context_is_reused_then_reset_before_the_upstream_trim_failure(self):
        m=Model();s=VisualSession(m,'source')
        for i in range(3):s.push('image',{'ts_ms':i*1000,'sequence':i+1})
        self.assertEqual(m.resets,1);m.cache=3000
        r=s.push('new-image',{'ts_ms':3000,'sequence':4})
        self.assertEqual(m.resets,2);self.assertEqual(r['context_epoch'],1)
        self.assertEqual(r['native_chunks'],4);self.assertNotEqual(m.prefills[0]['session_id'],m.prefills[-1]['session_id'])
    def test_invalid_response_is_not_relabeled_and_resets_poisoned_context(self):
        m=Model();m.responses=['bad json'];s=VisualSession(m,'source');r=s.push('image',{'ts_ms':1000,'sequence':1})
        self.assertIsNone(r['assessment']);self.assertIsNotNone(r['validation_error']);self.assertEqual(m.cache,0)
        r=s.push('new-image',{'ts_ms':2000,'sequence':2});self.assertEqual(r['assessment']['frame_id'],'frame-2000')
    def test_duplicate_and_backwards_sources_are_rejected(self):
        m=Model();s=VisualSession(m,'source');s.push('image',{'ts_ms':1000,'sequence':1})
        with self.assertRaises(ValueError):s.push('other',{'ts_ms':1000,'sequence':2})
    def push_row(self,**fields):
        m=Model();m.responses=[json.dumps({**ROW,**fields})+'<|im_end|>'];s=VisualSession(m,'source')
        r=s.push('image',{'ts_ms':1000,'sequence':1});s.push('next',{'ts_ms':2000,'sequence':2})
        return m,s,r
    def assert_fresh_after(self,m,s,r):
        self.assertIsNone(r['validation_error']);self.assertEqual(m.resets,2);self.assertEqual(r['context_epoch'],1)
        self.assertEqual(r['context_tokens'],0);self.assertEqual(m.prefills[1]['session_id'],'source:1')
    def assert_kept_after(self,m,s,r):
        self.assertIsNone(r['validation_error']);self.assertEqual(m.resets,1);self.assertEqual(r['context_epoch'],0)
        self.assertEqual(r['context_tokens'],400);self.assertEqual(m.prefills[1]['session_id'],'source:0');self.assertEqual(m.cache,800)
    def test_smoke_report_resets_so_the_next_image_is_judged_with_fresh_context(self):
        m,s,r=self.push_row(smoke='present',description='Grey smoke.')
        self.assertEqual(r['assessment']['smoke'],'present');self.assertEqual(r['assessment_source_ts_ms'],1000);self.assert_fresh_after(m,s,r)
    def test_burning_material_report_resets_context(self):
        m,s,r=self.push_row(flame='present',burning_material='present',flame_relation='separate',description='Paper burning.')
        self.assertEqual(r['assessment']['burning_material'],'present');self.assert_fresh_after(m,s,r)
    def test_separate_flame_report_resets_context(self):
        m,s,r=self.push_row(flame='present',flame_relation='separate',description='A flame on the bench.')
        self.assertEqual(r['assessment']['flame_relation'],'separate');self.assert_fresh_after(m,s,r)
    def test_clear_report_keeps_context(self):
        m,s,r=self.push_row();self.assertEqual(r['assessment']['smoke'],'not_observed');self.assert_kept_after(m,s,r)
    def test_lighter_flame_at_tool_tip_keeps_context(self):
        m,s,r=self.push_row(flame='present',lighter='present',flame_relation='at_tool_tip',description='A lit lighter.')
        self.assertEqual(r['assessment']['flame_relation'],'at_tool_tip');self.assert_kept_after(m,s,r)
    def test_uncertain_report_keeps_context(self):
        m,s,r=self.push_row(flame='uncertain',smoke='uncertain',burning_material='uncertain',flame_relation='uncertain',description='Blurry.')
        self.assertEqual(r['assessment']['smoke'],'uncertain');self.assert_kept_after(m,s,r)
    def test_special_tokens_only_trim_at_the_end_not_arbitrary_model_prose(self):
        m=Model();m.responses=['Here is your answer: '+json.dumps(ROW)];s=VisualSession(m,'source')
        self.assertIsNone(s.push('image',{'ts_ms':1000,'sequence':1})['assessment'])

if __name__=='__main__':unittest.main()
