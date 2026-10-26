"""Deployed tester auth, isolation, upload and WSS checks using synthetic dark frames."""
import asyncio
import io
import json
import sys
import time
import uuid
from pathlib import Path
import requests

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from camera.server import frame_packet

async def websocket_check(url,cookies):
    from PIL import Image
    from websockets.asyncio.client import connect
    jpeg=io.BytesIO();Image.new('RGB',(640,480),(16,16,16)).save(jpeg,format='JPEG')
    async with connect(url.replace('https:','wss:')+'/v1/live',origin=url,
                       additional_headers={'Cookie':cookies},compression=None,open_timeout=180) as ws:
        session=uuid.uuid4().hex
        await ws.send(json.dumps({'type':'start','camera_id':'test-camera','session_id':session}))
        ready=json.loads(await asyncio.wait_for(ws.recv(),20));assert ready['type']=='ready',ready
        await ws.send(frame_packet(session,1,time.time_ns()//1000000,jpeg.getvalue()))
        result=json.loads(await asyncio.wait_for(ws.recv(),30))
        assert result['type']=='result' and result['camera_id'].startswith('tester-'),result
        return {'status':'passed','detection':result['detection'],'camera_isolated':True}

def main():
    import cv2
    import numpy as np
    c=json.loads((ROOT/'analysis/.modal-client.json').read_text());url=c['url']
    folder=ROOT/'.hermes/hosted-tester-verification';folder.mkdir(exist_ok=True)
    sessions=[requests.Session(),requests.Session()]
    for session in sessions:
        r=session.post(url+'/testing/login',json={'code':c['tester_code']},headers={'Origin':url},timeout=180)
        assert r.status_code==200,r.status_code
    path=folder/'negative.mp4';writer=cv2.VideoWriter(str(path),cv2.VideoWriter_fourcc(*'mp4v'),3,(640,480))
    assert writer.isOpened()
    for _ in range(3):writer.write(np.full((480,640,3),16,dtype=np.uint8))
    writer.release()
    with path.open('rb') as data:
        r=sessions[0].post(url+'/v1/videos',headers={'Origin':url},files={'video':('negative.mp4',data,'video/mp4')},timeout=180)
    assert r.status_code==202,(r.status_code,r.text[:100]);job=r.json()['id']
    deadline=time.monotonic()+120
    while time.monotonic()<deadline:
        r=sessions[0].get(url+'/v1/videos/'+job,timeout=30);r.raise_for_status();result=r.json()
        if result['status'] in ('complete','failed','interrupted'):break
        time.sleep(1)
    assert result['status']=='complete',result['status']
    assert sessions[1].get(url+'/v1/videos/'+job,timeout=30).status_code==404
    assert requests.get(url+'/v1/videos/'+job,timeout=30).status_code==401
    cookies='; '.join(k+'='+v for k,v in sessions[0].cookies.items())
    ws=asyncio.run(websocket_check(url,cookies))
    report={'url':url,'upload_status':result['status'],'cross_tester_lookup':404,'anonymous_lookup':401,'websocket':ws,'fresh_calls':len(result['inferences'])}
    (folder/'checks.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))

if __name__=='__main__':main()
