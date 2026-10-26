import WebSocket from 'ws';
import {encodeFrame} from './protocol.js';

export class NativeStream {
  constructor({url,token,sessionId,onResult=()=>{},onState=()=>{},allowLoopback=false,retryDelays=[250,500,1000,2000,3000,3000,3000,3000]}){
    const target=new URL(url);
    if(!(target.protocol==='https:' || target.protocol==='wss:' || allowLoopback && target.protocol==='ws:' && target.hostname==='127.0.0.1') ||
      target.username || target.password || target.search || target.hash || !['','/'].includes(target.pathname))throw new Error('native_url');
    if(!token)throw new Error('native_token_required');
    target.protocol=target.protocol==='https:'?'wss:':target.protocol;target.pathname='/v1/stream';
    Object.assign(this,{url:target.href,token,sessionId,onResult,onState,retryDelays});this.sent=new Map();this.closed=false;this.ready=false;this.latest=null;this.lastResult=0;this.retries=0;
  }
  open(){
    if(this.opening)return this.opening;
    this.onState('connecting');
    this.opening=new Promise((resolve,reject)=>{this.resolveReady=()=>{this.established=true;resolve();};this.rejectReady=reject;});
    this.deadline=Date.now()+180000;this.connect();return this.opening;
  }
  connect(){
      if(this.closed)return;
      const remaining=this.deadline-Date.now();
      if(remaining<=0){this.onState('unavailable');this.rejectReady(new Error('native_connect_timeout'));return;}
      this.sent.clear();
      const ws=this.ws=new WebSocket(this.url,{headers:{Authorization:`Bearer ${this.token}`},maxPayload:256*1024,perMessageDeflate:false,handshakeTimeout:remaining});
      let failed=false,socketError=null;
      const fail=(code)=>{
        if(failed||this.ws!==ws)return;failed=true;clearTimeout(this.connectTimer);this.ready=false;this.sent.clear();
        if(this.closed)return;
        // 1013: GPU busy draining; 1012: server-side session rotation; 1006: dropped link (not an auth denial).
        const transient=code===1013||code===1012||code===1006&&!/401|403/.test(socketError?.message??'');
        if(transient&&this.retries<this.retryDelays.length){
          if(this.established)this.deadline=Date.now()+180000;
          const delay=this.retryDelays[this.retries++];this.onState('reconnecting');
          this.retryTimer=setTimeout(()=>{this.retryTimer=null;this.connect();},delay);
        }else{this.onState('unavailable');this.rejectReady(new Error('native_connection_unavailable'));}
      };
      this.connectTimer=setTimeout(()=>{fail(1008);ws.terminate();},remaining);
      ws.on('error',error=>{socketError=error;});ws.on('close',fail);
      ws.on('open',()=>ws.send(JSON.stringify({type:'start',session_id:this.sessionId})));
      ws.on('message',bytes=>{
        try{
          const value=JSON.parse(bytes.toString());
          if(this.ws!==ws||this.closed||value.session_id!==this.sessionId || !['minicpm-native-duplex','minicpm-native-visual'].includes(value.engine))return;
          if(value.type==='native_ready'){
            this.engine=value.engine;this.ready=true;clearTimeout(this.connectTimer);this.onState('listening');this.resolveReady();
            if(this.latest){const frame=this.latest;this.latest=null;if(Date.now()-frame.ts_ms<5000)this.push(frame);}return;
          }
          if(value.engine!==this.engine||value.type!=='native_result' || !Number.isSafeInteger(value.sequence) || value.sequence<=this.lastResult ||
             this.sent.get(value.sequence)?.ts_ms!==value.source_ts_ms)return;
          this.lastResult=value.sequence;
          if(typeof value.text!=='string' || value.text.length>2048 || !Number.isSafeInteger(value.native_chunks))return;
          const evidence=value.assessment? [...this.sent.values()].find(f=>f.ts_ms===value.assessment_source_ts_ms):this.sent.get(value.sequence);
          if(value.assessment && (!evidence || value.assessment.frame_id!==`frame-${evidence.ts_ms}`))return;
          // Only a delivered result proves the session healthy and refills the retry budget; native_ready alone does not, so a
          // service that comes up and then crashes on its first inference still runs out of retries instead of looping forever.
          this.retries=0;this.onResult(value,evidence);
        }catch{this.onState('invalid_response');}
      });
  }
  push(frame){
    if(this.closed)return;
    if(!this.ready){this.latest=frame;return;}
    if(this.ws.readyState!==WebSocket.OPEN || this.ws.bufferedAmount>2*1024*1024)return;
    this.sent.set(frame.sequence,frame);
    while(this.sent.size>64)this.sent.delete(this.sent.keys().next().value);
    this.ws.send(encodeFrame({session_id:this.sessionId,sequence:frame.sequence,ts_ms:frame.ts_ms},frame.jpeg));
  }
  close(){this.closed=true;this.ready=false;this.latest=null;this.sent.clear();clearTimeout(this.connectTimer);clearTimeout(this.retryTimer);this.rejectReady?.(new Error('native_closed'));this.ws?.terminate();}
}
