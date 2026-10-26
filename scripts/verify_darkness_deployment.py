"""Replay the supplied recording's camera region over real public WSS."""
import asyncio,contextlib,io,json,time,uuid,sys
from pathlib import Path
from collections import Counter
import cv2,requests
from PIL import Image
from websockets.asyncio.client import connect
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from camera.server import frame_packet
OUT=ROOT/'.hermes/darkness-20261024'

async def replay(config,cookie):
    cap=cv2.VideoCapture(str(OUT/'camera-60-165s.mp4'));assert cap.isOpened()
    first=Image.open(OUT/'camera-140s.jpg').convert('RGB');first.thumbnail((640,480));buf=io.BytesIO();first.save(buf,format='JPEG',quality=80)
    results=[];errors=[];frames={};ready_native=asyncio.Event();session=uuid.uuid4().hex;seq=0;last_ts=0
    async with connect(config['url'].replace('https:','wss:')+'/v1/live',origin=config['url'],
      additional_headers={'Cookie':cookie},open_timeout=180,close_timeout=5) as ws:
        await ws.send(json.dumps({'type':'start','camera_id':'test-camera','session_id':session}))
        ready=json.loads(await asyncio.wait_for(ws.recv(),30));assert ready['type']=='ready',ready
        async def read():
            async for raw in ws:
                r=json.loads(raw)
                if r.get('type')=='result':
                    results.append(r)
                    if (r.get('native_stream') or {}).get('native_chunks',0)>0:ready_native.set()
                elif r.get('type')=='error':errors.append(r)
        reader=asyncio.create_task(read())
        async def send(jpeg,source=None):
            nonlocal seq,last_ts
            seq+=1;ts=max(last_ts+1,time.time_ns()//1000000);last_ts=ts;frames[ts]=source
            await ws.send(frame_packet(session,seq,ts,jpeg))
        started=time.monotonic()
        try:
            while not ready_native.is_set() and time.monotonic()-started<160:
                if reader.done():await reader;raise RuntimeError('stream_closed')
                await send(buf.getvalue());await asyncio.sleep(1/3)
            assert ready_native.is_set(),'native startup failed'
            print('Native GPU connected; replaying user camera crop from 60 to 165 seconds.',flush=True)
            start=time.monotonic()
            i=0
            while i<315:
                await asyncio.sleep(max(0,i/3-(time.monotonic()-start)))
                due=min(314,max(i,int((time.monotonic()-start)*3)))
                while i<due:
                    ok=cap.grab();assert ok;i+=1
                ok,image=cap.read();assert ok
                ok,jpeg=cv2.imencode('.jpg',image,[cv2.IMWRITE_JPEG_QUALITY,80]);assert ok
                await send(jpeg.tobytes(),round(60+i/3,3))
                if i%45==0:print(json.dumps({'original_video_s':round(60+i/3),'frames':i}),flush=True)
                i+=1
            await asyncio.sleep(2)
        finally:
            cap.release();await ws.close()
            with contextlib.suppress(Exception):await reader
    OUT.joinpath('deployed-user-replay.json').write_text(json.dumps({'input':'Camera crop from user Drive recording, original 60–165s; three FPS over WSS',
        'results':results,'errors':errors,'source_video_seconds_by_timestamp':frames},indent=2),encoding='utf-8')
    assert not errors,errors
    scored=[r for r in results if frames.get(r.get('source_ts_ms')) is not None]
    assert scored and all(r['priority']['policy_version']=='minicpm-only-v1' and r['detection']['source']=='minicpm' for r in scored)
    reports={r['native_stream']['assessment_ts_ms']:r['native_stream']['assessment'] for r in scored
             if (r.get('native_stream') or {}).get('assessment')}
    mapped=[{'video_s':frames.get(ts),'row':row} for ts,row in reports.items() if frames.get(ts) is not None]
    tail=[r for r in scored if frames.get(r['source_ts_ms'],0)>=145]
    summary={'results':len(scored),'native_steps':max(r['native_stream'].get('native_chunks',0) for r in scored),
      'valid_reports':len(mapped),'priority_counts':dict(Counter(r['priority']['reason'] for r in scored)),
      'lighter_monitor_results':sum(r['priority']['reason']=='contained_lighter' for r in scored if 65<=frames.get(r['source_ts_ms'],0)<=90),
      'last_priority':scored[-1]['priority'],'last_detection':scored[-1]['detection'],
      'tail_current_smoke_detected':sum(r['detection']['smoke']=='detected' for r in tail),
      'tail_urgent_results':sum(r['priority']['level'] in ('inspect_urgently','escalate') for r in tail),
      'reports':mapped}
    OUT.joinpath('deployed-user-summary.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in summary.items() if k!='reports'}),flush=True)
    assert len(mapped)>=10,'Native reports did not remain periodic'
    assert summary['lighter_monitor_results']>0,'Lighter never received monitoring priority'
    assert tail and summary['tail_current_smoke_detected']==0,'Historical smoke leaked into the current room view'
    assert summary['tail_urgent_results']==0,'Clear-room ending still produced urgent results'

def main():
    config=json.loads((ROOT/'analysis/.modal-client.json').read_text());base=config['url'];s=requests.Session()
    r=s.get(base+'/health',timeout=180);r.raise_for_status();h=r.json()
    assert h['live_vlm_mode']=='native_visual_stream' and not h['live_active'] and not h['video_job_active'] and h['yolo_enabled'] is False,h
    r=s.post(base+'/testing/login',headers={'Origin':base},json={'code':config['tester_code']},timeout=30);r.raise_for_status()
    asyncio.run(replay(config,'; '.join(k+'='+v for k,v in s.cookies.items())))

if __name__=='__main__':main()
