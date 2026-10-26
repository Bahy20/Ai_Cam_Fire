"""Single-flight background uploader for the durable V2 metadata spool."""
import queue
import json
import threading
import time

try:
    from .agent import observation_batch_hash
except ImportError:
    from agent import observation_batch_hash


class ObservationUploader:
    """Upload frozen batches off the capture thread and persist each ACK first."""

    def __init__(self, spool, transport, camera_id, state_path, *, clock_mode,
                 max_samples=6, retry_delay=.25, max_retry_delay=5., clock=time.monotonic):
        if clock_mode not in ('live', 'replay'):
            raise ValueError('invalid_clock_mode')
        self.spool, self.transport, self.camera_id = spool, transport, camera_id
        self.state_path, self.clock_mode = state_path, clock_mode
        self.max_samples = max_samples
        self.retry_delay, self.max_retry_delay, self.clock = retry_delay, max_retry_delay, clock
        self.acks = queue.Queue()
        self.wakeup = threading.Event()
        self.thread = threading.Thread(target=self._run, name='fireguard-v2-uploader', daemon=True)
        self._flush = False
        self._stopping = False
        self._deadline = None
        self._activated = False
        self._error_count = 0
        self._last_error = None
        self.thread.start()

    def notify(self):
        self.wakeup.set()

    def drain_acks(self):
        values = []
        while True:
            try:
                values.append(self.acks.get_nowait())
            except queue.Empty:
                return values

    def flush_and_stop(self, timeout=10.):
        self._flush = True
        self._stopping = True
        self._deadline = self.clock() + max(0., timeout)
        self.notify()
        self.thread.join(timeout=max(0., timeout) + .25)
        return {'stopped': not self.thread.is_alive(), 'pending_samples': self.spool.snapshot()['pending_samples'],
                'pending_batches': self.spool.snapshot()['pending_batches'],
                'transport_errors': self._error_count, 'last_error': self._last_error}

    def _wait(self, seconds):
        self.wakeup.wait(max(0., seconds))
        self.wakeup.clear()

    def _run(self):
        backoff = self.retry_delay
        while True:
            if self._stopping and self.clock() >= self._deadline:
                return
            if not self._activated:
                try:
                    self.transport.activate(self.camera_id, self.state_path)
                    self._activated = True
                    backoff = self.retry_delay
                except Exception:
                    self._error_count += 1
                    self._last_error = 'session_activation_failed'
                    self._wait(backoff)
                    backoff = min(self.max_retry_delay, max(self.retry_delay, backoff * 2))
                    continue
            try:
                batch = self.spool.seal_batch(self.clock_mode, observation_batch_hash,
                    max_samples=self.max_samples, force=self._flush)
                if batch is None:
                    if self._stopping and self.spool.snapshot()['pending_samples'] == 0:
                        return
                    self._wait(.1)
                    continue
                ack = self.transport.send_batch(batch)
                self.spool.acknowledge(ack)
                self.acks.put(ack)
                backoff = self.retry_delay
            except Exception:
                self._error_count += 1
                self._last_error = 'batch_upload_failed'
                self._wait(backoff)
                backoff = min(self.max_retry_delay, max(self.retry_delay, backoff * 2))


class EvidenceUploader:
    """Independent one-in-flight image lane with a hard 32 MiB handoff cap."""

    def __init__(self, transport, *, max_queue_bytes=32*1024*1024,
                 retry_delay=.5, max_retry_delay=5., clock=time.monotonic):
        self.transport=transport
        self.max_queue_bytes=max_queue_bytes
        self.retry_delay,self.max_retry_delay,self.clock=retry_delay,max_retry_delay,clock
        self.queue=queue.Queue(maxsize=4)
        self.acks=queue.Queue()
        self.wakeup=threading.Event()
        self._lock=threading.Lock()
        self._pending_bytes=0
        self._request_ids=set()
        self._errors=0
        self._stopping=False
        self._deadline=None
        self.thread=threading.Thread(target=self._run,name='fireguard-evidence-uploader',daemon=True)
        self.thread.start()

    def enqueue(self,body):
        try: size=len(json.dumps(body,separators=(',',':'),ensure_ascii=False).encode('utf-8'))
        except Exception: return False
        request_id=body.get('request_id') if isinstance(body,dict) else None
        if size>8*1024*1024 or not isinstance(request_id,str): return False
        with self._lock:
            if request_id in self._request_ids: return True
            if self._pending_bytes+size>self.max_queue_bytes: return False
            try: self.queue.put_nowait((body,size,request_id))
            except queue.Full: return False
            self._pending_bytes+=size
            self._request_ids.add(request_id)
        self.wakeup.set()
        return True

    def drain_acks(self):
        values=[]
        while True:
            try: values.append(self.acks.get_nowait())
            except queue.Empty: return values

    def flush_and_stop(self,timeout=10.):
        self._stopping=True
        self._deadline=self.clock()+max(0.,timeout)
        self.wakeup.set()
        self.thread.join(max(0.,timeout)+.25)
        with self._lock: pending=self._pending_bytes
        return {'stopped':not self.thread.is_alive(),'pending_bytes':pending,'transport_errors':self._errors}

    def _run(self):
        backoff=self.retry_delay
        while True:
            if self._stopping and self.clock()>=self._deadline: return
            try: item=self.queue.get(timeout=.1)
            except queue.Empty:
                if self._stopping:
                    with self._lock:
                        if self._pending_bytes==0: return
                self.wakeup.wait(.05);self.wakeup.clear()
                continue
            body,size,request_id=item
            while True:
                if self._stopping and self.clock()>=self._deadline:
                    try: self.queue.put_nowait(item)
                    except queue.Full: pass
                    return
                try:
                    ack=self.transport.send_pack(body)
                    self.acks.put(ack)
                    with self._lock:
                        self._pending_bytes-=size
                        self._request_ids.discard(request_id)
                    backoff=self.retry_delay
                    break
                except Exception:
                    self._errors+=1
                    self.wakeup.wait(backoff);self.wakeup.clear()
                    backoff=min(self.max_retry_delay,max(self.retry_delay,backoff*2))

