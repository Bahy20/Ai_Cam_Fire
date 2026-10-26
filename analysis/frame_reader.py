"""Private line-delimited RPC worker: bounded decode and pixel quality only."""
import base64
import contextlib
import io
import json
import math
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
MAX_PIXELS=1920*1080

def dimensions_ok(width,height):
    return min(width,height)>0 and max(width,height)<=1920 and width*height<=MAX_PIXELS

def decode_jpeg(encoded):
    import cv2
    import numpy as np
    from PIL import Image
    try:
        data=base64.b64decode(encoded,validate=True)
        if len(data)>2*1024*1024:raise ValueError('jpeg_too_large')
        with Image.open(io.BytesIO(data)) as image:
            if image.format!='JPEG' or not dimensions_ok(*image.size):raise ValueError('invalid_image_dimensions')
        decoded=cv2.imdecode(np.frombuffer(data,dtype=np.uint8),cv2.IMREAD_COLOR)
        if decoded is None:raise ValueError('jpeg_decode_failed')
        return decoded
    except Exception as exc:
        raise ValueError('invalid_jpeg_or_dimensions') from exc

class VideoReader:
    def __init__(self,path):
        import cv2
        self.cv=cv2;self.cap=cv2.VideoCapture(str(path));self.index=0;self.next_sample=0;self.last_ts=-1
        fps=float(self.cap.get(cv2.CAP_PROP_FPS));count=int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT))
        width=int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH));height=int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        if not self.cap.isOpened() or not math.isfinite(fps) or not 0<fps<=240 or count<1 or count/fps>600 or not dimensions_ok(width,height):
            self.cap.release();raise ValueError('invalid_video_metadata_or_limits')
        self.fps=fps;self.count=count
        self.info={'fps':fps,'frames':count,'duration_s':count/fps,'width':width,'height':height}
    def next(self):
        while True:
            ok,frame=self.cap.read()
            if not ok:
                self.cap.release()
                if self.index<self.count-2:raise ValueError('video_decode_incomplete')
                return {'eof':True,'decoded_frames':self.index}
            index=self.index;self.index+=1
            pts=float(self.cap.get(self.cv.CAP_PROP_POS_MSEC))
            ts=pts if math.isfinite(pts) and pts>self.last_ts else index*1000/self.fps
            self.last_ts=ts
            if ts>600000:raise ValueError('video_duration_limit')
            if ts+1e-3<self.next_sample:continue
            self.next_sample=math.floor(ts*3/1000+1)*1000/3
            ok,jpeg=self.cv.imencode('.jpg',frame,[self.cv.IMWRITE_JPEG_QUALITY,80])
            if not ok:raise ValueError('video_jpeg_encode_failed')
            return {'ts_ms':round(ts),'image_b64':base64.b64encode(jpeg.tobytes()).decode(), 'source_index':index}
    def close(self):self.cap.release()

def main():
    from edge.image_quality import assess_frame_quality
    video=None
    for line in sys.stdin:
        request={}
        try:
            if len(line)>4*1024*1024:raise ValueError('rpc_too_large')
            request=json.loads(line);op=request['op']
            with contextlib.redirect_stdout(sys.stderr):
                if op=='infer':
                    frame=decode_jpeg(request['image_b64']);height,width=frame.shape[:2]
                    quality=assess_frame_quality(frame)
                    result={'frame_wh':[width,height],'visibility':quality['visibility'],'camera_motion':None,
                        'metrics':{**quality['metrics'],'quality_reasons':quality['reasons']}}
                elif op=='video_open':
                    if video:video.close()
                    video=VideoReader(request['path']);result=video.info
                elif op=='video_next':
                    if not video:raise ValueError('video_not_open')
                    result=video.next()
                elif op=='video_close':
                    if video:video.close()
                    video=None;result={}
                elif op=='warmup':
                    result={'ready':True,'mode':'pixel_quality_only'}
                else:raise ValueError('unknown_rpc')
            print(json.dumps({'id':request['id'],'result':result}),flush=True)
        except Exception as exc:
            print(json.dumps({'id':request.get('id'),'error':str(exc)[:200]}),flush=True)
    if video:video.close()
if __name__=='__main__':main()
