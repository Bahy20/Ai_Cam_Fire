import base64
import io
import unittest
from PIL import Image
from analysis.frame_reader import decode_jpeg, VideoReader, MotionTracker, MOTION_STREAMS, view_detail

def scene(seed=0,w=760,h=560):
    """Sharp flat-shaded rectangles: high detail, no grain."""
    import cv2,numpy as np
    rng=np.random.default_rng(seed);img=np.full((h,w,3),120,np.uint8)
    for _ in range(160):
        x,y=int(rng.integers(0,w)),int(rng.integers(0,h))
        cv2.rectangle(img,(x,y),(x+int(rng.integers(8,70)),y+int(rng.integers(8,70))),tuple(int(v) for v in rng.integers(0,256,3)),-1)
    return img
def view(img,dx=0,dy=0):return img[60+dy:540+dy,60+dx:700+dx].copy()
def jpeg_b64(img):
    import cv2
    return base64.b64encode(cv2.imencode('.jpg',img,[cv2.IMWRITE_JPEG_QUALITY,80])[1].tobytes()).decode()

class DecodeTests(unittest.TestCase):
    def test_decode_bounds_before_raster_and_invalid_is_error(self):
        stream=io.BytesIO();Image.new('RGB',(640,480)).save(stream,format='JPEG')
        self.assertEqual(decode_jpeg(base64.b64encode(stream.getvalue()).decode()).shape,(480,640,3))
        with self.assertRaises(ValueError):decode_jpeg('broken')
        stream=io.BytesIO();Image.new('RGB',(2000,2000)).save(stream,format='JPEG')
        with self.assertRaises(ValueError):decode_jpeg(base64.b64encode(stream.getvalue()).decode())
    def test_corrupt_video_is_not_negative(self):
        with self.assertRaises(ValueError):VideoReader('does-not-exist.mp4')
    def test_rpc_only_measures_pixels_without_emitting_detections(self):
        import json,subprocess,sys
        from pathlib import Path
        stream=io.BytesIO();Image.new('RGB',(640,480)).save(stream,format='JPEG')
        request={'id':1,'op':'infer','image_b64':base64.b64encode(stream.getvalue()).decode()}
        root=Path(__file__).resolve().parents[2]
        result=subprocess.run([sys.executable,str(root/'analysis/frame_reader.py')],input=json.dumps(request)+'\n',
            text=True,capture_output=True,cwd=root,timeout=20,check=True)
        reply=json.loads(result.stdout)['result']
        self.assertNotIn('detections',reply)
        self.assertEqual(reply['visibility'],'degraded')
        self.assertIn('uniform_extreme_luminance',reply['metrics']['quality_reasons'])
        self.assertIsNone(reply['camera_motion']);self.assertIs(reply['low_detail'],True)
    def test_rpc_compares_consecutive_frames_of_the_same_stream_only(self):
        import json,subprocess,sys
        from pathlib import Path
        image=jpeg_b64(view(scene()))
        requests=[{'id':1,'op':'infer','image_b64':image},{'id':2,'op':'infer','image_b64':image,'stream':'a','ts_ms':1000},
            {'id':3,'op':'infer','image_b64':image,'stream':'a','ts_ms':1333},{'id':4,'op':'infer','image_b64':image,'stream':'b','ts_ms':1333},
            {'id':5,'op':'infer','image_b64':jpeg_b64(view(scene(),40)),'stream':'a','ts_ms':1666}]
        root=Path(__file__).resolve().parents[2]
        result=subprocess.run([sys.executable,str(root/'analysis/frame_reader.py')],input=''.join(json.dumps(r)+'\n' for r in requests),
            text=True,capture_output=True,cwd=root,timeout=20,check=True)
        replies=[json.loads(line)['result'] for line in result.stdout.splitlines()]
        self.assertEqual([r['camera_motion'] for r in replies],[None,None,False,None,True])
        for reply in replies:
            self.assertIs(reply['low_detail'],False);self.assertNotIn('low_detail_view',reply['metrics']['quality_reasons'])
            self.assertGreater(reply['metrics']['detail_laplacian_var'],0);self.assertIn('noise_sigma',reply['metrics'])

class CameraMotionTests(unittest.TestCase):
    def setUp(self):self.base=scene()
    def pair(self,first,second,gap=333,stream='cam'):
        tracker=MotionTracker();tracker.update(stream,1000,first);return tracker.update(stream,1000+gap,second)[0]
    def test_large_global_shift_is_camera_motion(self):
        for dx,dy in [(40,0),(0,-40),(32,20)]:self.assertIs(self.pair(view(self.base),view(self.base,dx,dy)),True,(dx,dy))
    def test_small_shift_and_static_view_are_not_motion(self):
        for dx in [0,4,12]:self.assertIs(self.pair(view(self.base),view(self.base,dx)),False,dx)
    def test_local_motion_never_reads_as_camera_motion(self):
        # A textured object (a person walking past) filling up to half the view moves 140 px over a static background.
        import cv2
        for size in [(240,200),(300,320)]:
            patch=cv2.resize(view(scene(5)),size);first,second=view(self.base),view(self.base)
            first[-size[1]:,20:20+size[0]]=patch;second[-size[1]:,160:160+size[0]]=patch
            self.assertIsNot(self.pair(first,second),True,size)
    def test_unknown_without_a_comparable_previous_frame(self):
        import cv2
        tracker=MotionTracker();frame=view(self.base)
        self.assertIsNone(tracker.update('cam',1000,frame)[0],'first frame')
        self.assertIsNone(tracker.update('cam',2600,frame)[0],'gap over 1500 ms')
        self.assertIsNone(tracker.update('cam',2500,frame)[0],'backwards timestamp')
        self.assertIsNone(tracker.update('cam',None,frame)[0],'missing timestamp')
        self.assertIsNone(tracker.update('cam',3000,frame)[0],'previous frame had no timestamp')
        self.assertIsNone(tracker.update('cam',3300,cv2.resize(frame,(640,360)))[0],'different dimensions')
        self.assertIsNone(tracker.update(None,3600,frame)[0],'no stream');self.assertIsNone(tracker.update(7,3600,frame)[0])
        self.assertIsNone(tracker.update('cam',3600,'not an image')[0],'measurement failure');self.assertNotIn('cam',tracker.streams)
    def test_streams_are_isolated_and_bounded(self):
        tracker=MotionTracker();tracker.update('a',1000,view(self.base));tracker.update('b',1000,view(self.base,40))
        self.assertIs(tracker.update('a',1333,view(self.base))[0],False,'compared with its own previous frame, not stream b')
        self.assertIs(tracker.update('b',1333,view(self.base))[0],True)
        for i in range(MOTION_STREAMS):tracker.update(f'other-{i}',1333,view(self.base))
        self.assertLessEqual(len(tracker.streams),MOTION_STREAMS);self.assertIsNone(tracker.update('a',1666,view(self.base))[0],'oldest evicted')
    def test_thin_or_extreme_aspect_frames_are_unknown_and_cheap(self):
        import time,numpy as np
        rng=np.random.default_rng(0)
        for w,h in [(1,1920),(1920,1),(31,640),(1920,400),(400,1920)]:
            a=rng.integers(0,255,(h,w,3),dtype=np.uint8);tracker=MotionTracker();started=time.monotonic()
            self.assertEqual(tracker.update('s',1000,a),(None,{}));self.assertEqual(tracker.update('s',1333,np.roll(a,1,axis=0)),(None,{}),(w,h))
            self.assertLess(time.monotonic()-started,.5,(w,h))
        import cv2
        wide=cv2.resize(view(self.base),(1600,400));tracker=MotionTracker();tracker.update('s',1000,wide)
        self.assertIs(tracker.update('s',1333,wide)[0],False,'a 4:1 view is still measured')

class ViewDetailTests(unittest.TestCase):
    def test_blur_and_grain_are_flagged_separately_but_a_sharp_view_is_not(self):
        import cv2,numpy as np
        sharp=view(scene());rng=np.random.default_rng(1)
        self.assertIs(view_detail(sharp)['low_detail'],False)
        blurred=view_detail(cv2.GaussianBlur(sharp,(0,0),3));self.assertIs(blurred['low_detail'],True)
        grainy=view_detail(np.clip(sharp+rng.normal(0,20,sharp.shape),0,255).astype(np.uint8))
        self.assertIs(grainy['low_detail'],True)
        self.assertGreater(grainy['detail_laplacian_var'],view_detail(sharp)['detail_laplacian_var']*.5,'grain is caught by the noise test, not as blur')
        self.assertGreater(grainy['noise_sigma'],5)
    def test_detail_is_measured_at_a_fixed_width(self):
        import cv2
        sharp=view(scene());large=cv2.resize(sharp,(1280,960),interpolation=cv2.INTER_CUBIC)
        self.assertIs(view_detail(large)['low_detail'],False)
        self.assertLess(abs(view_detail(large)['detail_laplacian_var']-view_detail(sharp)['detail_laplacian_var']),view_detail(sharp)['detail_laplacian_var']*.5)
    def test_thin_frames_are_bounded_and_not_measured(self):
        import time,numpy as np
        rng=np.random.default_rng(0)
        for w,h in [(1,1920),(1920,1),(4,1920),(1920,31),(1920,40)]:
            started=time.monotonic()
            with self.assertRaises(ValueError,msg=(w,h)):view_detail(rng.integers(0,255,(h,w,3),dtype=np.uint8))
            self.assertLess(time.monotonic()-started,.5,(w,h))
        self.assertIn('low_detail',view_detail(rng.integers(0,255,(1920,32,3),dtype=np.uint8)))
if __name__=='__main__':unittest.main()
