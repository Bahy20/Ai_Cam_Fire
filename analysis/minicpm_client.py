"""Private authenticated Modal RPC bridge. Never exposes an HTTP model endpoint."""
import json,sys,signal
import modal

active_call=None

def invoke(model,op,frames,timeout):
    global active_call
    active_call=model.ready.spawn() if op=='warmup' else model.analyze.spawn(frames)
    try:return active_call.get(timeout=timeout)
    except BaseException:
        active_call.cancel()
        raise
    finally:active_call=None

def stop(signum,frame):
    if active_call is not None:active_call.cancel()
    raise SystemExit(0)

def main():
    signal.signal(signal.SIGTERM,stop)
    model=modal.Cls.from_name('fireguard-analysis','Vision')()
    for line in sys.stdin:
        request={}
        try:
            if len(line)>9*1024*1024:raise ValueError('minicpm_request_too_large')
            request=json.loads(line)
            if request['op'] not in {'warmup','analyze'}:raise ValueError('minicpm_invalid_operation')
            timeout=min(175,max(1,request.get('timeout_ms',29000)/1000))
            result=invoke(model,request['op'],request.get('frames',[]),timeout)
            response={'id':request['id'],'result':result}
        except Exception as exc:
            # No stack traces/provider response/credentials in the wire error.
            message=str(exc)
            code='minicpm_timeout' if isinstance(exc,(TimeoutError,modal.exception.TimeoutError)) else message if message.startswith('minicpm_') and len(message)<180 else 'minicpm_remote_failure'
            response={'id':request.get('id'),'error':code}
        print(json.dumps(response),flush=True)

if __name__=='__main__':main()
