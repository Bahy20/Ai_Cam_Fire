import json
import struct
import unittest
import httpx
from camera.server import frame_packet, valid_analysis_url, create_app, CaptureService
from fastapi.testclient import TestClient
LOCAL='http://127.0.0.1:8001'

class CameraTests(unittest.TestCase):
    def test_http_upload_forwards_video_and_keeps_service_token_off_page(self):
        calls=[]
        def remote(request):
            calls.append(request)
            self.assertEqual(request.headers['authorization'],'Bearer service-secret')
            if request.method=='POST':
                self.assertEqual(str(request.url),'https://example.com/v1/videos?camera_id=test-camera')
                self.assertIn(b'video-bytes',request.content)
                self.assertIn('multipart/form-data',request.headers['content-type'])
                self.assertNotIn('transfer-encoding',request.headers)
                self.assertEqual(int(request.headers['content-length']),len(request.content))
                return httpx.Response(202,json={'id':'12345678-1234-1234-1234-123456789abc','status':'queued'})
            return httpx.Response(200,json={'id':'12345678-1234-1234-1234-123456789abc','status':'complete','result':{'priority':{'level':'monitor'}}})
        service=CaptureService('wss://example.com/v1/live','service-secret','test-camera')
        with TestClient(create_app(service,http_transport=httpx.MockTransport(remote)),base_url=LOCAL) as client:
            page=client.get('/').text
            self.assertNotIn('service-secret',page)
            self.assertIn('type="file"',page)
            self.assertEqual(client.post('/videos',files={'video':('clip.mp4',b'video-bytes')}).status_code,403)
            headers={'x-local-control':service.ui_token}
            response=client.post('/videos',headers=headers,files={'video':('clip.mp4',b'video-bytes','video/mp4')})
            self.assertEqual(response.status_code,202,response.text)
            result=client.get('/videos/'+response.json()['id'],headers=headers)
            self.assertEqual(result.json()['status'],'complete')
            self.assertEqual(client.get('/videos/'+response.json()['id']).status_code,403)
        self.assertEqual(len(calls),2)

    def test_http_proxy_preserves_busy_and_handles_connection_failure(self):
        service=CaptureService('wss://example.com/v1/live','key','test-camera')
        def remote(request):
            if request.method=='POST':return httpx.Response(409,json={'error':'video_job_busy'})
            raise httpx.ConnectError('private connection details',request=request)
        with TestClient(create_app(service,http_transport=httpx.MockTransport(remote)),base_url=LOCAL) as client:
            headers={'x-local-control':service.ui_token}
            response=client.post('/videos',headers=headers,files={'video':('clip.mp4',b'data')})
            self.assertEqual(response.status_code,409)
            self.assertEqual(response.json()['error'],'video_job_busy')
            response=client.get('/videos/12345678-1234-1234-1234-123456789abc',headers=headers)
            self.assertEqual(response.status_code,502)
            self.assertNotIn('private connection',response.text)
            self.assertEqual(client.get('/videos/invalid',headers=headers).status_code,422)

    def test_raw_frame_packet_has_no_analysis(self):
        packet=frame_packet('session',1,1000,b'jpeg')
        size=struct.unpack('>I',packet[:4])[0]
        self.assertEqual(json.loads(packet[4:4+size]),{'session_id':'session','sequence':1,'ts_ms':1000})
        self.assertEqual(packet[4+size:],b'jpeg')
    def test_remote_connection_requires_tls(self):
        self.assertTrue(valid_analysis_url('ws://127.0.0.1:8002/v1/live'))
        self.assertTrue(valid_analysis_url('wss://example.com/v1/live'))
        self.assertFalse(valid_analysis_url('ws://example.com/v1/live'))
        self.assertFalse(valid_analysis_url('file:///test'))
    def test_camera_never_loads_detector_and_start_is_protected(self):
        service=CaptureService('ws://127.0.0.1:8002/v1/live','key','test-camera')
        with TestClient(create_app(service),base_url=LOCAL) as client:
            self.assertEqual(client.get('/status').status_code,403)
            self.assertEqual(client.get('/status',headers={'x-local-control':service.ui_token}).status_code,200)
            self.assertEqual(client.post('/start',json={}).status_code,403)
            self.assertEqual(client.get('/').status_code,200)
        self.assertEqual(service.status()['connection'],'stopped')
    def test_rejects_foreign_host_headers_against_dns_rebinding(self):
        service=CaptureService('ws://127.0.0.1:8002/v1/live','key','test-camera');token={'x-local-control':service.ui_token}
        with TestClient(create_app(service,port=8001),base_url=LOCAL) as client:
            for host in ('evil.example','evil.example:8001','127.0.0.1','localhost:8002','127.0.0.1.evil.example:8001',''):
                for method,path in (('GET','/'),('GET','/status'),('GET','/preview.jpg'),('POST','/stop'),('POST','/start')):
                    response=client.request(method,path,headers={'host':host,**token},json={})
                    self.assertEqual(response.status_code,421,(host,path));self.assertEqual(response.text,'invalid_host')
                    self.assertNotIn(service.ui_token,response.text)
            self.assertEqual(service.status()['connection'],'stopped')
            for host in ('127.0.0.1:8001','localhost:8001','LOCALHOST:8001','[::1]:8001'):
                self.assertEqual(client.get('/',headers={'host':host}).status_code,200,host)
                self.assertEqual(client.get('/status',headers={'host':host,**token}).status_code,200,host)
                self.assertEqual(client.get('/preview.jpg',headers={'host':host,**token}).status_code,204,host)
        with TestClient(create_app(service,port=80),base_url='http://localhost') as client:
            self.assertEqual(client.get('/').status_code,200)
            self.assertEqual(client.get('/',headers={'host':'127.0.0.1:80'}).status_code,200)
            self.assertEqual(client.get('/',headers={'host':'evil.example'}).status_code,421)
    def test_page_headers_and_preview_requires_token(self):
        service=CaptureService('ws://127.0.0.1:8002/v1/live','key','test-camera');token={'x-local-control':service.ui_token}
        with TestClient(create_app(service),base_url=LOCAL) as client:
            first,second=client.get('/'),client.get('/')
            self.assertEqual(first.headers['cache-control'],'no-store');self.assertEqual(first.headers['x-frame-options'],'DENY')
            csp=first.headers['content-security-policy']
            for directive in ("default-src 'self'","img-src 'self' blob: data:","connect-src 'self'","frame-ancestors 'none'"):self.assertIn(directive,csp)
            nonce=csp.split("'nonce-")[1].split("'")[0]
            self.assertEqual(first.text.count(f'nonce="{nonce}"'),3);self.assertNotIn('__CSP_NONCE__',first.text)
            self.assertNotEqual(nonce,second.headers['content-security-policy'].split("'nonce-")[1].split("'")[0])
            self.assertIn(service.ui_token,first.text)
            self.assertEqual(client.get('/preview.jpg').status_code,403)
            self.assertEqual(client.get('/preview.jpg',headers={'x-local-control':'wrong'}).status_code,403)
            self.assertEqual(client.get('/preview.jpg',headers=token).status_code,204)
            service.latest=(1,0,b'jpeg-bytes')
            self.assertEqual(client.get('/preview.jpg').status_code,403)
            response=client.get('/preview.jpg',headers=token)
            self.assertEqual((response.status_code,response.content,response.headers['cache-control']),(200,b'jpeg-bytes','no-store'))
if __name__=='__main__':unittest.main()
