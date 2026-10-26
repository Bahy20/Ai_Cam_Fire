"""Real public tester WSS checks; never prints credentials or uploads audio.

Inputs are recorded JPEG controls, not a newly captured physical webcam.
Run with the project venv after deploying the native endpoint.
"""
import asyncio,contextlib,io,json,sys,time,uuid
from pathlib import Path
import requests
from PIL import Image
from websockets.asyncio.client import connect
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from camera.server import frame_packet
OUT=ROOT/'.hermes/native-streaming'

def jpeg(path):
    im=Image.open(path).convert('RGB');im.thumbnail((640,480))
    data=io.BytesIO();im.save(data,format='JPEG',quality=80);return data.getvalue()

async def session(config,cookie,phases,label,expect_native=True):
    source=uuid.uuid4().hex;values=[];errors=[];first_native=asyncio.Event();ready=None
    started=time.monotonic();sequence=0
    async with connect(config['url'].replace('https:','wss:')+'/v1/live',origin=config['url'],
                       additional_headers={'Cookie':cookie},open_timeout=180,close_timeout=5) as ws:
        await ws.send(json.dumps({'type':'start','camera_id':'test-camera','session_id':source}))
        ready=json.loads(await asyncio.wait_for(ws.recv(),30));assert ready['type']=='ready',ready
        async def receive():
            async for raw in ws:
                value=json.loads(raw)
                if value.get('type')=='result':
                    values.append(value)
                    native=value.get('native_stream') or {}
                    if native.get('native_chunks',0)>0 or not expect_native and native.get('state')=='listening':first_native.set()
                elif value.get('type')=='error':errors.append(value)
        reader=asyncio.create_task(receive())
        async def send(image):
            nonlocal sequence
            sequence+=1
            await ws.send(frame_packet(source,sequence,time.time_ns()//1000000,image))
            await asyncio.sleep(1/3)
        try:
            # Keep newest frames arriving while the zero-minimum GPU starts.
            while not first_native.is_set() and time.monotonic()-started<150:
                if reader.done():await reader;raise RuntimeError('public_wss_closed')
                await send(phases[0][1][0])
            assert first_native.is_set(),'Native GPU did not produce a heartbeat'
            cold_wait=time.monotonic()-started
            for duration,images,name in phases:
                phase_started=time.monotonic();index=0
                print(json.dumps({'phase':name,'duration_s':duration,'session':label}),flush=True)
                while time.monotonic()-phase_started<duration:
                    if reader.done():await reader;raise RuntimeError('public_wss_closed')
                    await send(images[(index//3)%len(images)]);index+=1
            await asyncio.sleep(1)
        finally:
            await ws.close()
            with contextlib.suppress(Exception):await reader
    unique={v['native_stream']['native_chunks']:v['native_stream'] for v in values
            if (v.get('native_stream') or {}).get('native_chunks',0)>0}
    chunks=list(unique.values());contexts=[v['context_tokens'] for v in chunks if isinstance(v.get('context_tokens'),int)]
    report={'input':'Recorded camera JPEG controls over the public tester WSS; no physical webcam capture',
            'ready':ready,'frames_sent':sequence,'cold_wait_seconds':cold_wait,'results':values,'errors':errors,
            'native_chunks':chunks}
    OUT.joinpath(f'deployed-wss-{label}.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    assert not errors,errors
    assert (chunks or not expect_native) and all(v['engine']=='minicpm-native-visual' for v in chunks)
    assert list(unique)==sorted(unique),'Native chunk counter moved backwards'
    assert all((v.get('inference') or {}).get('purpose') in (None,'native_scene') for v in values),'Batch inference ran during live stream'
    summary={'session':label,'native_chunks':len(chunks),'last_chunk':max(unique,default=0),'frames_sent':sequence,
             'cold_wait_seconds':round(cold_wait,2),'context_min':min(contexts) if contexts else None,
             'context_max':max(contexts) if contexts else None,'context_prunes':sum(b<a for a,b in zip(contexts,contexts[1:])),
             'speaking_chunks':sum(v.get('state')=='speaking' for v in chunks),
             'structured_reports':len({(v.get('native_stream') or {}).get('assessment_ts_ms') for v in values
                                       if (v.get('native_stream') or {}).get('assessment')}),
             'last_priority':values[-1]['priority']}
    print(json.dumps(summary),flush=True)
    return summary,chunks

async def verify(config,cookie):
    folder=ROOT/'.hermes/minicpm-recording-20261023'
    room=[jpeg(folder/f'camera-{s}s.jpg') for s in (26,27,28)]
    lighter=[jpeg(folder/f'camera-{s}s.jpg') for s in (62,63,64,66,67,68)]
    wood=[jpeg(ROOT/'test_images/fire1.jpg')]
    long,chunks=await session(config,cookie,[(10,room,'room'),(14,lighter,'lighter'),(15,wood,'burning_wood'),
        (8,room,'room'),(7,lighter,'lighter'),(20,wood,'burning_wood'),(10,room,'room')],'persistent')
    assert long['last_chunk']>=20 and long['structured_reports']>=20,'Stream did not sustain native visual reports'
    assert long['context_prunes']>0,'Sliding context window was not exercised'
    await asyncio.sleep(2)
    reset,reset_chunks=await session(config,cookie,[(6,room,'room')],'reset')
    assert reset_chunks[0]['native_chunks']<=2,'Native counter leaked from previous connection'
    assert reset_chunks[0]['context_tokens']<long['context_max'],'Native context was not reset'
    result={'persistent':long,'reset':reset}
    OUT.joinpath('deployed-summary.json').write_text(json.dumps(result,indent=2),encoding='utf-8')

def main():
    OUT.mkdir(exist_ok=True)
    config=json.loads((ROOT/'analysis/.modal-client.json').read_text());base=config['url'];s=requests.Session()
    response=s.get(base+'/health',timeout=180);response.raise_for_status();health=response.json()
    OUT.joinpath('deployed-health.json').write_text(json.dumps(health,indent=2))
    assert health['live_vlm_mode']=='native_visual_stream' and health['vlm_provider']=='modal',health
    assert not health['live_active'] and not health['video_job_active'],'Service busy'
    page=s.get(base+'/testing',timeout=30);page.raise_for_status();assert 'live-native' in page.text
    login=s.post(base+'/testing/login',headers={'Origin':base},json={'code':config['tester_code']},timeout=30);login.raise_for_status()
    cookie='; '.join(k+'='+v for k,v in s.cookies.items())
    asyncio.run(verify(config,cookie))

if __name__=='__main__':main()
