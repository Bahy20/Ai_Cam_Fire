"""Exercise real deployed YOLO/WSS on no-smoke fixtures; never inject detections."""
import asyncio
import io
import json
import time
import uuid
from pathlib import Path
import sys
import requests
from PIL import Image
from websockets.asyncio.client import connect

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from camera.server import frame_packet

async def check(config,cookie,name):
    url=config['url']
    image=Image.open(ROOT/'test_images'/name).convert('RGB')
    image.thumbnail((640,480));data=io.BytesIO();image.save(data,format='JPEG',quality=80)
    results=[]
    async with connect(url.replace('https:','wss:')+'/v1/live',origin=url,
                       additional_headers={'Cookie':cookie},open_timeout=180) as ws:
        session=uuid.uuid4().hex
        await ws.send(json.dumps({'type':'start','camera_id':'test-camera','session_id':session}))
        ready=json.loads(await asyncio.wait_for(ws.recv(),30))
        assert ready['type']=='ready',ready
        async def receive():
            async for raw in ws:
                value=json.loads(raw)
                if value['type']=='error':raise RuntimeError(value)
                if value['type']=='result':results.append(value)
        reader=asyncio.create_task(receive())
        try:
            # Keep source frames flowing during Scout latency so the test does
            # not manufacture a stale-camera alarm while awaiting an assessment.
            for seq in range(1,111):
                await ws.send(frame_packet(session,seq,time.time_ns()//1000000,data.getvalue()))
                await asyncio.sleep(.4)
                if seq>=18 and results and (results[-1].get('inference') or results[-1]['priority']['level']=='monitor'):break
        finally:
            await ws.close();await reader
    assert results,'No deployed results'
    assert all(r['priority']['policy_version']=='two-server-priority-v2' for r in results)
    urgent=[r for r in results if r['priority']['level'] in ('inspect_urgently','escalate')]
    inferences={r['inference'].get('completed_at_ms',r['inference'].get('error')):r['inference'] for r in results if r.get('inference')}
    report={'fixture':name,'results':len(results),'urgent_results':len(urgent),'last':results[-1],
            'inferences':list(inferences.values()),'input':'repeated fixture JPEG over real WSS; not physical webcam'}
    return report

def main():
    config=json.loads((ROOT/'analysis/.modal-client.json').read_text())
    session=requests.Session()
    r=session.post(config['url']+'/testing/login',headers={'Origin':config['url']},json={'code':config['tester_code']},timeout=180)
    r.raise_for_status()
    cookie='; '.join(k+'='+v for k,v in session.cookies.items())
    reports=[asyncio.run(check(config,cookie,name)) for name in ('neg1.jpg','neg2.jpg')]
    folder=ROOT/'.hermes/smoke-deployment';folder.mkdir(exist_ok=True)
    (folder/'checks.json').write_text(json.dumps(reports,indent=2))
    for report in reports:
        print(json.dumps({'fixture':report['fixture'],'results':report['results'],'urgent_results':report['urgent_results'],
                          'detection':report['last']['detection'],'priority':report['last']['priority'],
                          'fresh_inferences':len(report['inferences'])}))
    assert all(not r['urgent_results'] for r in reports),'False urgent alarm on negative fixture'

if __name__=='__main__':main()
