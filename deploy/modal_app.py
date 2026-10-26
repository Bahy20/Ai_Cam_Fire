"""Deploy with: .venv/Scripts/python.exe -m modal deploy deploy/modal_app.py."""
from pathlib import Path
import modal

ROOT = Path(__file__).resolve().parents[1]

# analysis/src files the gateway image leaves out (legacy coordinator). Root-relative names, as add_local_dir's
# dockerignore-style matcher reads them; shared with gateway_files() so the build id hashes what ships.
GATEWAY_SRC_IGNORE = ['coordinator.js', 'priority.js', 'scout.js']

def gateway_files():
    """Every local file the gateway `image` below uploads; keep in step with its add_local_* calls."""
    src = ROOT/'analysis/src'
    yield from (ROOT/'analysis/package.json', ROOT/'analysis/package-lock.json')
    yield from (p for p in src.rglob('*') if p.relative_to(src).as_posix() not in GATEWAY_SRC_IGNORE)
    yield from (ROOT/'analysis/frame_reader.py', ROOT/'analysis/minicpm_client.py')
    yield from (ROOT/'worker/src').rglob('*')
    yield ROOT/'edge/image_quality.py'

def gateway_build_id():
    """Short deterministic fingerprint of the files shipped in the gateway image, reported by /health as build_id.
    CRLF is hashed as LF, so Windows and Linux checkouts of the same commit get the same id. In a container
    (modal.is_local() is False) Modal re-imports this module without the sources, and the built image already
    carries FIREGUARD_BUILD_ID, so it returns a placeholder there instead of hashing (or raising)."""
    import hashlib
    if not modal.is_local():
        return 'container'
    digest = hashlib.sha256()
    for path in sorted((p for p in gateway_files() if p.is_file()), key=lambda p: p.relative_to(ROOT).as_posix()):
        digest.update(path.relative_to(ROOT).as_posix().encode() + b'\0' + path.read_bytes().replace(b'\r\n', b'\n') + b'\0')
    return digest.hexdigest()[:12]

app = modal.App('fireguard-analysis')
volume = modal.Volume.from_name('fireguard-analysis-data', create_if_missing=True)
secret = modal.Secret.from_name('fireguard-analysis-config', required_keys=['FIREGUARD_TOKEN'])
model_cache = modal.Volume.from_name('fireguard-minicpm-model-cache')
vision_image = (
    modal.Image.debian_slim(python_version='3.11')
    .apt_install('libgl1','libglib2.0-0','libsndfile1','ffmpeg')
    .pip_install('torch==2.8.0','torchvision==0.23.0','torchaudio==2.8.0',index_url='https://download.pytorch.org/whl/cu128')
    .pip_install('transformers==4.51.0','accelerate==1.10.1','minicpmo-utils==1.0.6','pillow==10.4.0',
                 'soundfile==0.12.1','librosa==0.9.0','numpy==1.26.4','einops==0.8.1')
    .pip_install('fastapi==0.156.1')
    .env({'HF_HOME':'/models/hf','PYTHONUNBUFFERED':'1'})
    .add_local_file(ROOT/'analysis/minicpm_benchmark.py','/app/analysis/minicpm_benchmark.py')
    .add_local_file(ROOT/'analysis/minicpm_contract.py','/app/analysis/minicpm_contract.py')
)

@app.cls(image=vision_image,gpu='L40S',cpu=4,memory=32768,volumes={'/models':model_cache},
         max_containers=1,min_containers=0,scaledown_window=120,timeout=90,startup_timeout=180)
class Vision:
    @modal.enter()
    def load(self):
        import sys,time,torch
        sys.path.insert(0,'/app')
        from analysis.minicpm_contract import MODEL_ID,MODEL_REVISION
        from huggingface_hub import snapshot_download
        from transformers import AutoModel
        started=time.perf_counter()
        snapshot=snapshot_download(MODEL_ID,revision=MODEL_REVISION,local_files_only=True)
        self.model=AutoModel.from_pretrained(snapshot,trust_remote_code=True,local_files_only=True,
            attn_implementation='sdpa',torch_dtype=torch.bfloat16,
            init_vision=True,init_audio=False,init_tts=False).eval().cuda()
        torch.cuda.synchronize();self.load_seconds=time.perf_counter()-started

    @modal.method()
    def ready(self):
        from analysis.minicpm_contract import MODEL_ID,MODEL_REVISION
        return {'model':MODEL_ID,'revision':MODEL_REVISION,'load_seconds':self.load_seconds}

    @modal.method()
    def analyze(self,frames):
        import base64,io,time,torch
        from PIL import Image
        from analysis.minicpm_contract import single_image_prompt,parse_batch
        if not isinstance(frames,list) or not 1<=len(frames)<=3:raise ValueError('minicpm_invalid_frame_count')
        images=[];ids=[]
        for frame in frames:
            if set(frame)!={'frame_id','image_b64'} or not isinstance(frame['frame_id'],str) or len(frame['frame_id'])>80:raise ValueError('minicpm_invalid_frame')
            if not isinstance(frame['image_b64'],str) or len(frame['image_b64'])>3*1024*1024:raise ValueError('minicpm_image_too_large')
            data=base64.b64decode(frame['image_b64'],validate=True)
            im=Image.open(io.BytesIO(data))
            if im.width*im.height>1920*1080:raise ValueError('minicpm_image_dimensions')
            im=im.convert('RGB');im.thumbnail((640,640));images.append(im);ids.append(frame['frame_id'])
        if len(set(ids))!=len(ids):raise ValueError('minicpm_duplicate_frame')
        torch.cuda.reset_peak_memory_stats();torch.cuda.synchronize();started=time.perf_counter()
        with torch.inference_mode():
            # The pinned chat() wrapper returns only res[0] even for a batch.
            # Use its processor/generate path to retain all independent rows.
            self.model.prepare_processor()
            processor=self.model.processor
            prompts=[processor.tokenizer.apply_chat_template([{'role':'user','content':'<image>./</image>\n'+single_image_prompt()}],
                tokenize=False,add_generation_prompt=True,use_tts_template=False,enable_thinking=False) for frame_id in ids]
            inputs=processor(prompts,[[im] for im in images],[[] for _ in ids],[[] for _ in ids],
                max_slice_nums=1,use_image_id=False,stream_input=False,return_tensors='pt',max_length=8192).to(self.model.device)
            inputs.pop('image_sizes')
            raws,_=self.model.generate(**inputs,tokenizer=processor.tokenizer,max_new_tokens=256,
                do_sample=False,repetition_penalty=1.02)
        torch.cuda.synchronize();elapsed=time.perf_counter()-started
        import json
        raw=json.dumps(raws)
        try:assessment=parse_batch(raws,ids);error=None
        except ValueError as exc:assessment=None;error=str(exc)
        return {'assessment':assessment,'raw':raw[:16384],'validation_error':error,
                'usage':{'gpu_inference_ms':round(elapsed*1000),'output_characters':len(raw),
                         'peak_allocated_gpu_gib':torch.cuda.max_memory_allocated()/1024**3}}

native_image=(vision_image
    .add_local_file(ROOT/'analysis/native_stream.py','/app/analysis/native_stream.py')
    .add_local_file(ROOT/'analysis/visual_stream.py','/app/analysis/visual_stream.py')
    .add_local_file(ROOT/'analysis/native_server.py','/app/analysis/native_server.py'))

@app.cls(image=native_image,gpu='H100',cpu=4,memory=32768,volumes={'/models':model_cache},secrets=[secret],
         max_containers=1,min_containers=0,scaledown_window=60,timeout=900,startup_timeout=180)
@modal.concurrent(max_inputs=3)
class NativeLive:
    @modal.enter()
    def load(self):
        import sys,torch
        sys.path.insert(0,'/app')
        from transformers import AutoModel
        from huggingface_hub import snapshot_download
        from analysis.minicpm_contract import MODEL_ID,MODEL_REVISION
        snapshot=snapshot_download(MODEL_ID,revision=MODEL_REVISION,local_files_only=True)
        self.model=AutoModel.from_pretrained(snapshot,trust_remote_code=True,local_files_only=True,
            torch_dtype=torch.bfloat16,attn_implementation='sdpa',init_vision=True,init_audio=False,init_tts=False).eval().cuda()

    @modal.asgi_app()
    def web(self):
        import os,torch
        from analysis.visual_stream import VisualSession,ENGINE,MODE
        from analysis.native_server import create_app
        from analysis.minicpm_contract import MODEL_ID,MODEL_REVISION
        return create_app(lambda sid:VisualSession(self.model,sid),os.environ['FIREGUARD_TOKEN'],
            info={'model':MODEL_ID,'revision':MODEL_REVISION,'gpu':torch.cuda.get_device_name(),'context_token_limit':4096},
            inference_context=torch.inference_mode,engine=ENGINE,mode=MODE)

@app.local_entrypoint()
def probe(output: str = '.hermes/minicpm-replacement-probe.json'):
    import base64,json
    folder=ROOT/'.hermes/minicpm-recording-20261023'
    model=Vision();report={'ready':model.ready.remote(),'cases':[]}
    for start in (26,30,62):
        frames=[{'frame_id':f'frame-{(start+i)*1000}',
                 'image_b64':base64.b64encode((folder/f'camera-{start+i:02d}s.jpg').read_bytes()).decode()} for i in range(3)]
        result=model.analyze.remote(frames)
        report['cases'].append({'start_s':start,**result})
        print(json.dumps({'start_s':start,'assessment':result['assessment'],'validation_error':result['validation_error'],'usage':result['usage']}))
    (ROOT/output).write_text(json.dumps(report,indent=2),encoding='utf-8')

# Explicit allowlist: never upload local env files, footage, logs, caches or node_modules.
image = (
    modal.Image.from_registry('node:24.12.0-bookworm-slim', add_python='3.11')
    .apt_install('libglib2.0-0', 'libgl1')
    .pip_install('opencv-python-headless==5.0.0.93', 'numpy==2.4.6', 'pillow==12.3.0','modal==1.6.1')
    .add_local_file(ROOT/'analysis/package.json', '/app/analysis/package.json', copy=True)
    .add_local_file(ROOT/'analysis/package-lock.json', '/app/analysis/package-lock.json', copy=True)
    .run_commands('cd /app/analysis && npm ci --omit=dev')
    .env({'FIREGUARD_DATA_DIR':'/tmp/fireguard', 'PYTHONUNBUFFERED':'1', 'OMP_NUM_THREADS':'2',
          'FIREGUARD_BUILD_ID':gateway_build_id()})
    .add_local_dir(ROOT/'analysis/src', '/app/analysis/src', ignore=GATEWAY_SRC_IGNORE)
    .add_local_file(ROOT/'analysis/frame_reader.py', '/app/analysis/frame_reader.py')
    .add_local_file(ROOT/'analysis/minicpm_client.py', '/app/analysis/minicpm_client.py')
    .add_local_dir(ROOT/'worker/src', '/app/worker/src')
    .add_local_file(ROOT/'edge/image_quality.py', '/app/edge/image_quality.py')
)

@app.cls(image=image, secrets=[secret], volumes={'/persist':volume},
         cpu=2, memory=4096, max_containers=1, min_containers=0,
         scaledown_window=1200, timeout=3600)
@modal.concurrent(max_inputs=20)
class Analysis:
    @modal.enter()
    def start(self):
        import os
        import subprocess
        import sys
        import threading
        import time
        self.stop_event = threading.Event()
        env = {**os.environ, 'FIREGUARD_PYTHON':sys.executable,
               'MINICPM_NATIVE_URL':NativeLive().web.get_web_url()}
        self.process = subprocess.Popen(['node','analysis/src/modal-entry.js'], cwd='/app', env=env)
        # Node writes this marker after an alert-state snapshot so it reaches the volume without the periodic wait.
        marker = os.path.join(os.environ.get('FIREGUARD_DATA_DIR', '/tmp/fireguard'), 'commit-requested')
        def persist():
            last = time.monotonic()
            while not self.stop_event.wait(1):
                if self.process.poll() is not None:
                    if self.stop_event.is_set():
                        break  # Shutting down: stop() commits once the process has exited.
                    try:
                        volume.commit()  # Keep the snapshots Node wrote before it died.
                    except Exception:
                        print('FireGuard volume commit failed', flush=True)
                    os._exit(1)  # Fail the container so Modal can replace a dead backend.
                try:
                    os.remove(marker)  # Remove first: a request made during the commit triggers the next one.
                    requested = True
                except OSError:
                    requested = False
                if not requested and time.monotonic() - last < 10:
                    continue
                last = time.monotonic()
                try:
                    volume.commit()
                except Exception:
                    print('FireGuard volume commit failed', flush=True)
        self.commit_thread = threading.Thread(target=persist, daemon=True)
        self.commit_thread.start()

    @modal.web_server(8002, startup_timeout=180)
    def web(self):
        pass

    @modal.exit()
    def stop(self):
        import subprocess
        self.stop_event.set()
        self.commit_thread.join(timeout=15)
        self.process.terminate()
        try:
            self.process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        volume.commit()
