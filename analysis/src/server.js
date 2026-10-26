import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import { timingSafeEqual,randomUUID } from 'node:crypto';
import { createWriteStream,readFileSync } from 'node:fs';
import { mkdir,unlink,readdir,stat } from 'node:fs/promises';
import { join,resolve,extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from './store.js';
import { VlmCoordinator } from './vlm-coordinator.js';
import { FrameReader } from './frame-reader.js';
import { MiniCPM } from './minicpm.js';
import {NativeStream} from './native-stream.js';
import { decodeFrame,MAX_MESSAGE } from './protocol.js';
import {testerAccess} from './tester-access.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const cameraPattern=/^[A-Za-z0-9_-]{1,80}$/;
function authorized(request,token) {
  const actual=Buffer.from(request.headers.authorization??'');const expected=Buffer.from(`Bearer ${token}`);
  return actual.length===expected.length && timingSafeEqual(actual,expected);
}
export async function buildServer(options={}) {
  const token=options.token??process.env.FIREGUARD_TOKEN;
  if(!token)throw new Error('FIREGUARD_TOKEN is required');
  const dataDir=resolve(options.dataDir??process.env.FIREGUARD_DATA_DIR??join(root,'analysis-data'));
  const uploadDir=join(dataDir,'uploads');await mkdir(uploadDir,{recursive:true});
  const store=options.store??new Store(join(dataDir,'fireguard.sqlite'));
  const frameReader=options.frameReader??new FrameReader();const scout=options.analyzer??options.scout??new MiniCPM();
  const now=options.now??Date.now,sleep=options.sleep??delay;
  const nativeStreamFactory=options.nativeStreamFactory??(process.env.MINICPM_NATIVE_URL?
    settings=>new NativeStream({url:process.env.MINICPM_NATIVE_URL,token,...settings}):null);
  const expected=new Set(options.expectedCameraIds??(process.env.EXPECTED_LIGHTER_CAMERAS??'').split(',').filter(Boolean));
  const hazards=new Set(options.hazardCameraIds??(process.env.HAZARDOUS_CAMERAS??'').split(',').filter(Boolean));
  const app=Fastify({logger:false,bodyLimit:MAX_MESSAGE,requestTimeout:120000,
    ...(options.https?{https:options.https}:{})});
  await app.register(websocket,{options:{maxPayload:MAX_MESSAGE,perMessageDeflate:false}});
  await app.register(multipart,{limits:{fileSize:250*1024*1024,files:1,fields:0,parts:1}});
  const testers=testerAccess(app,{code:options.testerCode??process.env.TESTER_ACCESS_CODE,secret:token,
    origin:options.testerOrigin??process.env.TESTER_PUBLIC_ORIGIN,now});
  let live=null,activeJob=null,uploadReserved=false,closing=false;
  const sockets=new Set();
  const nativeStreams=new Set();
  const restartNative=new WeakMap();
  const coordinators=new Set();
  const makeCoordinator=(cameraId,sessionId,mode,onResult,policyCameraId=cameraId)=>{
    const c=new VlmCoordinator({cameraId,sessionId,mode,onResult,
      store,scout,now,expectedLighterUse:expected.has(policyCameraId),siteHazard:hazards.has(policyCameraId),streaming:mode==='live'&&Boolean(nativeStreamFactory)});
    coordinators.add(c);return c;
  };
  const retire=async c=>{await c.drain();coordinators.delete(c);};
  const tick=setInterval(()=>{if(live)live.tick();},1000);tick.unref();
  app.addHook('onRequest',async(request,reply)=>{
    if(request.url==='/health'||testers?.isPublic(request))return;
    if(authorized(request,token))return;
    const session=testers?.read(request);
    const path=request.url.split('?')[0];
    if(!session||!(['/v1/videos','/v1/live'].includes(path)||/^\/v1\/videos\/[^/]+$/.test(path)||/^\/v1\/live\/[^/]+\/review$/.test(path)))return reply.code(401).send({error:'unauthorized'});
    if((request.method!=='GET'||path==='/v1/live')&&!testers.sameOrigin(request))return reply.code(403).send({error:'same_origin_required'});
    request.testerSession=session;
  });
  app.get('/health',async()=>({ok:true,service:'fireguard-analysis',scout_configured:false,
    vlm_configured:Boolean(scout.configured),vlm_provider:scout.source??'injected',vlm_model:scout.model??null,
    live_vlm_mode:nativeStreamFactory?'native_visual_stream':'image_batches',
    live_active:Boolean(live),video_job_active:Boolean(activeJob),frame_reader_available:!frameReader.closed,
    frame_reader_restarts:frameReader.restarts??0,frame_reader_last_failure:frameReader.lastFailure??null,detection_source:'minicpm',yolo_enabled:false}));
  app.get('/v1/live',{websocket:true},(socket,request)=>{
    const expiry=request.testerSession?setTimeout(()=>socket.close(1000,'Ten-minute test session ended'),Math.min(600000,request.testerSession.expires-now())):null;
    if(expiry)socket.once('close',()=>clearTimeout(expiry));
    sockets.add(socket);let coordinator=null,nativeStream=null,sourceSession=null,lastSequence=0,lastTs=-1,lastSample=-Infinity,lastNative=-Infinity;
    let busy=false,pending=null,dropped=0,frameWork=Promise.resolve(),nativeGeneration=0;
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
          const image_b64=frame.jpeg.toString('base64');const observation=await frameReader.infer(image_b64);
          if(coordinator.connected){
            coordinator.accept({...observation,ts_ms:frame.ts_ms,image_b64});
            // The exact image that becomes native evidence must pass pixel checks.
            if(coordinator.usable()&&frame.ts_ms-lastNative>=200){nativeStream?.push(frame);lastNative=frame.ts_ms;}
          }
        } catch {if(coordinator.connected){coordinator.gap('frame_decode_failure');send({type:'error',error:'frame_decode_failure'});}}
        finally{busy=false;pump();}
      })();
    };
    socket.on('message',(message,isBinary)=>{
      try {
        if(!isBinary) {
          if(message.length>4096)throw new Error('control_too_large');
          const control=JSON.parse(message.toString());
          if(control.type!=='start' || Object.keys(control).sort().join(',')!=='camera_id,session_id,type' ||
            !cameraPattern.test(control.camera_id) || !cameraPattern.test(control.session_id)) throw new Error('invalid_start');
          if(coordinator || live)throw new Error('live_session_busy');
          sourceSession=control.session_id;
          const cameraId=request.testerSession?'tester-'+request.testerSession.id:control.camera_id;
          coordinator=makeCoordinator(cameraId,randomUUID(),'live',body=>send({type:'result',...body}),request.testerSession?'test-camera':cameraId);
          live=coordinator;send({type:'ready',session_id:sourceSession,assessment_session_id:coordinator.sessionId});
          restartNative.set(coordinator,startNative);startNative();
          return;
        }
        if(!coordinator)throw new Error('start_required');
        const frame=decodeFrame(message);
        if(frame.session_id!==sourceSession)throw new Error('session_mismatch');
        if(frame.sequence<=lastSequence || frame.ts_ms<=lastTs)throw new Error('duplicate_or_reordered_frame');
        if(frame.ts_ms>now()+1000 || now()-frame.ts_ms>5000)throw new Error('stale_or_future_frame');
        lastSequence=frame.sequence;lastTs=frame.ts_ms;
        // Server chooses inference samples. Source sequence gaps remain visible.
        if(frame.ts_ms-lastSample+1<1000/3)return;
        lastSample=frame.ts_ms;if(pending)dropped++;pending=frame;pump();
      } catch(error) {
        if(isBinary && coordinator?.connected && error.message!=='duplicate_or_reordered_frame')coordinator.gap('invalid_frame');
        send({type:'error',error:error.message,dropped_frames:dropped});
      }
    });
    socket.on('close',()=>{sockets.delete(socket);nativeStream?.close();nativeStreams.delete(nativeStream);if(coordinator){coordinator.disconnect();if(live===coordinator)live=null;
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
        const observation=await frameReader.infer(frame.image_b64);
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
    uploadReserved=true;let path;
    try {
      const files=await readdir(uploadDir);let total=0;
      for(const file of files)total+=(await stat(join(uploadDir,file))).size;
      if(total>750*1024*1024)return reply.code(507).send({error:'upload_storage_limit'});
      const part=await request.file();if(!part)return reply.code(400).send({error:'video_required'});
      const extension=extname(part.filename).toLowerCase();
      if(!['.mp4','.mov','.avi'].includes(extension)){part.file.resume();return reply.code(415).send({error:'unsupported_video_format'});}
      const id=randomUUID();path=join(uploadDir,id+extension);
      await pipeline(part.file,createWriteStream(path,{flags:'wx'}));
      if(part.file.truncated)throw new Error('video_too_large');
      store.job(id,{status:'queued',camera_id:cameraId,tester_id:request.testerSession?.id??null,filename:part.filename.slice(0,200),created_at_ms:now()});
      activeJob=runVideo(id,path,cameraId,request.testerSession?'test-camera':cameraId).finally(()=>{activeJob=null;});path=null;
      return reply.code(202).send({id,status:'queued',result_url:`/v1/videos/${id}`});
    } catch(error){return reply.code(error.code==='FST_REQ_FILE_TOO_LARGE'||error.message==='video_too_large'?413:400).send({error:'video_upload_failed'});}
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
    closing=true;clearInterval(tick);for(const socket of sockets)socket.terminate();
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
