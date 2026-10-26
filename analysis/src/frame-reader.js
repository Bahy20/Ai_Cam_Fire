import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
export class FrameReader {
  constructor({python=process.env.FIREGUARD_PYTHON??resolve(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python')}={}) {
    this.child=spawn(python,[resolve(root,'analysis/frame_reader.py')],{cwd:root,stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.requests=new Map();this.nextId=0;this.closed=false;this.diagnostics='';
    this.child.stderr.on('data',bytes=>{this.diagnostics=(this.diagnostics+bytes.toString()).slice(-4096);});
    createInterface({input:this.child.stdout}).on('line',line=>{
      try{const reply=JSON.parse(line),pending=this.requests.get(reply.id);if(!pending)return;
        this.requests.delete(reply.id);clearTimeout(pending.timer);
        reply.error?pending.reject(new Error(reply.error)):pending.resolve(reply.result);
      }catch{this.fail('frame_reader_protocol_error');}
    });
    this.child.on('error',()=>this.fail('frame_reader_start_failed'));
    this.child.on('exit',()=>this.fail('frame_reader_exited'));
    this.child.stdin.on('error',()=>this.fail('frame_reader_pipe_failed'));
  }
  fail(code){this.closed=true;for(const job of this.requests.values()){clearTimeout(job.timer);job.reject(new Error(code));}this.requests.clear();}
  request(op,args={}) {
    if(this.closed)return Promise.reject(new Error('frame_reader_unavailable'));
    if(this.requests.size>=8)return Promise.reject(new Error('frame_reader_overloaded'));
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.fail('frame_reader_timeout');this.child.kill();},60000);
      this.requests.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,op,...args})+'\n');
    });
  }
  infer(image_b64){return this.request('infer',{image_b64});}
  open(path){return this.request('video_open',{path});}
  next(){return this.request('video_next');}
  closeVideo(){return this.request('video_close');}
  warmup(){return this.request('warmup');}
  close(){this.fail('frame_reader_closed');this.child.kill();}
}
