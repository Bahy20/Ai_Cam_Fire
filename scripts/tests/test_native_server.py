import unittest,json,struct,time
from analysis.native_server import decode_packet,create_app
from analysis.native_stream import NativeSession
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from PIL import Image
import io

class FakeDuplex:
    def prepare(self,**kw):pass
    def streaming_prefill(self,**kw):return {'success':True}
    def streaming_generate(self,**kw):return {'text':'[0,0,0,0,0,0]','end_of_turn':True,'is_listen':False}

def packet(ts=None):
    meta={'session_id':'session','sequence':1,'ts_ms':ts or int(time.time()*1000)}
    im=Image.new('RGB',(32,32),'gray');out=io.BytesIO();im.save(out,format='JPEG')
    header=json.dumps(meta).encode();return struct.pack('>I',len(header))+header+out.getvalue()

class NativeServerTests(unittest.TestCase):
    def test_busy_gpu_uses_an_accepted_retryable_close_while_old_inference_drains(self):
        import threading
        started=threading.Event();release=threading.Event()
        class SlowSession(NativeSession):
            def push(self,*args):started.set();release.wait(3);return super().push(*args)
        app=create_app(lambda sid:SlowSession(FakeDuplex(),sid),'test-token')
        with TestClient(app) as client:
            with client.websocket_connect('/v1/stream',headers={'Authorization':'Bearer test-token'}) as old:
                old.send_json({'type':'start','session_id':'session'});old.receive_json();old.send_bytes(packet())
                self.assertTrue(started.wait(2));old.close()
                try:
                    with client.websocket_connect('/v1/stream',headers={'Authorization':'Bearer test-token'}) as new:
                        with self.assertRaises(WebSocketDisconnect) as failure:new.receive_json()
                        self.assertEqual(failure.exception.code,1013)
                finally:release.set()
    def test_session_cap_closes_with_service_restart_and_releases_the_gpu(self):
        app=create_app(lambda sid:NativeSession(FakeDuplex(),sid),'test-token',session_limit_s=0.2)
        with TestClient(app) as client:
            for _ in range(2):
                with client.websocket_connect('/v1/stream',headers={'Authorization':'Bearer test-token'}) as ws:
                    ws.send_json({'type':'start','session_id':'session'})
                    self.assertEqual(ws.receive_json()['type'],'native_ready')
                    with self.assertRaises(WebSocketDisconnect) as rotated:ws.receive_json()
                    self.assertEqual((rotated.exception.code,rotated.exception.reason),(1012,'session_rotation'))
            self.assertFalse(client.get('/health').json()['session_active'])
    def test_protocol_rejects_invalid_and_stale_frames(self):
        self.assertEqual(decode_packet(packet(),'session')['sequence'],1)
        for data in (b'invalid',packet(1000)):
            with self.assertRaises(ValueError):decode_packet(data,'session')
        with self.assertRaises(ValueError):decode_packet(packet(),'other')
    def test_authentication_and_real_websocket_session(self):
        app=create_app(lambda sid:NativeSession(FakeDuplex(),sid),'test-token')
        with TestClient(app) as client:
            with self.assertRaises(WebSocketDisconnect):
                with client.websocket_connect('/v1/stream'):pass
            with client.websocket_connect('/v1/stream',headers={'Authorization':'Bearer test-token'}) as ws:
                ws.send_json({'type':'start','session_id':'session'})
                self.assertEqual(ws.receive_json()['type'],'native_ready')
                ws.send_bytes(packet());value=ws.receive_json()
                self.assertEqual(value['engine'],'minicpm-native-duplex')
                self.assertEqual(value['assessment']['flame'],'not_observed')
                self.assertEqual(value['native_chunks'],1)

if __name__=='__main__':unittest.main()
