import base64
import io
import unittest
from PIL import Image
from analysis.frame_reader import decode_jpeg, VideoReader

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
if __name__=='__main__':unittest.main()
