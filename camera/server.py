"""Capture-only Pi substitute. Never imports a detector or vision model."""
import asyncio
import contextlib
import json
import os
import secrets
import struct
import threading
import time
import uuid
import html
import httpx
from pathlib import Path
from urllib.parse import urlparse
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse, Response, PlainTextResponse

CAPTURE_FPS=30
TRANSMIT_FPS=10

def valid_analysis_url(value):
    parsed=urlparse(value)
    return parsed.scheme=='wss' or parsed.scheme=='ws' and parsed.hostname in ('127.0.0.1','localhost','::1')

def local_hosts(port):
    hosts={f'{name}:{port}' for name in ('127.0.0.1','localhost','[::1]')}
    return hosts|{'127.0.0.1','localhost','[::1]'} if port==80 else hosts

class LocalHostOnly:
    # DNS rebinding guard: a hostile site's name resolving to 127.0.0.1 still sends its own Host header.
    def __init__(self,app,allowed):self.app=app;self.allowed=frozenset(allowed)
    async def __call__(self,scope,receive,send):
        if scope['type'] in ('http','websocket'):
            hosts=[value for key,value in scope['headers'] if key==b'host']
            if len(hosts)!=1 or hosts[0].decode('latin-1').lower() not in self.allowed:
                if scope['type']=='websocket':return await send({'type':'websocket.close','code':1008})
                return await PlainTextResponse('invalid_host',status_code=421)(scope,receive,send)
        await self.app(scope,receive,send)

def frame_packet(session,sequence,ts_ms,jpeg):
    meta=json.dumps({'session_id':session,'sequence':sequence,'ts_ms':ts_ms},separators=(',',':')).encode()
    return struct.pack('>I',len(meta))+meta+jpeg

class CaptureService:
    def __init__(self,url,token,camera_id):
        if not valid_analysis_url(url):raise ValueError('remote_analysis_requires_wss')
        self.url=url;self.token=token;self.camera_id=camera_id;self.ui_token=secrets.token_urlsafe(24)
        self.stop_event=threading.Event();self.lock=threading.Lock();self.latest=None
        self.thread=None;self.task=None;self.connection='stopped';self.error=None;self.result=None
        self.sent=0;self.captured=0;self.skipped_for_analysis=0;self.dropped=0;self.settings=None;self.capture=None
    def status(self):
        return {'connection':self.connection,'camera_id':self.camera_id,'error':self.error,
                'captured_frames':self.captured,'sent_frames':self.sent,
                'skipped_for_analysis':self.skipped_for_analysis,'dropped_frames':self.dropped,'settings':self.settings,
                'result':self.result,'running':bool(self.task and not self.task.done())}
    def capture_loop(self,index):
        import cv2
        cap=None
        try:
            cap=cv2.VideoCapture(index,cv2.CAP_DSHOW if os.name=='nt' else cv2.CAP_ANY);self.capture=cap
            cap.set(cv2.CAP_PROP_FRAME_WIDTH,640);cap.set(cv2.CAP_PROP_FRAME_HEIGHT,480);cap.set(cv2.CAP_PROP_FPS,CAPTURE_FPS)
            if not cap.isOpened():raise RuntimeError('camera_open_failed')
            self.settings={'width':int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), 'height':int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
                           'reported_fps':cap.get(cv2.CAP_PROP_FPS),'capture_fps':CAPTURE_FPS,
                           'transmit_fps':TRANSMIT_FPS,'jpeg_quality':80}
            sequence=0
            while not self.stop_event.is_set():
                started=time.monotonic();ok,frame=cap.read();timestamp=time.time_ns()//1000000
                if not ok:raise RuntimeError('camera_read_failed')
                # Full frame, unchanged geometry; JPEG is the only transformation.
                ok,data=cv2.imencode('.jpg',frame,[cv2.IMWRITE_JPEG_QUALITY,80])
                if not ok:raise RuntimeError('camera_encode_failed')
                sequence+=1;self.captured=sequence
                with self.lock:self.latest=(sequence,timestamp,data.tobytes())
                self.stop_event.wait(max(0,1/CAPTURE_FPS-(time.monotonic()-started)))
        except Exception as exc:
            self.error=str(exc);self.connection='camera_error';self.stop_event.set()
        finally:
            if cap is not None:cap.release()
            self.capture=None
    async def network_loop(self):
        from websockets.asyncio.client import connect
        while not self.stop_event.is_set():
            session=uuid.uuid4().hex;sent_sequence=0;next_send=0
            try:
                self.connection='connecting'
                async with connect(self.url,additional_headers={'Authorization':f'Bearer {self.token}'},
                                   max_size=1024*1024,open_timeout=180,close_timeout=2,compression=None) as ws:
                    await ws.send(json.dumps({'type':'start','camera_id':self.camera_id,'session_id':session}))
                    ready=json.loads(await asyncio.wait_for(ws.recv(),5))
                    if ready.get('type')!='ready':raise RuntimeError(ready.get('error','start_rejected'))
                    self.connection='connected';self.error=None
                    async def receive():
                        async for raw in ws:
                            message=json.loads(raw)
                            if message.get('type')=='result':self.result=message
                            elif message.get('type')=='error':self.error=message.get('error')
                    receiver=asyncio.create_task(receive())
                    try:
                        while not self.stop_event.is_set():
                            if receiver.done():await receiver;raise RuntimeError('analysis_disconnected')
                            with self.lock:frame=self.latest
                            if (frame and frame[0]>sent_sequence and time.time()*1000-frame[1]<=1000
                                    and time.monotonic()>=next_send):
                                if sent_sequence:self.skipped_for_analysis+=max(0,frame[0]-sent_sequence-1)
                                await asyncio.wait_for(ws.send(frame_packet(session,*frame)),2)
                                sent_sequence=frame[0];self.sent+=1;next_send=time.monotonic()+1/TRANSMIT_FPS
                            await asyncio.sleep(.01)
                    finally:
                        receiver.cancel()
                        with contextlib.suppress(asyncio.CancelledError,Exception):await receiver
            except asyncio.CancelledError:break
            except Exception as exc:
                self.connection='unavailable';self.error=type(exc).__name__
                if self.result:self.result={**self.result,'priority':{'level':'unknown','label':'Analysis connection unavailable'}}
                await asyncio.sleep(1)
        if self.connection!='camera_error':self.connection='stopped'
    async def start(self,index=0):
        if self.thread and self.thread.is_alive():raise ValueError('camera_already_running')
        if self.task and not self.task.done():raise ValueError('camera_already_running')
        self.stop_event.clear();self.error=None;self.result=None;self.latest=None
        self.sent=0;self.captured=0;self.skipped_for_analysis=0;self.dropped=0
        self.thread=threading.Thread(target=self.capture_loop,args=(index,),daemon=True);self.thread.start()
        self.task=asyncio.create_task(self.network_loop())
    async def stop(self):
        self.stop_event.set()
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):await self.task
            self.task=None
        if self.thread:await asyncio.to_thread(self.thread.join,3)
        self.connection='stopped'
        if self.result:self.result={**self.result,'priority':{'level':'unknown','label':'Camera stopped'}}

def create_app(service,http_transport=None,port=8001):
    remote=urlparse(service.url)
    http_base=('https' if remote.scheme=='wss' else 'http')+'://'+remote.netloc
    @asynccontextmanager
    async def lifespan(app):
        yield
        await service.stop()
    app=FastAPI(lifespan=lifespan,docs_url=None,redoc_url=None);app.add_middleware(LocalHostOnly,allowed=local_hosts(port))
    @app.get('/',response_class=HTMLResponse)
    async def page():
        nonce=secrets.token_urlsafe(16)
        csp=(f"default-src 'self'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; img-src 'self' blob: data:; "
             "connect-src 'self'; frame-ancestors 'none'")
        return HTMLResponse(Path(__file__).with_name('index.html').read_text(encoding='utf-8')
                            .replace('__CSP_NONCE__',nonce).replace('__CONTROL_TOKEN__',service.ui_token)
                            .replace('__HTTP_ENDPOINT__',html.escape(http_base+'/v1/videos')),
                            headers={'Cache-Control':'no-store','X-Frame-Options':'DENY','Content-Security-Policy':csp})
    def authorize(request):
        if not secrets.compare_digest(request.headers.get('x-local-control',''),service.ui_token):raise HTTPException(403,'local_control_required')
    @app.get('/status')
    async def status(request:Request):authorize(request);return service.status()
    @app.get('/preview.jpg')
    async def preview(request:Request):
        authorize(request)
        with service.lock:frame=service.latest
        if not frame:return Response(status_code=204)
        return Response(frame[2],media_type='image/jpeg',headers={'Cache-Control':'no-store'})
    async def proxy(method,path,content=None,content_type=None,params=None,content_length=None):
        headers={'Authorization':'Bearer '+service.token}
        if content_type:headers['content-type']=content_type
        if content_length is not None:headers['content-length']=str(content_length)
        try:
            async with httpx.AsyncClient(transport=http_transport,timeout=180,follow_redirects=False) as client:
                async with client.stream(method,http_base+path,headers=headers,params=params,content=content) as response:
                    data=bytearray()
                    async for chunk in response.aiter_bytes():
                        data.extend(chunk)
                        if len(data)>4*1024*1024:raise HTTPException(502,'analysis_response_too_large')
                    try:json.loads(data)
                    except (ValueError,UnicodeDecodeError):raise HTTPException(502,'invalid_analysis_response')
                    return Response(bytes(data),status_code=response.status_code,media_type='application/json',headers={'Cache-Control':'no-store'})
        except httpx.TimeoutException:raise HTTPException(504,'analysis_request_timed_out')
        except httpx.RequestError:raise HTTPException(502,'analysis_service_unavailable')
    @app.post('/videos')
    async def upload_video(request:Request):
        authorize(request)
        content_type=request.headers.get('content-type','')
        if not content_type.lower().startswith('multipart/form-data;'):raise HTTPException(415,'multipart_video_required')
        # Stream bytes without loading a large recording into RAM or exposing the remote token.
        limit=250*1024*1024+64*1024
        length=request.headers.get('content-length')
        if length is None:raise HTTPException(411,'content_length_required')
        try:size=int(length)
        except ValueError:raise HTTPException(400,'invalid_content_length')
        if size<0:raise HTTPException(400,'invalid_content_length')
        if size>limit:raise HTTPException(413,'video_too_large')
        async def chunks():
            received=0
            async for chunk in request.stream():
                received+=len(chunk)
                if received>limit:raise HTTPException(413,'video_too_large')
                yield chunk
        return await proxy('POST','/v1/videos',chunks(),content_type,{'camera_id':service.camera_id},size)
    @app.get('/videos/{job_id}')
    async def video_result(job_id:str,request:Request):
        authorize(request)
        try:
            if str(uuid.UUID(job_id))!=job_id:raise ValueError()
        except ValueError:raise HTTPException(422,'invalid_job_id')
        return await proxy('GET','/v1/videos/'+job_id,params={'limit':100})
    @app.post('/start')
    async def start(request:Request):
        authorize(request)
        value=await request.json();index=value.get('camera_index',0)
        if type(index) is not int or not 0<=index<=16:raise HTTPException(422,'invalid_camera_index')
        try:await service.start(index)
        except ValueError as exc:raise HTTPException(409,str(exc))
        return service.status()
    @app.post('/stop')
    async def stop(request:Request):
        authorize(request);await service.stop();return service.status()
    return app

def main():
    import uvicorn
    token=os.environ.get('FIREGUARD_TOKEN')
    if not token:raise SystemExit('FIREGUARD_TOKEN is required')
    service=CaptureService(os.environ.get('ANALYSIS_WS_URL','ws://127.0.0.1:8002/v1/live'),token,os.environ.get('CAMERA_ID','test-camera'))
    port=int(os.environ.get('CAMERA_PORT','8001'))
    uvicorn.run(create_app(service,port=port),host='127.0.0.1',port=port,log_level='warning')
if __name__=='__main__':main()
