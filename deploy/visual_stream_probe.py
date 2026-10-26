"""Bounded real-GPU check of the exact production visual-stream adapter."""
from pathlib import Path
import modal
ROOT=Path(__file__).resolve().parents[1]
app=modal.App('fireguard-visual-stream-probe')
if modal.is_local():
    from deploy.modal_app import vision_image,model_cache
    vision_image=vision_image.add_local_file(ROOT/'analysis/visual_stream.py','/app/analysis/visual_stream.py').add_local_file(ROOT/'analysis/native_stream.py','/app/analysis/native_stream.py')
else:
    vision_image=modal.Image.debian_slim();model_cache=modal.Volume.from_name('fireguard-minicpm-model-cache')

@app.function(image=vision_image,gpu='H100',cpu=4,memory=32768,volumes={'/models':model_cache},timeout=300)
def run(cases):
    import sys,io,time,json,torch
    from PIL import Image
    from transformers import AutoModel
    from huggingface_hub import snapshot_download
    sys.path.insert(0,'/app')
    from analysis.minicpm_contract import MODEL_ID,MODEL_REVISION
    from analysis.visual_stream import VisualSession
    snapshot=snapshot_download(MODEL_ID,revision=MODEL_REVISION,local_files_only=True)
    model=AutoModel.from_pretrained(snapshot,trust_remote_code=True,local_files_only=True,
        attn_implementation='sdpa',torch_dtype=torch.bfloat16,init_vision=True,init_audio=False,init_tts=False).eval().cuda()
    session=VisualSession(model,'visual-control-probe');results=[]
    with torch.inference_mode():
        for i,case in enumerate(cases):
            image=Image.open(io.BytesIO(case['jpeg'])).convert('RGB');image.thumbnail((640,480));started=time.perf_counter()
            report=session.push(image,{'ts_ms':i*1000,'sequence':i+1})
            result={'case':case['name'],'raw':report['text'],'row':report['assessment'],'error':report['validation_error'],'elapsed_ms':report['elapsed_ms'],
                'context_tokens':report['context_tokens'],'context_epoch':report['context_epoch'],'gpu_peak_gib':torch.cuda.max_memory_allocated()/1024**3}
            results.append(result);print(json.dumps(result),flush=True)
    return results

@app.local_entrypoint()
def main():
    import json
    room=ROOT/'.hermes/live-camera-20261025/user-last.jpg'
    lawn=ROOT/'.hermes/dry-grass-20261025'
    lighter=ROOT/'.hermes/minicpm-recording-20261023'
    files=[('unlit_lawn',lawn/'frame-0s.jpg')]*3
    files+=[('burning_lawn',lawn/f'frame-{t}s.jpg') for t in (7,20,20)]
    files+=[('room_after_fire',room)]*3
    files+=[('lighter',ROOT/'.hermes/darkness-20261024'/f'camera-{t}s.jpg') for t in (75,76,77)]
    files+=[('room_after_lighter',room)]*3
    results=run.remote([{'name':name,'jpeg':path.read_bytes()} for name,path in files])
    out=ROOT/'.hermes/live-camera-20261025/h100-visual-probe.json';out.write_text(json.dumps(results,indent=2),encoding='utf-8')
    assert all(r['row'] for r in results),'Visual stream schema failed'
    assert all(r['row']['flame']=='not_observed' and r['row']['smoke']=='not_observed' for r in results[:3]),'False initial lawn hazard'
    assert all(r['row']['burning_material']=='present' and r['row']['flame']=='present' and r['row']['lighter']=='not_observed' for r in results[3:6]),'Burning material missed or lighter invented'
    assert all(r['row']['flame']=='not_observed' and r['row']['smoke']=='not_observed' for r in results[6:9]+results[12:]),'Old hazard leaked into new image'
    assert all(r['row']['lighter']=='present' and r['row']['flame_relation']=='at_tool_tip' and r['row']['flame']=='present' and
        all(r['row'][k]=='not_observed' for k in ('smoke','burning_material','occlusion')) for r in results[9:12]),'Lighter-only scene not supported'
    print('Visual streaming control sequence passed.',flush=True)
