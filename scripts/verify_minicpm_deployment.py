"""Fresh deployed upload and WSS checks; prints no credentials."""
import asyncio,io,json,time,uuid,sys
from pathlib import Path
from collections import Counter
import requests
from PIL import Image
from websockets.asyncio.client import connect
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from camera.server import frame_packet

OUT=ROOT/'.hermes/minicpm-replacement'
MODEL='openbmb/MiniCPM-o-4_5'
POLICY='minicpm-only-v5'

async def live(config,cookie,fixture=None,label='lighter',require_fresh=True):
    fixture=fixture or ROOT/'.hermes/minicpm-recording-20261023/camera-66s.jpg'
    im=Image.open(fixture).convert('RGB')
    im.thumbnail((640,480));data=io.BytesIO();im.save(data,format='JPEG',quality=80)
    results=[];errors=[];first_fresh=None
    async with connect(config['url'].replace('https:','wss:')+'/v1/live',origin=config['url'],
                       additional_headers={'Cookie':cookie},open_timeout=180) as ws:
        session=uuid.uuid4().hex
        await ws.send(json.dumps({'type':'start','camera_id':'test-camera','session_id':session}))
        ready=json.loads(await asyncio.wait_for(ws.recv(),30))
        if ready['type']!='ready':raise RuntimeError(ready)
        async def receive():
            nonlocal first_fresh
            async for raw in ws:
                value=json.loads(raw)
                if value['type']=='result':
                    results.append(value)
                    if (value.get('inference') or {}).get('mode')=='fresh' and first_fresh is None:first_fresh=time.monotonic()
                elif value['type']=='error':errors.append(value)
        reader=asyncio.create_task(receive())
        try:
            for seq in range(1,151):
                await ws.send(frame_packet(session,seq,time.time_ns()//1000000,data.getvalue()))
                await asyncio.sleep(.4)
                if first_fresh and time.monotonic()-first_fresh>4:break
                if not require_fresh and seq>=18 and results:break
        finally:
            await ws.close();await reader
    report={'input':f'repeated fixture JPEG {fixture.name} over real WSS, not a new physical webcam capture',
            'ready':ready,'results':results,'errors':errors}
    (OUT/f'wss-{label}.json').write_text(json.dumps(report,indent=2))
    fresh=[r['inference'] for r in results if r.get('inference') and r['inference']['mode']=='fresh']
    assert not errors,errors
    if require_fresh:assert fresh,'No fresh MiniCPM WSS inference'
    assert all(r['model']==MODEL and r['source']=='modal' for r in fresh)
    print(json.dumps({'fixture':label,'wss_results':len(results),'fresh_model':fresh[-1]['model'] if fresh else None,'last_priority':results[-1]['priority']}),flush=True)

def main():
    OUT.mkdir(exist_ok=True)
    config=json.loads((ROOT/'analysis/.modal-client.json').read_text())
    base=config['url'];s=requests.Session()
    health=s.get(base+'/health',timeout=180);health.raise_for_status();health=health.json()
    (OUT/'health.json').write_text(json.dumps(health,indent=2))
    assert health['vlm_model']==MODEL and health['vlm_provider']=='modal' and not health['scout_configured'],health
    assert health['policy_version']==POLICY and isinstance(health['build_id'],str) and health['build_id'],health
    print(json.dumps({'policy_version':health['policy_version'],'build_id':health['build_id']}),flush=True)
    if health['video_job_active'] or health['live_active']:raise RuntimeError('deployed_service_busy')
    page=s.get(base+'/testing',timeout=30);page.raise_for_status();assert 'MiniCPM-o 4.5' in page.text
    r=s.post(base+'/testing/login',headers={'Origin':base},json={'code':config['tester_code']},timeout=30);r.raise_for_status()
    s.headers['Origin']=base
    clip=ROOT/'.hermes/minicpm-recording-20261023/camera-only-25-74s.mp4'
    with clip.open('rb') as video:r=s.post(base+'/v1/videos',files={'video':(clip.name,video,'video/mp4')},timeout=120)
    r.raise_for_status();job=r.json();(OUT/'job.json').write_text(json.dumps(job,indent=2))
    deadline=time.monotonic()+240
    while time.monotonic()<deadline:
        r=s.get(base+job['result_url']+'?limit=1000',timeout=45);r.raise_for_status();value=r.json()
        (OUT/'upload.json').write_text(json.dumps(value,indent=2))
        print(json.dumps({'status':value['status'],'frames':value.get('sampled_frames'),'inferences':len(value.get('inferences',[]))}),flush=True)
        if value['status'] in ('complete','failed'):break
        time.sleep(5)
    assert value['status']=='complete',value.get('error',value['status'])
    fresh=[r for r in value['inferences'] if r['mode']=='fresh']
    assert fresh,'No fresh MiniCPM upload inference'
    assert all(r['model']==MODEL and r['source']=='modal' for r in fresh),fresh
    print(json.dumps({'fresh_upload_calls':len(fresh),'failed_upload_calls':len(value['inferences'])-len(fresh),
                      'result_priority':value['result']['priority']}),flush=True)
    cookie='; '.join(k+'='+v for k,v in s.cookies.items())
    asyncio.run(live(config,cookie,require_fresh=False))
    asyncio.run(live(config,cookie,ROOT/'test_images/fire1.jpg',label='burning-wood'))

if __name__=='__main__':main()
