"""Authenticated persistent WSS session around native duplex inference."""
import asyncio,contextlib,hmac,io,json,re,struct,time
from PIL import Image

# Bounded session length; on reaching it the client is told to reconnect (1012 service restart).
SESSION_LIMIT_S=600

def decode_packet(data,session_id):
    if not isinstance(data,bytes) or not 8<=len(data)<=2*1024*1024:raise ValueError('native_frame_size')
    size=struct.unpack('>I',data[:4])[0]
    if not 2<=size<=4096 or size+8>len(data):raise ValueError('native_frame_header')
    meta=json.loads(data[4:4+size]);jpeg=data[4+size:]
    if set(meta)!={'session_id','sequence','ts_ms'} or meta['session_id']!=session_id:raise ValueError('native_frame_session')
    if type(meta['sequence']) is not int or meta['sequence']<1 or type(meta['ts_ms']) is not int:raise ValueError('native_frame_metadata')
    if not -1000<=int(time.time()*1000)-meta['ts_ms']<=5000:raise ValueError('native_frame_stale')
    if not jpeg.startswith(b'\xff\xd8') or not jpeg.endswith(b'\xff\xd9'):raise ValueError('native_frame_jpeg')
    return {**meta,'jpeg':jpeg}

def create_app(session_factory,token,info=None,inference_context=contextlib.nullcontext,engine='minicpm-native-duplex',mode='native_duplex',session_limit_s=SESSION_LIMIT_S):
    from fastapi import FastAPI,WebSocket,WebSocketDisconnect
    if not token:raise ValueError('native_service_token_required')
    app=FastAPI();lock=asyncio.Lock()

    @app.get('/health')
    async def health():return {'ok':True,'engine':engine,'mode':mode,'session_active':lock.locked(),**(info or {})}

    def start_session(sid):
        with inference_context():return session_factory(sid)

    def process(session,packet):
        image=Image.open(io.BytesIO(packet['jpeg']))
        if image.width*image.height>1920*1080:raise ValueError('native_image_dimensions')
        image=image.convert('RGB');image.thumbnail((640,480))
        with inference_context():result=session.push(image,packet)
        result['frame_wh']=list(image.size)
        return result

    @app.websocket('/v1/stream')
    async def stream(ws:WebSocket):
        if not hmac.compare_digest(ws.headers.get('authorization',''),f'Bearer {token}'):
            await ws.close(code=1008);return
        if lock.locked():
            await ws.accept();await ws.close(code=1013,reason='Previous live inference is finishing');return
        await lock.acquire();reader=None;worker=None;session=None;close_code,close_reason=1000,None
        closed=asyncio.Event();available=asyncio.Event();latest=None;received=0;dropped=0
        try:
            await ws.accept()
            control=await asyncio.wait_for(ws.receive_json(),15)
            if not isinstance(control,dict) or set(control)!={'type','session_id'} or control['type']!='start' or not isinstance(control['session_id'],str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}',control['session_id']):raise ValueError('native_invalid_start')
            sid=control['session_id']
            session=await asyncio.to_thread(start_session,sid)
            await ws.send_json({'type':'native_ready','engine':engine,'session_id':sid,'mode':mode,'context_reset':True})

            async def read():
                nonlocal latest,received,dropped
                last_sequence=0;last_ts=-1
                try:
                    while not closed.is_set():
                        packet=decode_packet(await ws.receive_bytes(),sid)
                        if packet['sequence']<=last_sequence or packet['ts_ms']<=last_ts:raise ValueError('native_frame_order')
                        last_sequence=packet['sequence'];last_ts=packet['ts_ms'];received+=1
                        if latest is not None:dropped+=1
                        latest=packet;available.set()
                finally:closed.set();available.set()

            async def consume():
                nonlocal latest
                while not closed.is_set():
                    await available.wait();available.clear()
                    packet=latest;latest=None
                    if closed.is_set():return
                    if packet is None:continue
                    if int(time.time()*1000)-packet['ts_ms']>5000:continue
                    started=time.monotonic()
                    result=await asyncio.to_thread(process,session,packet)
                    if closed.is_set():return
                    result.update(received_frames=received,dropped_frames=dropped)
                    await ws.send_json(result)
                    await asyncio.sleep(max(0,1-(time.monotonic()-started)))
            reader=asyncio.create_task(read());worker=asyncio.create_task(consume())
            done,_=await asyncio.wait([reader,worker],timeout=session_limit_s,return_when=asyncio.FIRST_COMPLETED)
            if not done:close_code,close_reason=1012,'session_rotation'
            for task in (reader,worker):
                if task.done() and not task.cancelled():task.result()
        except (WebSocketDisconnect,asyncio.TimeoutError):pass
        except Exception:
            with contextlib.suppress(Exception):await ws.send_json({'type':'native_error','error':'native_stream_failure'})
        finally:
            closed.set();available.set()
            if reader and not reader.done():reader.cancel()
            if reader:
                with contextlib.suppress(BaseException):await reader
            # Let the bounded inference step finish before another session can
            # reset shared KV state. Cancelling a thread would not stop CUDA.
            if worker and not worker.done():
                try:await asyncio.wait_for(asyncio.shield(worker),15)
                except asyncio.TimeoutError:
                    import os
                    os._exit(1)
                except Exception:pass
            if session and hasattr(session,'close'):session.close()
            elif session and hasattr(getattr(session,'duplex',None),'set_session_stop'):session.duplex.set_session_stop()
            with contextlib.suppress(Exception):await ws.close(code=close_code,reason=close_reason)
            lock.release()
    return app
