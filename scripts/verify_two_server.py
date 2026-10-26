"""Real HTTP/WS integration run (local gateway or --base-url deployment). Fresh MiniCPM calls; no cached provider outputs."""
import argparse
import asyncio
import json
import os
import secrets
import subprocess
import sys
import time
import uuid
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from camera.server import frame_packet

async def ws_replay(path,url,token):
    from websockets.asyncio.client import connect
    from analysis.frame_reader import VideoReader
    reader=VideoReader(path);session=uuid.uuid4().hex;events=[]
    async with connect(url,additional_headers={'Authorization':f'Bearer {token}'},max_size=1024*1024,compression=None,open_timeout=180) as ws:
        await ws.send(json.dumps({'type':'start','camera_id':'test-camera','session_id':session}))
        ready=json.loads(await ws.recv())
        if ready.get('type')!='ready':raise RuntimeError(str(ready))
        async def receiver():
            async for message in ws:events.append(json.loads(message))
        task=asyncio.create_task(receiver());started=time.monotonic();epoch=time.time_ns()//1000000;seq=0
        try:
            import base64
            while True:
                frame=reader.next()
                if frame.get('eof'):break
                await asyncio.sleep(max(0,frame['ts_ms']/1000-(time.monotonic()-started)))
                seq+=1
                await ws.send(frame_packet(session,seq,epoch+frame['ts_ms'],base64.b64decode(frame['image_b64'])))
            # Observe late replies and freshness expiry; never resend a frozen frame as live footage.
            await asyncio.sleep(31)
        finally:
            task.cancel()
            try:await task
            except asyncio.CancelledError:pass
            reader.close()
    return {'route':'websocket','video':str(path),'assessment_session_id':ready['assessment_session_id'],
            'sent_frames':seq,'events':events,'fresh_responses':sum(e.get('trigger')=='assessment' and e.get('inference',{}).get('mode')=='fresh' for e in events)}

def main():
    import requests
    parser=argparse.ArgumentParser()
    parser.add_argument('--video-dir',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--websocket-video',type=Path)
    parser.add_argument('--only',help='Optional one filename to upload')
    parser.add_argument('--port',type=int,default=8002,help='Analysis port for this isolated verification run')
    parser.add_argument('--base-url',help='Use an existing deployed HTTPS service instead of starting a local backend')
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    server=None;log=None
    if args.base_url:
        from run_camera_modal import remote_config
        saved=json.loads((ROOT/'analysis/.modal-client.json').read_text())
        token=saved['token'];base=args.base_url.rstrip('/')
        remote_config(base,token) # Reject plaintext remote URLs and credential-bearing URLs.
    else:
        env=os.environ.copy()
        token=secrets.token_urlsafe(32)
        env.update(FIREGUARD_TOKEN=token,FIREGUARD_DATA_DIR=str(args.output/'data'),EXPECTED_LIGHTER_CAMERAS='test-camera',
                   FIREGUARD_PYTHON=sys.executable,ANALYSIS_PORT=str(args.port))
        log=(args.output/'server.log').open('w',encoding='utf-8')
        server=subprocess.Popen(['node','analysis/src/server.js'],cwd=ROOT,env=env,stdout=log,stderr=log,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        base=f'http://127.0.0.1:{args.port}'
    headers={'Authorization':f'Bearer {token}'};results=[]
    try:
        for _ in range(90):
            if server and server.poll() is not None:raise RuntimeError('analysis_server_exited; see server.log')
            try:
                health=requests.get(base+'/health',timeout=180 if args.base_url else 1).json()
                if health.get('ok'):break
            except requests.RequestException:pass
            time.sleep(1)
        else:raise RuntimeError('analysis_server_not_ready')
        if not health.get('vlm_configured'):raise RuntimeError('MiniCPM is not configured')
        for path in sorted(args.video_dir.glob('*.mp4')):
            if args.only and path.name!=args.only:continue
            print('Uploading',path.name,flush=True)
            with path.open('rb') as data:
                response=requests.post(base+'/v1/videos?camera_id=test-camera',headers=headers,files={'video':(path.name,data,'video/mp4')},timeout=60)
            response.raise_for_status();job_id=response.json()['id']
            deadline=time.monotonic()+700
            while time.monotonic()<deadline:
                result=requests.get(f'{base}/v1/videos/{job_id}',headers=headers,params={'limit':1000},timeout=10).json()
                if result['status'] in ('complete','failed','interrupted'):break
                time.sleep(1)
            else:raise TimeoutError(f'Video job {job_id} did not finish')
            result['deployment_url']=base
            result['video']=path.name;results.append(result)
            (args.output/f'{job_id}.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
            print(json.dumps({'video':path.name,'status':result['status'],
                'priority':result.get('result',{}).get('priority'),
                'fresh_successes':sum(x.get('mode')=='fresh' for x in result.get('inferences',[])),
                'recorded_attempts':len(result.get('inferences',[])),
                'errors':[x.get('error') for x in result.get('inferences',[]) if x.get('error')]}),flush=True)
        if args.websocket_video:
            print('Replaying over live WebSocket',args.websocket_video.name,flush=True)
            ws_result=asyncio.run(ws_replay(args.websocket_video,base.replace('http','ws')+'/v1/live',token))
            (args.output/'websocket.json').write_text(json.dumps(ws_result,indent=2),encoding='utf-8')
            print(json.dumps({'websocket_fresh_responses':ws_result['fresh_responses'],'events':len(ws_result['events'])}),flush=True)
        (args.output/'summary.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
    finally:
        if server:
            server.terminate()
            try:server.wait(10)
            except subprocess.TimeoutExpired:server.kill();server.wait()
        if log:log.close()
if __name__=='__main__':main()
