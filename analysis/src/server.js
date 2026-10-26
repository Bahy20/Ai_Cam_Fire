import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import { timingSafeEqual,randomUUID } from 'node:crypto';
import { createWriteStream,readFileSync } from 'node:fs';
import { mkdir,unlink,readdir,stat,open as openFile } from 'node:fs/promises';
import { join,resolve,extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from './store.js';
import { VlmCoordinator,POLICY_VERSION } from './vlm-coordinator.js';
import { FrameReader } from './frame-reader.js';
import { MiniCPM } from './minicpm.js';
import {NativeStream} from './native-stream.js';
import { decodeFrame,MAX_MESSAGE } from './protocol.js';
import {testerAccess} from './tester-access.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const cameraPattern=/^[A-Za-z0-9_-]{1,80}$/;
// Alert state worth an immediate snapshot: the hazard latch, the incident, and the latest operator review.
const criticalSignature=r=>JSON.stringify([Boolean(r.incident_history?.model_hazard),r.incident_id??null,
  r.incident_history?.last_review?.incident_id??null,r.incident_history?.last_review?.reviewed_at_ms??null]);
function authorized(request,token) {
  const actual=Buffer.from(request.headers.authorization??'');const expected=Buffer.from(`Bearer ${token}`);
  return actual.length===expected.length && timingSafeEqual(actual,expected);
}
// The H100 bearer and the tester-cookie key fall back to the service token unless set separately (empty counts as unset).
export function credentials(options={},env=process.env) {
  const token=options.token??env.FIREGUARD_TOKEN;
  if(!token)throw new Error('FIREGUARD_TOKEN is required');
  return {token,nativeToken:options.nativeToken||env.FIREGUARD_NATIVE_TOKEN||token,cookieSecret:options.cookieSecret||env.FIREGUARD_COOKIE_SECRET||token};
}
// Container signature each accepted extension must carry: an ISO-BMFF box type at bytes 4..7 or the RIFF/AVI header.
// MP4 and MOV share one demuxer, and QuickTime-structured files may open with a non-ftyp atom under either name.
const isoBox=h=>['ftyp','moov','mdat','wide','free','skip'].includes(h.toString('latin1',4,8));
const signatures={'.mp4':isoBox,'.mov':isoBox,
  '.avi':h=>h.toString('latin1',0,4)==='RIFF'&&h.toString('latin1',8,12)==='AVI '};
// A short snake_case code from the frame reader (bad JPEG, worker timeout or restart) tells the user more than the
// generic failure; free-text exception messages do not leave the server.
const readerCode=error=>/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(error?.message??'')&&error.message.length<=64?error.message:'frame_decode_failure';
async function header(path) {
  const file=await openFile(path,'r');
  try{const {buffer,bytesRead}=await file.read(Buffer.alloc(12),0,12,0);return buffer.subarray(0,bytesRead);}finally{await file.close();}
}
export async function buildServer(options={}) {
  const {token,nativeToken,cookieSecret}=credentials(options);
  const dataDir=resolve(options.dataDir??process.env.FIREGUARD_DATA_DIR??join(root,'analysis-data'));
  const uploadDir=join(dataDir,'uploads');await mkdir(uploadDir,{recursive:true});
  const store=options.store??new Store(join(dataDir,'fireguard.sqlite'));
  const frameReader=options.frameReader??new FrameReader();const scout=options.analyzer??options.scout??new MiniCPM();
  const now=options.now??Date.now,sleep=options.sleep??delay,livePingMs=options.livePingMs??15000;
  // Node's requestTimeout is server-wide, so it is sized for a 250 MiB upload on a ~2.3 Mbit/s uplink (15 minutes);
  // every HTTP request starts with the former two-minute limit (onRequest hook below), which only an authorized upload
  // that holds the upload slot lifts.
  const uploadTimeoutMs=options.uploadTimeoutMs??900000,requestTimeoutMs=options.requestTimeoutMs??120000;
  const nativeStreamFactory=options.nativeStreamFactory??(process.env.MINICPM_NATIVE_URL?
    settings=>new NativeStream({url:process.env.MINICPM_NATIVE_URL,token:nativeToken,...settings}):null);
  const expected=new Set(options.expectedCameraIds??(process.env.EXPECTED_LIGHTER_CAMERAS??'').split(',').filter(Boolean));
  const hazards=new Set(options.hazardCameraIds??(process.env.HAZARDOUS_CAMERAS??'').split(',').filter(Boolean));
  const app=Fastify({logger:false,bodyLimit:MAX_MESSAGE,requestTimeout:uploadTimeoutMs,
    ...(options.https?{https:options.https}:{})});
  await app.register(websocket,{options:{maxPayload:MAX_MESSAGE,perMessageDeflate:false}});
  await app.register(multipart,{limits:{fileSize:options.uploadLimitBytes??250*1024*1024,files:1,fields:0,parts:1}});
  // Added before authentication, so a refused (unauthorized or busy) upload's slow body is cut too. WebSocket upgrades carry no body.
  app.addHook('onRequest',async request=>{
    const raw=request.raw;if(request.ws)return;
    const timer=request.bodyTimer=setTimeout(()=>{if(!raw.complete)raw.destroy();},requestTimeoutMs);timer.unref();raw.once('close',()=>clearTimeout(timer));
  });
  const testers=testerAccess(app,{code:options.testerCode??process.env.TESTER_ACCESS_CODE,secret:cookieSecret,
    origin:options.testerOrigin??process.env.TESTER_PUBLIC_ORIGIN,trustProxy:options.trustProxy??process.env.FIREGUARD_TRUST_PROXY==='1',now});
  let live=null,activeJob=null,uploadReserved=false,closing=false;
  const sockets=new Set();
  const nativeStreams=new Set();
  const restartNative=new WeakMap();
  const coordinators=new Set();
  const makeCoordinator=(cameraId,sessionId,mode,onResult,policyCameraId=cameraId)=>{
    // The hook runs on a later microtask, so neither a throw nor a rejection can reach the coordinator or socket.
    let signature=null;const watched=mode==='live'&&options.onCriticalChange?body=>{
      const next=criticalSignature(body);
      if(next!==signature){signature=next;void Promise.resolve(body).then(options.onCriticalChange).catch(error=>console.error('Critical change hook failed:',error?.message??error));}
      onResult(body);
    }:onResult;
    const c=new VlmCoordinator({cameraId,sessionId,mode,onResult:watched,
      store,scout,now,expectedLighterUse:expected.has(policyCameraId),siteHazard:hazards.has(policyCameraId),streaming:mode==='live'&&Boolean(nativeStreamFactory)});
    signature=criticalSignature(c.result());coordinators.add(c);return c;
  };
  const retire=async c=>{await c.drain();coordinators.delete(c);};
  const tick=setInterval(()=>{if(live)live.tick();},1000);tick.unref();
  // Store.prune() bounds retained history; optional chaining keeps older stores working.
  const pruner=setInterval(()=>{try{store.prune?.();}catch(error){console.error('Store prune failed:',error.message);}},3600000);pruner.unref();
  app.addHook('onRequest',async(request,reply)=>{
    if(request.url==='/health'||testers?.isPublic(request))return;
    if(authorized(request,token))return;
    const session=testers?.read(request);
    const path=request.url.split('?')[0];
    if(!session||!(['/v1/videos','/v1/live'].includes(path)||/^\/v1\/videos\/[^/]+$/.test(path)||/^\/v1\/live\/[^/]+\/review$/.test(path)))return reply.code(401).send({error:'unauthorized'});
    if((request.method!=='GET'||path==='/v1/live')&&!testers.sameOrigin(request))return reply.code(403).send({error:'same_origin_required'});
    request.testerSession=session;
  });
  app.get('/health',async()=>({ok:true,service:'fireguard-analysis',policy_version:POLICY_VERSION,build_id:process.env.FIREGUARD_BUILD_ID??null,scout_configured:false,
    vlm_configured:Boolean(scout.configured),vlm_provider:scout.source??'injected',vlm_model:scout.model??null,
    live_vlm_mode:nativeStreamFactory?'native_visual_stream':'image_batches',
    live_active:Boolean(live),video_job_active:Boolean(activeJob),frame_reader_available:!frameReader.closed,
    frame_reader_restarts:frameReader.restarts??0,frame_reader_last_failure:frameReader.lastFailure??null,detection_source:'minicpm',yolo_enabled:false}));
  app.get('/v1/live',{websocket:true},(socket,request)=>{
    const expiry=request.testerSession?setTimeout(()=>socket.close(1000,'Ten-minute test session ended'),Math.min(600000,request.testerSession.expires-now())):null;
    if(expiry)socket.once('close',()=>clearTimeout(expiry));
    sockets.add(socket);let coordinator=null,nativeStream=null,sourceSession=null,lastSequence=0,lastTs=-1,lastSample=-Infinity,lastNative=-Infinity;
    let busy=false,pending=null,dropped=0,frameWork=Promise.resolve(),nativeGeneration=0,lastClientTs=-1,minLag=Infinity;
    // A browser that vanished without a FIN (sleep, dropped network) would hold the only live slot until TCP gives up.
    // A pong or any message since the previous ping proves it alive, so a proxy that swallowed pings cannot end a stream.
    let alive=true;const heartbeat=setInterval(()=>{if(!alive)return socket.terminate();alive=false;socket.ping();},livePingMs);
    socket.on('pong',()=>{alive=true;});
    const startNative=()=>{
      if(!nativeStreamFactory||!coordinator?.connected)return;
      const generation=++nativeGeneration;
      nativeStream?.close();nativeStreams.delete(nativeStream);
      nativeStream=nativeStreamFactory({sessionId:coordinator.sessionId,
        onState:state=>{if(generation===nativeGeneration)coordinator.acceptNativeState(state);},
        onResult:(value,frame)=>{if(generation===nativeGeneration)coordinator.acceptNative(value,frame);}});
      nativeStreams.add(nativeStream);void nativeStream.open().catch(()=>{if(generation===nativeGeneration)coordinator.acceptNativeState('unavailable');});
    };
    const send=body=>{if(socket.readyState===1){if(socket.bufferedAmount>MAX_MESSAGE){socket.close(1013,'receiver too slow');return;}socket.send(JSON.stringify(body));}};
    const pump=()=>{
      if(busy||!pending||!coordinator?.connected)return;
      const frame=pending;pending=null;busy=true;
      frameWork=(async()=>{
        try {
          const image_b64=frame.jpeg.toString('base64');const observation=await frameReader.infer(image_b64,{stream:coordinator.sessionId,ts_ms:frame.ts_ms});
          if(coordinator.connected){
            coordinator.accept({...observation,ts_ms:frame.ts_ms,image_b64});
            // The exact image that becomes native evidence must pass pixel checks; a skipped (moving) frame is not current.
            if(coordinator.usable()&&coordinator.current?.ts_ms===frame.ts_ms&&frame.ts_ms-lastNative>=200){nativeStream?.push(frame);lastNative=frame.ts_ms;}
          }
        } catch(error) {if(coordinator.connected){const code=readerCode(error);coordinator.gap(code);send({type:'error',error:code});}}
        finally{busy=false;pump();}
      })();
    };
    socket.on('message',(message,isBinary)=>{
      alive=true;
      try {
        if(!isBinary) {
          if(message.length>4096)throw new Error('control_too_large');
          const control=JSON.parse(message.toString());
          if(control.type!=='start' || Object.keys(control).sort().join(',')!=='camera_id,session_id,type' ||
            !cameraPattern.test(control.camera_id) || !cameraPattern.test(control.session_id)) throw new Error('invalid_start');
          if(coordinator || live)throw new Error('live_session_busy');
          sourceSession=control.session_id;
          const cameraId=request.testerSession?'tester-'+request.testerSession.id:control.camera_id;
          coordinator=makeCoordinator(cameraId,randomUUID(),'live',body=>send({type:'result',...body}),request.testerSession?'tester':cameraId);
          live=coordinator;send({type:'ready',session_id:sourceSession,assessment_session_id:coordinator.sessionId});
          restartNative.set(coordinator,startNative);startNative();
          return;
        }
        if(!coordinator)throw new Error('start_required');
        const source=decodeFrame(message);
        if(source.session_id!==sourceSession)throw new Error('session_mismatch');
        if(source.sequence<=lastSequence || source.ts_ms<=lastClientTs)throw new Error('duplicate_or_reordered_frame');
        // A skewed client clock must not block streaming, so it is only compared with itself: a frame delayed 5 s more
        // than the session's least-delayed one is stale. Downstream (sampling, evidence ids, native push) uses capture time
        // mapped onto the server clock by that least delay, so a delayed burst keeps its real age; it is strictly increasing
        // and never later than now (a second frame within the same millisecond is dropped).
        const at=now(),lag=at-source.ts_ms;minLag=Math.min(minLag,lag);if(lag-minLag>5000)throw new Error('stale_frame');
        lastSequence=source.sequence;lastClientTs=source.ts_ms;
        const ts=Math.max(source.ts_ms+minLag,lastTs+1);if(ts>at)return;
        lastTs=ts;const frame={...source,ts_ms:ts};
        // Server chooses inference samples. Source sequence gaps remain visible.
        if(frame.ts_ms-lastSample+1<1000/3)return;
        lastSample=frame.ts_ms;if(pending)dropped++;pending=frame;pump();
      } catch(error) {
        if(isBinary && coordinator?.connected && error.message!=='duplicate_or_reordered_frame')coordinator.gap('invalid_frame');
        send({type:'error',error:error.message,dropped_frames:dropped});
      }
    });
    socket.on('close',()=>{clearInterval(heartbeat);sockets.delete(socket);nativeStream?.close();nativeStreams.delete(nativeStream);if(coordinator){coordinator.disconnect();if(live===coordinator)live=null;
      void retire(coordinator);}pending=null;});
    socket.on('error',()=>socket.close());
  });

  app.post('/v1/live/:id/review',{bodyLimit:4096},async(request,reply)=>{
    if(!live||live.sessionId!==request.params.id||request.testerSession&&live.cameraId!==`tester-${request.testerSession.id}`)
      return reply.code(404).send({error:'live_session_not_found'});
    const body=request.body;
    if(!body||Array.isArray(body)||Object.keys(body).sort().join(',')!=='action,incident_id,last_hazard_ts_ms'||
      !['false_alarm','incident_resolved'].includes(body.action)||typeof body.incident_id!=='string'||
      !(body.last_hazard_ts_ms===null||Number.isSafeInteger(body.last_hazard_ts_ms)&&body.last_hazard_ts_ms>=0))
      return reply.code(400).send({error:'invalid_review'});
    try{
      live.reviewAlert({...body,actor:request.testerSession?'tester':'service'});
      restartNative.get(live)?.();return reply.header('Cache-Control','no-store').send(live.result());
    }catch(error){if(error.message==='alert_updated_review_again')return reply.code(409).send({error:error.message});throw error;}
  });

  async function runVideo(id,path,cameraId,policyCameraId=cameraId) {
    let c;
    try {
      await scout.warmup?.();
      const metadata=await frameReader.open(path);c=makeCoordinator(cameraId,id,'recorded',undefined,policyCameraId);
      store.job(id,{status:'running',metadata,started_at_ms:now()});
      const started=now();let sampled=0;
      for(;;) {
        if(closing)throw new Error('server_stopping');
        const frame=await frameReader.next();
        if(frame.eof){store.job(id,{decoded_frames:frame.decoded_frames});break;}
        await sleep(Math.max(0,frame.ts_ms-(now()-started)));
        const observation=await frameReader.infer(frame.image_b64,{stream:id,ts_ms:frame.ts_ms});
        c.accept({...observation,ts_ms:frame.ts_ms,image_b64:observation.image_b64??frame.image_b64});await c.drain();sampled++;
        store.job(id,{sampled_frames:sampled,source_ts_ms:frame.ts_ms});
      }
      const result=await c.finish();store.job(id,{status:'complete',result,finished_at_ms:now()});
    } catch(error) {
      if(c){c.gap('video_processing_failed');c.disconnect();}
      store.job(id,{status:'failed',error:error.message,finished_at_ms:now()});
    } finally {
      if(c)await retire(c);
      await frameReader.closeVideo().catch(()=>{});await unlink(path).catch(()=>{});
    }
  }
  app.post('/v1/videos',async(request,reply)=>{
    if(activeJob || uploadReserved)return reply.code(409).send({error:'video_job_busy'});
    const cameraId=request.testerSession?'tester-'+request.testerSession.id:request.query.camera_id??'test-camera';
    if(typeof cameraId!=='string'||!cameraPattern.test(cameraId))return reply.code(400).send({error:'invalid_camera_id'});
    uploadReserved=true;let path,received=false;
    try {
      const files=await readdir(uploadDir);let total=0;
      for(const file of files)total+=(await stat(join(uploadDir,file))).size;
      if(total>750*1024*1024)return reply.code(507).send({error:'upload_storage_limit'});
      clearTimeout(request.bodyTimer);const part=await request.file();if(!part)return reply.code(400).send({error:'video_required'});
      const extension=extname(part.filename).toLowerCase();
      if(!Object.hasOwn(signatures,extension)){part.file.resume();return reply.code(415).send({error:'unsupported_video_format'});}
      const id=randomUUID();path=join(uploadDir,id+extension);
      // A body that ends inside the file part can leave the file stream neither ended nor errored, holding the upload
      // slot forever, so once the request is fully read (or gone) the file must finish within a few seconds.
      const out=createWriteStream(path,{flags:'wx'});let guard;
      const cut=()=>{guard=setTimeout(()=>out.destroy(new Error('multipart_truncated')),3000);};
      if(request.raw.destroyed)cut();else request.raw.once('close',cut);
      try{await pipeline(part.file,out);}finally{clearTimeout(guard);request.raw.off('close',cut);}
      if(part.file.truncated)throw new Error('video_too_large');
      received=true;
      // A renamed non-video file stops here; `path` is still set, so finally deletes it.
      if(!signatures[extension](await header(path)))return reply.code(415).send({error:'unsupported_video_format'});
      store.job(id,{status:'queued',camera_id:cameraId,tester_id:request.testerSession?.id??null,filename:part.filename.slice(0,200),created_at_ms:now()});
      activeJob=runVideo(id,path,cameraId,request.testerSession?'tester':cameraId).finally(()=>{activeJob=null;});path=null;
      return reply.code(202).send({id,status:'queued',result_url:`/v1/videos/${id}`});
    } catch(error){
      // Filesystem errors carry a syscall; malformed or extra multipart parts and an aborted client do not.
      const [status,code]=error.code==='FST_REQ_FILE_TOO_LARGE'||error.message==='video_too_large'?[413,'video_too_large']:
        received||error.syscall?[500,'video_store_failed']:[400,'invalid_multipart'];
      return reply.code(status).send({error:code});
    }
    finally{uploadReserved=false;if(path)await unlink(path).catch(()=>{});}
  });
  app.get('/v1/videos/:id',async(request,reply)=>{
    const job=store.job(request.params.id);if(!job)return reply.code(404).send({error:'job_not_found'});
    if(request.testerSession&&job.tester_id!==request.testerSession.id)return reply.code(404).send({error:'job_not_found'});
    const after=Number(request.query.after??0),limit=Number(request.query.limit??500);
    if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>1000)return reply.code(400).send({error:'invalid_pagination'});
    const timeline=store.timeline(job.id,{after,limit});
    const inferences=store.inferences(job.id).map(({raw,...safe})=>safe);
    return {...job,timeline,next_after:timeline.at(-1)?.event_id??after,inferences};
  });
  app.decorate('fireguard',{store,frameReader,scout,analyzer:scout,waitForJobs:async()=>{if(activeJob)await activeJob;}});
  app.addHook('onClose',async()=>{
    closing=true;clearInterval(tick);clearInterval(pruner);for(const socket of sockets)socket.terminate();
    for(const stream of nativeStreams)stream.close();nativeStreams.clear();
    for(const c of coordinators)c.disconnect();scout.close?.();
    if(activeJob)await activeJob;
    await Promise.all([...coordinators].map(c=>c.drain()));
    frameReader.close();await options.beforeStoreClose?.(store);if(!options.store)store.close();
  });
  return app;
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const host=process.env.ANALYSIS_HOST??'127.0.0.1';
  const tls=process.env.TLS_CERT && process.env.TLS_KEY?{cert:readFileSync(process.env.TLS_CERT),key:readFileSync(process.env.TLS_KEY)}:null;
  if(!['127.0.0.1','::1','localhost'].includes(host)&&!tls)throw new Error('TLS required outside loopback');
  const app=await buildServer({https:tls});
  await app.fireguard.frameReader.warmup();
  await app.listen({host,port:Number(process.env.ANALYSIS_PORT??8002)});
  console.log(`FireGuard analysis ready at ${tls?'https':'http'}://${host}:${app.server.address().port}`);
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void app.close().then(()=>process.exit(0));});
}
