"""Bounded native duplex feasibility check, isolated from production sessions."""
from pathlib import Path
import sys,modal
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
app=modal.App('fireguard-native-probe')
if modal.is_local():
    from deploy.modal_app import vision_image,model_cache
    native_image=vision_image.add_local_file(ROOT/'analysis/native_stream.py','/app/analysis/native_stream.py')
else:
    native_image=modal.Image.debian_slim()
    model_cache=modal.Volume.from_name('fireguard-minicpm-model-cache')

@app.function(image=native_image,gpu='L40S',cpu=4,memory=32768,volumes={'/models':model_cache},timeout=300)
def run(images):
    import sys,time,io,torch
    sys.path.insert(0,'/app')
    from PIL import Image
    from transformers import AutoModel
    from huggingface_hub import snapshot_download
    from analysis.minicpm_contract import MODEL_ID,MODEL_REVISION
    from analysis.native_stream import make_duplex,NativeSession
    start=time.perf_counter();snapshot=snapshot_download(MODEL_ID,revision=MODEL_REVISION,local_files_only=True)
    model=AutoModel.from_pretrained(snapshot,trust_remote_code=True,local_files_only=True,torch_dtype=torch.bfloat16,
        attn_implementation='sdpa',init_vision=True,init_audio=False,init_tts=False).eval().cuda()
    duplex=make_duplex(model)
    with torch.inference_mode():
        session=NativeSession(duplex,'probe');load=time.perf_counter()-start;results=[]
        for i,data in enumerate(images):
            im=Image.open(io.BytesIO(data)).convert('RGB');im.thumbnail((640,480))
            result=session.push(im,{'sequence':i+1,'ts_ms':i*1000})
            result['gpu_peak_gib']=torch.cuda.max_memory_allocated()/1024**3;results.append(result)
            print(result,flush=True)
    return {'load_seconds':load,'gpu':torch.cuda.get_device_name(),'engine':'minicpm-native-duplex','results':results}

@app.local_entrypoint()
def main():
    import json
    folder=ROOT/'.hermes/minicpm-recording-20261023'
    files=[folder/f'camera-{s}s.jpg' for s in (26,27,28,62,63,64,66,67,68)]
    files+=[ROOT/'test_images/fire1.jpg']*3
    result=run.remote([p.read_bytes() for p in files])
    out=ROOT/'.hermes/native-streaming';out.mkdir(exist_ok=True)
    (out/'probe.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
