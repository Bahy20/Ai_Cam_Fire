// Bounded local workerd + actual CPU detector verification. --remote-ai shares
// one durable account-wide neuron ledger between probe and replay.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import net from 'node:net';
import {setTimeout as sleep} from 'node:timers/promises';
import {evaluateRuns} from './evaluate_analysis.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {stableSourceTime,loadAllowanceSnapshot} from './evaluation/inference-batch.mjs';
import {buildScoutHandheldEvaluationProfile} from './evaluation/scout-handheld-evaluation.mjs';
import {buildVerifierRuntimeEnv} from './evaluation/wrangler-runtime-env.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const value=name=>{const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:undefined;};
if(process.argv.includes('--help')) {
  console.log('node scripts/verify_quality_runtime.mjs --out NEW_DIRECTORY --attachments DIRECTORY [--remote-ai --allowance-snapshot CLOUD_FLARE_USAGE_JSON] [--probe-only --probe-frames 2|6] [--skip-probe --all-clips] [--scout-handheld-evaluation] [--schema-transport response_format|guided_json|prompt_only]\nRecorded-video replays use a current epoch and real-time pacing. Uses local D1/DO persistence; stops its owned Wrangler tree. Remote mode requires a fresh account-wide Cloudflare neuron snapshot and conservatively reserves neuron budget before every fresh request. --scout-handheld-evaluation is development-only; requires --remote-ai --skip-probe --all-clips and expects monitor only for the contained clip\'s observed interval while live priority stays inspect_urgently.');
  process.exit(0);
}
const out=path.resolve(value('--out') || path.join(root,'.hermes',`quality-verification-${Date.now()}`));
const attachments=value('--attachments');
const remote=process.argv.includes('--remote-ai');
const allowanceSnapshotFile=value('--allowance-snapshot');
if(remote && !allowanceSnapshotFile)throw new Error('--remote-ai requires a current --allowance-snapshot from Cloudflare account usage');
const allowanceSnapshot=allowanceSnapshotFile?loadAllowanceSnapshot(allowanceSnapshotFile):undefined;
const probeOnly=process.argv.includes('--probe-only');
const skipProbe=process.argv.includes('--skip-probe');
const allClips=process.argv.includes('--all-clips');
const scoutHandheldEvaluation=process.argv.includes('--scout-handheld-evaluation');
const cameraPrefix=`quality-${randomUUID().slice(0,8)}`;
const probeFrames=Number(value('--probe-frames') ?? 6);
const schemaTransport=value('--schema-transport') ?? 'response_format';
if(!['response_format','guided_json','prompt_only'].includes(schemaTransport))throw new Error('invalid_schema_transport');
if(![2,6].includes(probeFrames) || (probeOnly && !remote) || (skipProbe && probeOnly) ||
  ((skipProbe || allClips) && !remote))throw new Error('invalid_probe_options');
if(scoutHandheldEvaluation && (!remote || !skipProbe || !allClips || probeOnly))
  throw new Error('scout_handheld_evaluation_requires_remote_all_clips_without_probe');
if(!attachments || !fs.existsSync(attachments) || !fs.statSync(attachments).isDirectory() || fs.existsSync(out))
  throw new Error('new --out and existing --attachments directory are required');
let annotations=null;
let handheldEvaluationProfile=null;
let inputVideoHashes=null;
if(!probeOnly) {
  annotations=JSON.parse(fs.readFileSync(path.join(root,'scripts','evaluation','analysis-policy-labels.json'),'utf8'));
  for(const label of annotations.clips) {
    if(typeof label.video!=='string' || label.video!==path.basename(label.video))
      throw new Error('invalid_development_video_filename');
    const exact=path.join(attachments,label.video);
    const alias=path.join(attachments,label.video.replace(/-3(?=\.mp4$)/,''));
    if((!fs.existsSync(exact) || !fs.statSync(exact).isFile()) &&
        fs.existsSync(alias) && fs.statSync(alias).isFile())label.video=path.basename(alias);
  }
  if(remote && !allClips) annotations={...annotations,clips:[annotations.clips[0]]};
  if(scoutHandheldEvaluation) {
    handheldEvaluationProfile=buildScoutHandheldEvaluationProfile({
      annotations,cameraPrefix,reviewedAtMs:Date.now(),
    });
    annotations=handheldEvaluationProfile.annotations;
  } else if(allClips || !remote) {
    annotations={...annotations,clips:annotations.clips.map(({scene_expected:_sceneExpected,...label})=>label)};
  }
  inputVideoHashes={};
  for(const label of annotations.clips) {
    const videoPath=path.join(attachments,label.video);
    if(!fs.existsSync(videoPath) || !fs.statSync(videoPath).isFile())
      throw new Error(`development_video_attachment_missing:${label.video}`);
    if(scoutHandheldEvaluation) {
      const actualHash=createHash('sha256').update(fs.readFileSync(videoPath)).digest('hex');
      if(actualHash.toLowerCase()!==label.source_sha256.toLowerCase())
        throw new Error(`development_video_source_hash_mismatch:${label.video}`);
      inputVideoHashes[label.video]=actualHash;
    }
  }
}
fs.mkdirSync(out,{recursive:true});
const save=(name,data)=>fs.writeFileSync(path.join(out,name),JSON.stringify(data,null,2));
const python=path.join(root,'.venv','Scripts','python.exe');
const wrangler=path.join(root,'worker','node_modules','wrangler','bin','wrangler.js');
const started=Date.now();
const report={passed:false,remote_ai_enabled:remote,schema_transport:schemaTransport,production_deployed:false,started_at:new Date().toISOString(),out,steps:[],limitations:['development_clips_are_not_independent_accuracy_validation','real_held_out_control_footage_missing']};
if(inputVideoHashes)report.input_video_hashes=inputVideoHashes;
const invocationId=`quality-${randomUUID()}`;
const maxCalls=probeOnly?1:annotations.clips.length*2+(remote&&!skipProbe?1:0);
const commands=[];
const localKey=randomUUID();
const runtimeEnv=buildVerifierRuntimeEnv({baseEnv:process.env,outputDirectory:out,localKey,remote});
function sourceHashes(){
  const paths=[];
  for(const folder of ['worker/src','scripts/evaluation'])for(const entry of fs.readdirSync(path.join(root,folder),{withFileTypes:true}))
    if(entry.isFile() && /\.(?:js|mjs)$/.test(entry.name))paths.push(`${folder}/${entry.name}`);
  paths.push('edge/agent.py','edge/evidence.py','edge/heartbeat.py','edge/live_capture.py','edge/handheld_scene.py',
    'edge/observation_spool.py','edge/observation_uploader.py','detector/fire_seg.pt',
    'scripts/evaluation/analysis-policy-labels.json','scripts/evaluation/handheld-priority-corpus.json',
    'scripts/evaluation/held-out-corpus.template.json',
    'worker/wrangler.ai-dev.jsonc','worker/wrangler.jsonc',
    'scripts/test_edge_runtime.mjs','scripts/evaluate_analysis.mjs','scripts/verify_quality_runtime.mjs',
    'scripts/tests/verify-scout-handheld-evaluation.test.mjs',
    'scripts/tests/test_edge_evidence.py','scripts/tests/test_observation_spool.py',
    'scripts/tests/test_observation_uploader.py','scripts/tests/test_live_capture.py',
    'worker/test/edge-ingress.test.js');
  return Object.fromEntries(paths.sort().map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
}
report.source_hashes=sourceHashes();
let server, log;
let stopping=false;
const deadline=started+10*60*1000;
function guard(){if(Date.now()>deadline) throw new Error('verification_deadline');}
async function freePort(){const server=net.createServer();await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).once('error',reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function command(args,name,{executable=process.execPath}={}) {
  guard();const child=spawn(executable,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:runtimeEnv});
  commands.push(child);
  const stream=fs.createWriteStream(path.join(out,`${name}.log`));
  child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream,{end:false});
  const timer=setTimeout(()=>{if(child.exitCode===null) stopTree(child);},Math.max(1,deadline-Date.now()));
  const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
  clearTimeout(timer);await new Promise(resolve=>stream.end(resolve));
  report.steps.push({name,exit_code:code});save('result.json',report);
  console.log(`${name}: exit ${code}`);return code;
}
function stopTree(child){
  if(!child || child.exitCode!==null || !child.pid) return;
  try {process.kill(child.pid,'SIGTERM');} catch { /* Already exited or inaccessible. */}
}
function ownedListenerPids(ports){
  if(process.platform!=='win32' || !Array.isArray(ports) || !ports.length)return [];
  const result=spawnSync('netstat.exe',['-ano','-p','tcp'],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','ignore']});
  if(result.status!==0)return [];
  const expected=new Set(ports);
  const pids=new Set();
  for(const line of result.stdout.split(/\r?\n/)){
    const fields=line.trim().split(/\s+/);
    if(fields[0]!=='TCP' || fields[3]!=='LISTENING')continue;
    const localPort=Number(fields[1].slice(fields[1].lastIndexOf(':')+1));
    const pid=Number(fields[4]);
    if(expected.has(localPort) && Number.isSafeInteger(pid) && pid>0 && pid!==process.pid)pids.add(pid);
  }
  return [...pids];
}
async function stopOwnedListeners(ports){
  // Wrangler can leave workerd outside the CLI's process tree on Windows.
  // The ports were selected for and exercised by this run, so terminate only
  // listeners bound to those exact ports before reporting the runtime clean.
  for(let attempt=0;attempt<20;attempt++){
    const pids=ownedListenerPids(ports);
    if(!pids.length)return;
    for(const pid of pids)try{process.kill(pid,'SIGTERM');}catch{ /* Already exited. */}
    await sleep(150);
  }
}
async function request(origin,route,body) {
  guard();const response=await fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-api-key':localKey},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(190000)});
  const result=await response.json();if(!response.ok) throw new Error(`${route}:${response.status}:${result.error}`);return result;
}
const onInterrupt=()=>{stopping=true;for(const child of commands) stopTree(child);stopTree(server);};
process.on('SIGINT',onInterrupt);process.on('SIGTERM',onInterrupt);
try {
  const config=JSON.parse(fs.readFileSync(path.join(root,'worker','wrangler.ai-dev.jsonc'),'utf8'));
  report.handheld_priority_profile={enabled:config.vars.HANDHELD_PRIORITY_ENABLED==='true' &&
      /^[a-f0-9]{64}$/.test(config.vars.HANDHELD_MODEL_SHA256 ?? ''),
    configured_flag:config.vars.HANDHELD_PRIORITY_ENABLED ?? null,
    model_sha256:config.vars.HANDHELD_MODEL_SHA256 || null};
  report.scout_handheld_priority_evaluation={enabled:scoutHandheldEvaluation,
    scope:'observed_interval',camera_id:handheldEvaluationProfile?.cameraId ?? null,
    live_priority_expected:'inspect_urgently',interval_priority_expected:scoutHandheldEvaluation?'monitor':null,
    context_reviewed_by:handheldEvaluationProfile?'development-fixture':null,
    context_reviewed_at_ms:handheldEvaluationProfile?.cameraContexts[handheldEvaluationProfile.cameraId].reviewed_at_ms ?? null};
  config.name='fire-guard-quality-local';config.main=path.join(root,'worker','src','index.js');
  config.d1_databases[0].migrations_dir=path.join(root,'worker','migrations');
  if(!remote) delete config.ai;
  config.vars.VLM_EVALUATION_MODE='true';config.vars.VLM_TIMEOUT_MS='120000';
  config.vars.VLM_SCHEMA_TRANSPORT=schemaTransport;
  config.vars.SCOUT_HANDHELD_PRIORITY_ENABLED=scoutHandheldEvaluation?'true':'false';
  config.vars.CAMERA_CONTEXTS_JSON=JSON.stringify(handheldEvaluationProfile?.cameraContexts ?? {});
  const configFile=path.join(out,'wrangler.jsonc');save('wrangler.jsonc',config);
  const envFile=path.join(out,'local.env');fs.writeFileSync(envFile,`INGEST_API_KEY=${localKey}\n`,{mode:0o600});
  // The account/day inference ledger must survive separate output directories.
  // Keep remote verification state in the project profile; ordinary offline
  // runs remain isolated and disposable.
  const persistence=remote?path.join(root,'.hermes','quality-account-day-state'):path.join(out,'state');
  fs.mkdirSync(persistence,{recursive:true});
  const base=['--config',configFile,'--env-file',envFile,'--persist-to',persistence];
  if(await command([wrangler,'d1','migrations','apply','fire-guard-db','--local',...base],'migrations')!==0) throw new Error('local_migrations_failed');
  const port=await freePort(), inspector=await freePort();report.ports=[port,inspector];
  const origin=`http://127.0.0.1:${port}`;
  server=spawn(process.execPath,[wrangler,'dev',...base,'--ip','127.0.0.1','--port',String(port),'--inspector-port',String(inspector),'--show-interactive-dev-session=false'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:runtimeEnv});
  log=fs.createWriteStream(path.join(out,'workerd.log'));server.stdout.pipe(log,{end:false});server.stderr.pipe(log,{end:false});
  const readyDeadline=Date.now()+60000;
  while(true){try{if((await request(origin,'/health')).ok)break;}catch{}if(server.exitCode!==null || Date.now()>readyDeadline)throw new Error('workerd_start_failed');await sleep(250);}
  console.log(`local workerd ready on ${port}; remote AI ${remote?'enabled':'disabled'}`);
  if(remote) {
    await request(origin,'/dev/inference-batch',{batch_id:invocationId,max_calls:maxCalls,diagnostics:true,cache_mode:'read_write',
      account_snapshot:allowanceSnapshot});
  }
  if(remote && !skipProbe) {
    const source=path.join(attachments,'63658-506816251.mp4');
    const frameFile=path.join(out,'probe-frames.json');
    const frameScript=[
      'import cv2,base64,json,sys,math',
      'cap=cv2.VideoCapture(sys.argv[1]); assert cap.isOpened(), "probe_video_unavailable"',
      'total=int(cap.get(cv2.CAP_PROP_FRAME_COUNT)); fps=float(cap.get(cv2.CAP_PROP_FPS)); count=int(sys.argv[3]); anchor=int(sys.argv[4])',
      'assert total>=count and math.isfinite(fps) and fps>0, "probe_timing_unavailable"',
      'frames=[]',
      'for i in range(count):',
      ' index=round(i*(total-1)/(count-1)); cap.set(cv2.CAP_PROP_POS_FRAMES,index); ok,image=cap.read(); assert ok, "probe_decode_failed"',
      ' h,w=image.shape[:2]; image=cv2.resize(image,(640,round(h*640/w))); ok,jpeg=cv2.imencode(".jpg",image,[cv2.IMWRITE_JPEG_QUALITY,70]); assert ok',
      ' ts=anchor+round(index*1000/fps); roles=["early"] if i==0 else ["recent"] if i==count-1 else []',
      ' frames.append(dict(frame_id="frame-"+str(ts),ts_ms=ts,roles=roles,frame_wh=[image.shape[1],image.shape[0]],pre_ignition_verified=False,peak_scope=None,image_b64=base64.b64encode(jpeg).decode()))',
      'cap.release(); open(sys.argv[2],"w",encoding="utf-8").write(json.dumps(frames))',
    ].join('\n');
    if(await command(['-c',frameScript,source,frameFile,String(probeFrames),String(await stableSourceTime(source))],'probe-frames',{executable:python})!==0)
      throw new Error('probe_frame_extraction_failed');
    const frames=JSON.parse(fs.readFileSync(frameFile,'utf8'));
    const probe=await request(origin,'/dev/inference-probe',{frames});save('schema-probe.json',probe);
    const budget=await request(origin,'/dev/inference-batch');save('schema-probe-budget.json',budget);
    console.log(`Scout probe: source=${probe.cause.source}; schema_errors=${probe.cause.validation_errors.length}; fresh_calls=${budget.fresh_calls}`);
    if(budget.in_flight) throw new Error('probe_native_still_pending');
    if(probe.cause.source!=='workers_ai' || probe.cause.validation_errors.length) throw new Error('scout_schema_probe_failed');
  }
  if(!probeOnly) {
  save('development-labels.json',annotations);
  const replayArgs=[path.join(root,'scripts','test_edge_runtime.mjs'),'--worker',origin,'--out',path.join(out,'replay'),'--annotations',path.join(out,'development-labels.json'),'--camera-prefix',cameraPrefix,'--max-ai-calls',String(maxCalls),'--realtime'];
  if(remote)replayArgs.push('--batch-id',invocationId,'--allowance-snapshot',allowanceSnapshotFile);
  for(const label of annotations.clips) replayArgs.push('--video',path.join(attachments,label.video));
  if(remote) replayArgs.push('--require-ai','--capture-diagnostics','--inference-cache',path.join(out,'provider-cache.json'));
  const replayCode=await command(replayArgs,'video-replay');
  const runs=JSON.parse(fs.readFileSync(path.join(out,'replay','summary.json'),'utf8'));
  const evaluation=evaluateRuns(runs,annotations);save('evaluation.json',evaluation);
  report.videos=runs.map(run=>({video:run.video,passed:run.passed,sampled:run.sampled_frames,uploaded:run.uploaded_frames,
    schema_valid:run.modelSchemaVerified,replay_clock_mode:run.replay_clock_mode,
    source_start_ts_ms:run.source_start_ts_ms,confirmation_offset_ms:run.confirmation_offset_ms,
    final_priority:run.final_priority,failures:run.failures,
    scenes:run.causes.map(event=>({category:event.cause.scene_assessment?.category,support:event.cause.scene_assessment?.support,priority:event.response_priority,scope:event.priority_scope})),inference_counts:run.batch_inference_counts}));
  if(remote) report.batch=await request(origin,'/dev/inference-batch');
  // Actual detector + workerd negative acceptance using a repeated known negative
  // image. Synthetic contract only; excluded from the independent quality report.
  const negative=path.join(out,'contract-negative.avi');
  const makeNegative='import cv2,sys; image=cv2.imread(sys.argv[1]); assert image is not None; h,w=image.shape[:2]; writer=cv2.VideoWriter(sys.argv[2],cv2.VideoWriter_fourcc(*"MJPG"),10,(w,h)); assert writer.isOpened(); [writer.write(image) for _ in range(30)]; writer.release()';
  if(await command(['-c',makeNegative,path.join(root,'test_images','neg1.jpg'),negative],'negative-fixture',{executable:python})!==0)throw new Error('negative_fixture_failed');
  save('negative-labels.json',{version:1,clips:[{video:path.basename(negative),visible_flame_present:false,fire_present:false,actionable_fire_present:false,split:'contract_only',category:'repeated_negative_still',duration_ms:3000,annotation_basis:'Synthetic repeated labeled negative image; not independent video exposure.'}]});
  const negativeCode=await command([path.join(root,'scripts','test_edge_runtime.mjs'),'--worker',origin,'--out',path.join(out,'negative-replay'),'--video',negative,'--annotations',path.join(out,'negative-labels.json'),'--max-ai-calls','0'],'negative-replay');
  report.negative_contract=JSON.parse(fs.readFileSync(path.join(out,'negative-replay','summary.json'),'utf8'))[0];
  report.passed=replayCode===0 && evaluation.passed && negativeCode===0;
  } else report.passed=true;
} catch(error) {report.error=error.message;console.error('verification failed:',error.message);}
finally {
  for(const child of commands)stopTree(child);stopTree(server);
  if(server && server.exitCode===null) await Promise.race([new Promise(resolve=>server.once('exit',resolve)),sleep(10000)]);
  await stopOwnedListeners(report.ports);
  if(log)await new Promise(resolve=>log.end(resolve));
  report.owned_runtime_stopped=!server || server.exitCode!==null || server.signalCode!==null;
  report.source_unchanged=JSON.stringify(report.source_hashes)===JSON.stringify(sourceHashes());
  if(!report.source_unchanged)report.passed=false;
  report.owned_ports_free=true;
  for(const port of report.ports ?? []){
    const check=net.createServer();
    try{await new Promise((resolve,reject)=>check.once('error',reject).listen(port,'127.0.0.1',resolve));await new Promise(resolve=>check.close(resolve));}
    catch{report.owned_ports_free=false;}
  }
  if(!report.owned_runtime_stopped || !report.owned_ports_free)report.passed=false;
  report.elapsed_ms=Date.now()-started;report.interrupted=stopping;
  save('result.json',report);process.off('SIGINT',onInterrupt);process.off('SIGTERM',onInterrupt);
}
console.log(`verification result: ${report.passed}; ${path.join(out,'result.json')}`);
if(!report.passed)process.exitCode=1;
