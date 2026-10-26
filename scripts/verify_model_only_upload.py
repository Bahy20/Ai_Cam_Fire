"""Fresh public HTTP upload check using six seconds of the user's clear-room crop."""
import json,time
from pathlib import Path
import cv2,requests

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.hermes/darkness-20261024'

def main():
    config=json.loads((ROOT/'analysis/.modal-client.json').read_text());base=config['url']
    s=requests.Session();h=s.get(base+'/health',timeout=180);h.raise_for_status()
    assert h.json()['yolo_enabled'] is False and not h.json()['video_job_active']
    cap=cv2.VideoCapture(str(OUT/'camera-60-165s.mp4'));assert cap.isOpened()
    cap.set(cv2.CAP_PROP_POS_FRAMES,240)
    target=OUT/'http-clear-room.mp4';writer=cv2.VideoWriter(str(target),cv2.VideoWriter_fourcc(*'mp4v'),3,(640,480))
    assert writer.isOpened()
    try:
        for _ in range(18):
            ok,frame=cap.read();assert ok;writer.write(frame)
    finally:cap.release();writer.release()
    r=s.post(base+'/testing/login',headers={'Origin':base},json={'code':config['tester_code']},timeout=30);r.raise_for_status()
    with target.open('rb') as video:
        r=s.post(base+'/v1/videos',headers={'Origin':base},files={'video':('clear-room.mp4',video,'video/mp4')},timeout=60)
    assert r.status_code==202,r.status_code
    job=r.json()['id'];print('Uploaded six seconds of original camera footage (140–146s); waiting for fresh batch inference.',flush=True)
    deadline=time.monotonic()+300
    while time.monotonic()<deadline:
        r=s.get(base+'/v1/videos/'+job,timeout=30);r.raise_for_status();data=r.json()
        if data['status'] in ('complete','failed','interrupted'):break
        time.sleep(2)
    else:raise RuntimeError('HTTP upload verification timed out')
    OUT.joinpath('model-only-http-upload.json').write_text(json.dumps(data,indent=2),encoding='utf-8')
    assert data['status']=='complete',data.get('error')
    result=data['result'];assert result['detection']['source']=='minicpm'
    assert result['priority']['policy_version']=='minicpm-only-v3'
    assert data['inferences'] and all(x['mode']=='fresh' and not x['validation_errors'] for x in data['inferences'])
    # This camera crop contains a nearby face. The model may report occlusion;
    # UNKNOWN is then correct, and must not be forced into a monitoring label.
    assert result['priority']['level'] in ('monitor','unknown') and result['detection']['fire']=='not_detected' and result['detection']['smoke']=='not_detected'
    print(json.dumps({'status':data['status'],'sampled_frames':data['sampled_frames'],
        'fresh_model_batches':len(data['inferences']),'priority':result['priority'],'detection':result['detection'],
        'usage':[x.get('usage') for x in data['inferences']]}),flush=True)

if __name__=='__main__':main()
