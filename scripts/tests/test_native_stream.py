import unittest
from analysis.native_stream import NativeSession,parse_report

class FakeDuplex:
    def __init__(self):self.prepares=0;self.frames=[]
    def prepare(self,**kwargs):self.prepares+=1
    def streaming_prefill(self,**kwargs):self.frames.extend(kwargs['frame_list']);return {'success':True}
    def streaming_generate(self,**kwargs):return {'text':'[1,0,0,1,1,0]','is_listen':False,'end_of_turn':True,'n_tokens':14}

class NativeTests(unittest.TestCase):
    def test_report_schedule_renews_three_frame_evidence_before_it_expires(self):
        from unittest.mock import patch
        from contextlib import contextmanager
        decisions=[]
        @contextmanager
        def schedule(duplex,due):decisions.append(due);yield
        with patch('analysis.native_stream.scheduled_report',schedule):
            s=NativeSession(FakeDuplex(),'cadence')
            for i in range(6):s.push('frame',{'sequence':i+1,'ts_ms':i*1000})
        self.assertEqual(decisions,[True,False,True,False,True,False])
    def test_periodic_reports_disable_repetition_penalty_and_optional_listening(self):
        d=FakeDuplex();options=[]
        def generate(**kw):
            options.append(kw);return {'text':'[0,0,0,0,0,0]','is_listen':False,'end_of_turn':True}
        d.streaming_generate=generate;s=NativeSession(d,'session')
        for i in range(3):s.push('image',{'sequence':i+1,'ts_ms':i*1000})
        self.assertTrue(all(v['text_repetition_penalty']==1.0 for v in options))
    def test_scheduled_report_masks_only_listening_and_restores_decoder(self):
        import numpy as np
        from analysis.native_stream import scheduled_report
        class Logits(np.ndarray):
            def clone(self):return self.copy()
        class Decoder:
            listen_id=1
            def decode(self,**kw):return kw['logits']
        d=FakeDuplex();d.decoder=Decoder();d.listen_token_id=2;original=d.decoder.decode
        logits=np.array([[2.,5.,3.]]).view(Logits)
        with scheduled_report(d,True):masked=d.decoder.decode(logits=logits)
        self.assertEqual(masked[0,2],float('-inf'));self.assertEqual(masked[0,1],5);self.assertEqual(masked[0,0],2)
        self.assertEqual(logits[0,1],5);self.assertEqual(d.decoder.decode,original)
    def test_real_native_apis_retain_context_across_successive_frames(self):
        d=FakeDuplex();s=NativeSession(d,'session')
        a=s.push('image-a',{'sequence':1,'ts_ms':1000})
        b=s.push('image-b',{'sequence':2,'ts_ms':2000})
        self.assertEqual(d.prepares,1);self.assertEqual(d.frames,['image-a','image-b'])
        self.assertEqual(b['native_chunks'],2);self.assertEqual(b['assessment']['flame'],'present')
        self.assertEqual(a['assessment']['frame_id'],'frame-1000');self.assertEqual(b['assessment']['frame_id'],'frame-2000')
    def test_partial_text_cannot_be_bound_to_one_frame_as_a_complete_report(self):
        d=FakeDuplex();outputs=iter([{'text':'[1,0,','is_listen':False,'end_of_turn':False},
                                  {'text':'0,1,1,0]','is_listen':False,'end_of_turn':True}])
        d.streaming_generate=lambda **kw:next(outputs)
        s=NativeSession(d,'session')
        self.assertIsNone(s.push('a',{'sequence':1,'ts_ms':1000})['assessment'])
        self.assertIsNone(s.push('b',{'sequence':2,'ts_ms':2000})['assessment'])
    def test_malformed_or_contradictory_reports_fail_closed(self):
        self.assertEqual(parse_report('[0,0,0,0,0,0]')['flame'],'not_observed')
        for raw in ['safe','[0,0,0,1,1,0]','[1,0,0,0,1,0]','[true,0,0,0,0,0]','[1,0]','[9,0,0,0,0,0]']:
            with self.assertRaises(ValueError):parse_report(raw)
    def test_source_order_is_strict(self):
        s=NativeSession(FakeDuplex(),'session');s.push('a',{'sequence':1,'ts_ms':1000})
        with self.assertRaises(ValueError):s.push('b',{'sequence':2,'ts_ms':1000})

    def test_delayed_turn_end_does_not_relabel_a_new_frame_with_old_evidence(self):
        d=FakeDuplex();outputs=iter([{'text':'[1,0,0,1,1,0]','end_of_turn':False},
                                  {'text':'','end_of_turn':True}])
        d.streaming_generate=lambda **kw:next(outputs)
        s=NativeSession(d,'session');s.push('a',{'sequence':1,'ts_ms':1000})
        value=s.push('b',{'sequence':2,'ts_ms':2000})
        self.assertEqual(value['assessment']['frame_id'],'frame-1000')
        self.assertEqual(value['assessment_source_ts_ms'],1000)

if __name__=='__main__':unittest.main()
