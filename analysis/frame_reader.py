"""Private line-delimited RPC worker: bounded decode and pixel quality only."""
import base64
import contextlib
import io
import json
import math
import sys
from collections import OrderedDict
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
MAX_PIXELS=1920*1080
# Provisional until the labelled webcam set calibrates them: measured on test_images and synthetic blur/grain/darkening.
DETAIL_WIDTH=640;DETAIL_MIN_SIDE=32;LOW_DETAIL_LAPLACIAN_VAR=50.;LOW_DETAIL_NOISE_SIGMA=3.5
# Provisional until the labelled webcam set calibrates them: measured on synthetic pans versus local motion.
MOTION_WIDTH=160;MOTION_SHIFT=.06;MOTION_RESPONSE=.1;MOTION_TILE_RESPONSE=.15;MOTION_MAX_GAP_MS=1500;MOTION_STREAMS=4;MOTION_MIN_SIDE=32;MOTION_MAX_ASPECT=4
IMMERKAER=((1,-2,1),(-2,4,-2),(1,-2,1))

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

def view_detail(frame):
    """Blur and grain measured on a fixed-width downscale (never upscaled), so thresholds do not depend on resolution."""
    import cv2
    import numpy as np
    height,width=frame.shape[:2]
    # The downscale only ever shrinks (output <= MAX_PIXELS); a strip too thin for 16 px grain blocks is not measured.
    if min(height,width)<DETAIL_MIN_SIDE:raise ValueError('view_too_small')
    gray=cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY)
    if width>DETAIL_WIDTH:gray=cv2.resize(gray,(DETAIL_WIDTH,max(1,round(height*DETAIL_WIDTH/width))),interpolation=cv2.INTER_AREA)
    # Grain inflates Laplacian variance; a 3x3 median removes pixel grain but keeps edges, so grain cannot hide blur.
    laplacian=float(cv2.Laplacian(cv2.medianBlur(gray,3),cv2.CV_64F).var())
    # Immerkaer: the kernel cancels smooth structure and sqrt(pi/2)/6*mean|response| estimates noise sigma (interior pixels).
    response=np.abs(cv2.filter2D(gray.astype(np.float64),-1,np.array(IMMERKAER,dtype=np.float64)))[1:-1,1:-1]*(math.sqrt(math.pi/2)/6)
    rows,cols=response.shape[0]//16,response.shape[1]//16
    if not rows or not cols:raise ValueError('view_too_small')
    # Texture raises the response too, but grain covers every block: the flattest tenth of 16 px blocks measures grain.
    blocks=response[:rows*16,:cols*16].reshape(rows,16,cols,16).mean(axis=(1,3))
    noise=float(np.percentile(blocks,10))
    return {'detail_laplacian_var':laplacian,'noise_sigma':noise,'noise_sigma_global':float(response.mean()),
        'low_detail':laplacian<LOW_DETAIL_LAPLACIAN_VAR or noise>LOW_DETAIL_NOISE_SIGMA}

def global_shift(previous,current):
    """True only for a confident large shift of the whole view; False when confidently small; None when unknown."""
    import cv2
    import numpy as np
    def correlate(a,b):
        a,b=np.ascontiguousarray(a),np.ascontiguousarray(b)
        (dx,dy),response=cv2.phaseCorrelate(a,b,cv2.createHanningWindow((a.shape[1],a.shape[0]),cv2.CV_32F))
        return dx,dy,response
    dx,dy,response=correlate(previous,current);shift=math.hypot(dx,dy);height,width=current.shape
    metrics={'motion_shift_px':shift,'motion_response':response}
    if not math.isfinite(shift) or not math.isfinite(response) or response<MOTION_RESPONSE:return None,metrics
    if shift<=MOTION_SHIFT*min(height,width):return False,metrics
    # A person walking past or moving smoke/flame shifts only part of the view and can still dominate the whole-frame peak
    # (response .2-.7 in the experiment), so every quadrant must independently see the same shift.
    h,w=height//2,width//2
    for y in (0,h):
        for x in (0,w):
            tdx,tdy,tile=correlate(previous[y:y+h,x:x+w],current[y:y+h,x:x+w])
            if not tile>=MOTION_TILE_RESPONSE or not math.hypot(tdx-dx,tdy-dy)<=max(1.5,.25*shift):return None,metrics
    return True,metrics

class MotionTracker:
    """Previous small grey frame per stream (session or job id), bounded to the most recent streams."""
    def __init__(self):self.streams=OrderedDict()
    def update(self,stream,ts_ms,frame):
        if not isinstance(stream,str) or not 0<len(stream)<=128:return None,{}
        ts=ts_ms if isinstance(ts_ms,int) and not isinstance(ts_ms,bool) and ts_ms>=0 else None
        previous=self.streams.pop(stream,None)
        try:
            import cv2
            import numpy as np
            height,width=frame.shape[:2]
            # A fixed width would enlarge a thin strip (1x1920 becomes 160x307200 floats), and a strip shows no view anyway.
            if min(height,width)<MOTION_MIN_SIDE or max(height,width)>MOTION_MAX_ASPECT*min(height,width):return None,{}
            gray=cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY)
            small=cv2.resize(gray,(MOTION_WIDTH,max(1,round(height*MOTION_WIDTH/width))),interpolation=cv2.INTER_AREA).astype(np.float32)
            self.streams[stream]=(ts,small)
            while len(self.streams)>MOTION_STREAMS:self.streams.popitem(last=False)
            if previous is None or ts is None or previous[0] is None or previous[1].shape!=small.shape or \
                not 0<ts-previous[0]<=MOTION_MAX_GAP_MS:return None,{}
            return global_shift(previous[1],small)
        except Exception:
            self.streams.pop(stream,None);return None,{}

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
    video=None;motion=MotionTracker()
    for line in sys.stdin:
        request={}
        try:
            if len(line)>4*1024*1024:raise ValueError('rpc_too_large')
            request=json.loads(line);op=request['op']
            with contextlib.redirect_stdout(sys.stderr):
                if op=='infer':
                    frame=decode_jpeg(request['image_b64']);height,width=frame.shape[:2]
                    quality=assess_frame_quality(frame);reasons=list(quality['reasons'])
                    camera_motion,motion_metrics=motion.update(request.get('stream'),request.get('ts_ms'),frame)
                    try:detail=view_detail(frame)
                    except Exception:detail={'low_detail':None}
                    low_detail=detail.pop('low_detail')
                    if low_detail:reasons.append('low_detail_view')
                    result={'frame_wh':[width,height],'visibility':quality['visibility'],'camera_motion':camera_motion,'low_detail':low_detail,
                        'metrics':{**quality['metrics'],**detail,**motion_metrics,'quality_reasons':reasons}}
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
