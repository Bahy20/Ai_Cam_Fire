import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
// One Python worker serves live quality checks and video decoding. A failed worker (timeout, exit, protocol or pipe
// error) rejects only its own in-flight requests and is replaced lazily on the next request; `closed` is set by close() only.
// So `closed` cannot show a crash loop: `restarts` counts respawns after the first spawn and `lastFailure` keeps the most
// recent worker failure ({code,at_ms}, kept after recovery; close() is not a failure) for /health.
export class FrameReader {
  constructor({python=process.env.FIREGUARD_PYTHON??resolve(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python'),
    script=resolve(root,'analysis/frame_reader.py'),spawn:spawnChild=spawn,timeoutMs=60000,restartDelayMs=1000}={}) {
    Object.assign(this,{python,script,spawnChild,timeoutMs,restartDelayMs});
    this.requests=new Map();this.nextId=0;this.closed=false;this.diagnostics='';this.child=null;this.spawnedAt=-Infinity;this.restartTimer=null;
    this.restarts=0;this.lastFailure=null;
    this.start();
  }
  // Every handler is bound to the child it was attached to, so events from a replaced child never touch its successor.
  // stderr stays unguarded on purpose: a dying worker's traceback is the most useful diagnostics text.
  start(){
    this.restartTimer=null;if(this.closed)return;if(this.spawnedAt>-Infinity)this.restarts++;this.spawnedAt=Date.now();let child;
    try{child=this.child=this.spawnChild(this.python,[this.script],{cwd:root,stdio:['pipe','pipe','pipe'],windowsHide:true});}
    catch{this.child=null;return this.fail(null,'frame_reader_start_failed');}
    child.stderr.on('data',bytes=>{this.diagnostics=(this.diagnostics+bytes.toString()).slice(-4096);});
    createInterface({input:child.stdout}).on('line',line=>{
      if(child!==this.child)return;
      try{const reply=JSON.parse(line),pending=this.requests.get(reply.id);if(!pending)return;
        this.requests.delete(reply.id);clearTimeout(pending.timer);
        reply.error?pending.reject(new Error(reply.error)):pending.resolve(reply.result);
      }catch{this.fail(child,'frame_reader_protocol_error');}
    });
    child.on('error',()=>this.fail(child,'frame_reader_start_failed'));
    child.on('exit',()=>this.fail(child,'frame_reader_exited'));
    child.stdin.on('error',()=>this.fail(child,'frame_reader_pipe_failed'));
    for(const job of this.requests.values())this.send(child,job);
  }
  send(child,job){job.timer=setTimeout(()=>this.fail(child,'frame_reader_timeout'),this.timeoutMs);child.stdin.write(job.line);}
  rejectAll(code){for(const job of this.requests.values()){clearTimeout(job.timer);job.reject(new Error(code));}this.requests.clear();}
  fail(child,code){if(child!==this.child)return;this.child=null;child?.kill();this.lastFailure={code,at_ms:Date.now()};this.rejectAll(code);}
  // Backoff: at most one spawn per restartDelayMs. A request arriving sooner waits (queued, its timeout not yet running,
  // still counted toward the limit of 8) until the delayed spawn, rather than being rejected.
  respawn(){
    if(this.restartTimer)return;const wait=this.spawnedAt+this.restartDelayMs-Date.now();
    if(wait>0)this.restartTimer=setTimeout(()=>this.start(),wait);else this.start();
  }
  request(op,args={}) {
    if(this.closed)return Promise.reject(new Error('frame_reader_unavailable'));
    if(this.requests.size>=8)return Promise.reject(new Error('frame_reader_overloaded'));
    if(this.child?.killed)this.fail(this.child,'frame_reader_exited');
    const id=++this.nextId,line=JSON.stringify({id,op,...args})+'\n';
    return new Promise((resolve,reject)=>{
      const job={resolve,reject,line,timer:null};this.requests.set(id,job);
      if(this.child)this.send(this.child,job);else this.respawn();
    });
  }
  infer(image_b64){return this.request('infer',{image_b64});}
  open(path){return this.request('video_open',{path});}
  next(){return this.request('video_next');}
  closeVideo(){return this.request('video_close');}
  warmup(){return this.request('warmup');}
  close(){this.closed=true;clearTimeout(this.restartTimer);this.restartTimer=null;this.child?.kill();this.child=null;this.rejectAll('frame_reader_closed');}
}
