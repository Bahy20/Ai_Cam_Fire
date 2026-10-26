"""Run a bounded, non-public MiniCPM GPU benchmark; no production credentials."""
from pathlib import Path
import modal

ROOT=Path(__file__).resolve().parents[1]
app=modal.App('fireguard-minicpm-benchmark')
cache=modal.Volume.from_name('fireguard-minicpm-model-cache',create_if_missing=True)
image=(modal.Image.debian_slim(python_version='3.11')
    .apt_install('libgl1','libglib2.0-0','libsndfile1','ffmpeg')
    .pip_install('torch==2.8.0','torchvision==0.23.0','torchaudio==2.8.0',index_url='https://download.pytorch.org/whl/cu128')
    .pip_install('transformers==4.51.0','accelerate==1.10.1','minicpmo-utils==1.0.6','pillow==10.4.0',
                 'soundfile==0.12.1','librosa==0.9.0','numpy==1.26.4','einops==0.8.1')
    .env({'HF_HOME':'/models/hf','PYTHONUNBUFFERED':'1'})
    .add_local_file(ROOT/'analysis/minicpm_benchmark.py','/app/benchmark_contract.py'))

@app.function(image=image,volumes={'/models':cache},timeout=900,cpu=2,memory=4096)
def download():
    import sys
    sys.path.insert(0,'/app')
    from benchmark_contract import MODEL_ID,MODEL_REVISION
    from huggingface_hub import snapshot_download
    path=snapshot_download(MODEL_ID,revision=MODEL_REVISION,
        allow_patterns=['*.json','*.py','*.safetensors','*.model','*.txt','*.tiktoken','*.jinja'])
    cache.commit()
    return {'snapshot':path,'model':MODEL_ID,'revision':MODEL_REVISION}

@app.cls(image=image,gpu='L40S',cpu=4,memory=32768,volumes={'/models':cache},
         max_containers=1,min_containers=0,scaledown_window=30,timeout=900,startup_timeout=900)
class MiniCPM:
    @modal.enter()
    def load(self):
        import sys,time,torch
        sys.path.insert(0,'/app')
        from benchmark_contract import MODEL_ID,MODEL_REVISION
        from transformers import AutoModel
        started=time.perf_counter()
        self.model=AutoModel.from_pretrained(MODEL_ID,revision=MODEL_REVISION,code_revision=MODEL_REVISION,
            trust_remote_code=True,local_files_only=True,attn_implementation='sdpa',torch_dtype=torch.bfloat16,
            init_vision=True,init_audio=False,init_tts=False).eval().cuda()
        torch.cuda.synchronize();self.load_seconds=time.perf_counter()-started

    @modal.method()
    def evaluate(self,cases):
        import io,time,torch
        from PIL import Image
        from benchmark_contract import MODEL_ID,MODEL_REVISION,PROMPT,parse_assessment,category_for
        results=[]
        if len(cases)>12:raise ValueError('benchmark_case_limit')
        for case in cases:
            if not 1<=len(case['images'])<=3:raise ValueError('image_count')
            images=[]
            for data in case['images']:
                if len(data)>2*1024*1024:raise ValueError('image_size')
                im=Image.open(io.BytesIO(data)).convert('RGB');im.thumbnail((640,640));images.append(im)
            torch.cuda.reset_peak_memory_stats();torch.cuda.synchronize();started=time.perf_counter()
            with torch.inference_mode():
                raw=self.model.chat(msgs=[{'role':'user','content':images+[PROMPT]}],
                    max_new_tokens=256,do_sample=False,use_image_id=False,max_slice_nums=1,
                    use_tts_template=False,enable_thinking=False)
            torch.cuda.synchronize();elapsed=time.perf_counter()-started
            try:assessment=parse_assessment(raw);category=category_for(assessment);error=None
            except (ValueError,TypeError) as exc:assessment=None;category='uncertain';error=str(exc)
            result={'case':case['name'],'elapsed_s':elapsed,'raw':raw,'assessment':assessment,'category':category,
                    'validation_error':error,'peak_gpu_gib':torch.cuda.max_memory_allocated()/1024**3}
            results.append(result);print({k:v for k,v in result.items() if k not in ('raw','assessment')},flush=True)
        return {'model':MODEL_ID,'revision':MODEL_REVISION,'gpu':torch.cuda.get_device_name(),
                'load_seconds':self.load_seconds,'mode':'vision_only_frame_windows_not_full_duplex',
                'results':results}

@app.local_entrypoint()
def main(manifest: str = '', output: str = ''):
    import io,json,time
    from PIL import Image
    def jpeg(path):
        im=Image.open(path).convert('RGB');im.thumbnail((640,640));b=io.BytesIO();im.save(b,format='JPEG',quality=85);return b.getvalue()
    if manifest:
        specification=json.loads(Path(manifest).read_text(encoding='utf-8'))
        cases=[{'name':c['name'],'images':[jpeg(Path(p)) for p in c['images']]} for c in specification['cases']]
        if not 1<=len(cases)<=12:raise ValueError('benchmark_case_limit')
        start=time.perf_counter();snapshot=download.remote()
        report=MiniCPM().evaluate.remote(cases)
        report.update(total_wall_s=time.perf_counter()-start,snapshot=snapshot,input=specification)
        destination=Path(output) if output else Path(manifest).with_name('report.json')
        destination.write_text(json.dumps(report,indent=2),encoding='utf-8')
        print(json.dumps(report,indent=2));return
    saved=ROOT/'.hermes/camera-view/live-evidence-frames/362f884b-6345-457a-8272-eb42248d5fe0'
    desk=sorted(saved.glob('*.jpg'))[-3:]
    lighter=[ROOT/f'.hermes/minicpm-benchmark/lighter-{s}s.jpg' for s in (3,5,7)]
    cases=[{'name':'actual_desk','images':[jpeg(p) for p in desk]},
           {'name':'normal_room','images':[jpeg(ROOT/'test_images/neg1.jpg')]},
           {'name':'lighter_video3','images':[jpeg(p) for p in lighter]},
           {'name':'burning_wood','images':[jpeg(ROOT/'test_images/fire1.jpg')]}]
    assert len(desk)==3,'Missing saved camera frames'
    cases=cases+[dict(c,name=c['name']+'_repeat') for c in cases]
    folder=ROOT/'.hermes/minicpm-benchmark';folder.mkdir(exist_ok=True)
    start=time.perf_counter();snapshot=download.remote()
    report=MiniCPM().evaluate.remote(cases)
    report.update(total_wall_s=time.perf_counter()-start,snapshot=snapshot,
                  expected={'actual_desk':'no_visible_fire','normal_room':'no_visible_fire',
                            'lighter_video3':'contained_lighter_candidate','burning_wood':'material_burning'})
    (folder/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report,indent=2))
