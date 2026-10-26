"""Native visual question/answer streaming over one persistent GPU session."""
import time
from analysis.minicpm_contract import single_image_prompt,parse_batch

ENGINE='minicpm-native-visual'
MODE='native_visual_stream'

def hazard_row(a):
    return a['smoke']=='present' or a['burning_material']=='present' or (a['flame']=='present' and a['flame_relation']=='separate')

class VisualSession:
    def __init__(self,model,session_id):
        self.model=model;self.session_id=session_id;self.chunks=0;self.epoch=0;self.last_ts=-1;self.last_sequence=0
        # Native text-only generation does not finalize assistant rounds for the
        # pinned upstream sliding-window trimmer. Avoid that corrupting path by
        # explicitly resetting a small context before the watermark is reached.
        model.streaming_window_config.text_window_high_tokens=8192
        model.streaming_window_config.text_window_low_tokens=6144
        model.reset_session(reset_token2wav_cache=False)
    def reset(self):
        self.model.reset_session(reset_token2wav_cache=False);self.epoch+=1
    def close(self):self.model.reset_session(reset_token2wav_cache=False)
    def push(self,image,meta):
        ts=meta['ts_ms'];sequence=meta['sequence']
        if type(ts) is not int or type(sequence) is not int or ts<=self.last_ts or sequence<=self.last_sequence:raise ValueError('native_frame_order')
        self.last_ts=ts;self.last_sequence=sequence;started=time.perf_counter()
        if self.model._get_kv_cache_length()>=2800:self.reset()
        sid=f'{self.session_id}:{self.epoch}'
        self.model.streaming_prefill(session_id=sid,msgs=[{'role':'user','content':[image,single_image_prompt()]}],
            omni_mode=False,use_tts_template=False,enable_thinking=False,max_slice_nums=1)
        text='';finished=False;assessment=None;error=None
        generator=self.model.streaming_generate(session_id=sid,generate_audio=False,use_tts_template=False,
            enable_thinking=False,do_sample=False,max_new_tokens=256)
        try:
            for part,done in generator:
                if not isinstance(part,str):raise ValueError('native_invalid_text')
                text+=part;finished=finished or bool(done)
                if len(text)>8192:raise ValueError('native_output_limit')
            if not finished:raise ValueError('native_incomplete_turn')
            for token in ('<|im_end|>','<|tts_eos|>','</s>'):
                if text.rstrip().endswith(token):text=text.rstrip()[:-len(token)]
            assessment=parse_batch([text],[f'frame-{ts}'])['frames'][0]
        except (ValueError,TypeError,KeyError):
            error='native_invalid_visual_report'
        finally:
            if hasattr(generator,'close'):generator.close()
        if error:self.reset()
        context=self.model._get_kv_cache_length()
        if context>4096:
            assessment=None;error='native_context_limit';self.reset();context=0
        elif assessment and hazard_row(assessment):
            # A hazard answer conditions later answers on itself. The gateway
            # needs independent confirming rows, so judge the next image fresh.
            self.reset();context=0
        self.chunks+=1
        return {'type':'native_result','engine':ENGINE,'mode':MODE,'session_id':self.session_id,
            'sequence':sequence,'source_ts_ms':ts,'native_chunks':self.chunks,'context_tokens':context,'context_epoch':self.epoch,
            'is_listen':False,'end_of_turn':finished,'text':text[:2048],'assessment':assessment,
            'assessment_source_ts_ms':ts if assessment else None,'validation_error':error,
            'elapsed_ms':round((time.perf_counter()-started)*1000)}
