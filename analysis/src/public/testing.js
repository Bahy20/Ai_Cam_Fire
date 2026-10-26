'use strict';
const $=id=>document.getElementById(id);
let job=null,pollTimer=null,stream=null,socket=null,frameTimer=null,session=null,seq=0,lastResult=0,cameraStarting=false,cameraGeneration=0;
let lastLiveResult=null,reviewTarget=null;
const messages={unauthorized:'Your session expired. Reload and enter the tester code.',video_job_busy:'Another video is processing. Please try again shortly.',live_session_busy:'Another tester is using the live stream. Please try again shortly.',scout_http_429:'Scout is rate-limited or its allowance is exhausted.',scout_timeout:'Scout did not respond in time.',scout_provider_cooldown:'Scout is temporarily paused after a provider error.'};
const describe=value=>messages[value]||value||'Request failed. Please try again.';
Object.assign(messages,{minicpm_timeout:'MiniCPM did not respond in time.',minicpm_invalid_response:'MiniCPM returned inconsistent or incomplete evidence.',minicpm_remote_failure:'MiniCPM is temporarily unavailable.',minicpm_bridge_unavailable:'The model connection is unavailable.'});
Object.assign(messages,{alert_updated_review_again:'The alert changed or has new evidence. Open Review earlier alert again to review the latest finding.',live_session_not_found:'This live session ended. Start the webcam again.'});
async function api(path,options={}){const r=await fetch(path,{...options,cache:'no-store'});let body;try{body=await r.json();}catch{throw new Error('The service is starting or unavailable. Please retry shortly.');}if(!r.ok)throw new Error(describe(body.error));return body;}
function signedIn(ok){$('login').hidden=ok;$('lab').hidden=!ok;$('badge').textContent=ok?'Connected to Modal':'Tester access';}
async function restore(){try{await api('/testing/session');signedIn(true);}catch{signedIn(false);}}
$('login-form').onsubmit=async e=>{e.preventDefault();$('sign-in').disabled=true;try{await api('/testing/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:$('code').value})});$('code').value='';$('login-error').textContent='';signedIn(true);}catch(error){$('login-error').textContent=error.message;}finally{$('sign-in').disabled=false;}};
$('sign-out').onclick=async()=>{stopCamera();clearTimeout(pollTimer);try{await api('/testing/logout',{method:'POST'});signedIn(false);}catch(error){$('badge').textContent=error.message;}};
function mode(live){$('upload-panel').hidden=live;$('live-panel').hidden=!live;$('live-tab').setAttribute('aria-selected',String(live));$('upload-tab').setAttribute('aria-selected',String(!live));if(!live)stopCamera();}
$('upload-tab').onclick=()=>mode(false);$('live-tab').onclick=()=>mode(true);
function render(prefix,result,inferences=[]){
  $(prefix+'-result').hidden=false;
  $(prefix+'-detection').textContent=`Visual assessment · Flame: ${(result?.detection?.fire||'unknown').replaceAll('_',' ')} · Smoke: ${(result?.detection?.smoke||'unknown').replaceAll('_',' ')}`;
  if(prefix==='live'){
    lastLiveResult=result;
    $('review-open').hidden=!result?.incident_history?.reviewable;
    const native=result?.native_stream;
    const state={connecting:'Starting live analysis… First startup may take a minute; keep the camera running.',reconnecting:'Reconnecting live analysis… Keep the camera running.',listening:'Live video connected',speaking:'Live model is reporting',
      unavailable:'Live model connection unavailable',stalled:'Waiting for the live model',invalid_response:'Live model response unavailable'};
    $('live-native').textContent=native?(state[native.state]||'Live model starting')+(native.native_chunks?` · ${native.native_chunks} frames processed`:''):'';
    if(native?.state==='connecting'&&Number.isFinite(native.startup_elapsed_ms))$('live-native').textContent+=` ${Math.floor(native.startup_elapsed_ms/1000)}s elapsed.`;
    if(native && native.assessment_status!=='current')$('live-native').textContent+='. No current valid scene report.';
    const row=native?.assessment;
    $('live-observation').textContent=row&&native.assessment_status==='current'?'Current model observation: '+row.description:'';
    if(row && native.assessment_status==='current' && Date.now()-(native.assessment_ts_ms??0)<=10000){
      const label={present:'observed',not_observed:'not observed',uncertain:'uncertain'};
      $('live-native').textContent+=`. Flame: ${label[row.flame]||'unknown'}; smoke: ${label[row.smoke]||'unknown'}; other material burning: ${label[row.burning_material]||'unknown'}.`;
    }
  }
  const priority=$(prefix+'-priority');priority.textContent=result?.priority?.label||'Not assessed';priority.dataset.level=result?.priority?.level||'unknown';
  const c=result?.cause,h=c?.hypothesis,scene=result?.scene_assessment;
  const observation=[...(scene?.status==='current'?scene.observations:c?.observations||[])].reverse().find(o=>['material_burning','flame_visible','flame_at_tool','smoke_visible'].includes(o.kind));
  $(prefix+'-cause').textContent=(c?.status==='hypothesis'?`Possible ${h?.ignition_source} ignition using ${h?.ignition_tool}; not verified.`:'Verified ignition source: not established.')+(observation?' Observed: '+observation.description:'');
  const failures=inferences.filter(x=>x?.error||x?.validation_errors?.length);
  const view=result?.view;
  const viewMessages={uniform_extreme_luminance:'The camera image is almost entirely black or white.',insufficient_scene_illumination:'The scene is too dark to assess reliably. Restore lighting.',candidate_region_touches_frame_edge:'A detector box reaches the image border; object context may be cropped.'};
  const viewWarning=view?.status==='unavailable'?`View unavailable: ${view.reason?.replaceAll('_',' ')||'unknown reason'}. `:'';
  const qualityWarning=(view?.quality_reasons||[]).map(reason=>viewMessages[reason]||'').filter(Boolean).join(' ');
  const history=result?.incident_history;
  const historyWarning=history?.unresolved && (history.smoke_confirmed||history.fire_confirmed||history.model_hazard)?'Previous alert remains unresolved; current detections are shown separately.':'';
  const reportWarning=result?.native_stream && ['not_reporting','expired'].includes(result.native_stream.assessment_status)?'The live model has not supplied a current valid scene report. No safety conclusion is available.':'';
  $(prefix+'-warning').textContent=[viewWarning+qualityWarning,historyWarning,reportWarning,failures.length?'Scene assessment incomplete: '+[...new Set(failures.map(x=>describe(x.error||'Invalid model response.')))].join(' '):''].filter(Boolean).join(' ');
  $(prefix+'-details').textContent=JSON.stringify(result,null,2);
}
$('review-open').onclick=()=>{
  if(!lastLiveResult?.incident_history?.reviewable)return;
  const r=lastLiveResult,h=r.incident_history.latest_hazard;
  reviewTarget={session_id:r.session_id,incident_id:r.incident_id,last_hazard_ts_ms:h?.ts_ms??null};
  $('review-evidence').textContent=h?`Earlier model finding (${new Date(h.ts_ms).toLocaleTimeString()}): ${h.description}`:'Earlier model alert. Its original records remain in incident history.';
  $('review-reason').value='';$('review-confirm').checked=false;$('review-form').hidden=false;$('review-status').textContent='';
};
$('review-cancel').onclick=()=>{reviewTarget=null;$('review-form').hidden=true;};
$('review-form').onsubmit=async event=>{
  event.preventDefault();const target=reviewTarget,generation=cameraGeneration;
  if(!target||!$('review-confirm').checked||!['false_alarm','incident_resolved'].includes($('review-reason').value)){
    $('review-status').textContent='Choose an outcome and confirm that you reviewed the alert.';return;
  }
  $('review-submit').disabled=true;
  try{
    const {session_id,...body}=target;body.action=$('review-reason').value;
    const result=await api(`/v1/live/${encodeURIComponent(session_id)}/review`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    if(generation!==cameraGeneration)return;
    if(!lastLiveResult||result.emitted_at_ms>=lastLiveResult.emitted_at_ms)render('live',result);
    reviewTarget=null;$('review-form').hidden=true;$('review-status').textContent='Review saved. Checking fresh camera frames.';
  }catch(error){if(generation===cameraGeneration)$('review-status').textContent=error.message;}
  finally{$('review-submit').disabled=false;}
};
function uploadBusy(value){$('analyze').disabled=value;$('file').disabled=value;}
async function poll(){clearTimeout(pollTimer);$('retry').hidden=true;try{
  const value=await api('/v1/videos/'+encodeURIComponent(job)+'?limit=100');
  if(['complete','failed','interrupted'].includes(value.status)){
    $('upload-status').textContent=value.status==='complete'?'Video processing complete.':`Video ${value.status}: ${describe(value.error)}`;
    render('upload',value.result,value.inferences);$('upload-details').textContent=JSON.stringify(value,null,2);uploadBusy(false);return;
  }
  $('upload-status').textContent=`${value.status==='queued'?'Queued':'Analyzing'} · ${value.sampled_frames||0} frames sampled`;
  pollTimer=setTimeout(poll,2000);
}catch(error){$('upload-status').textContent=error.message;$('retry').hidden=false;uploadBusy(false);}}
$('retry').onclick=()=>{uploadBusy(true);void poll();};
$('upload-form').onsubmit=e=>{
  e.preventDefault();const file=$('file').files[0];if(!file)return;
  if(!/\.(mp4|mov|avi)$/i.test(file.name)||!file.size||file.size>250*1024*1024){$('upload-status').textContent='Choose an MP4, MOV or AVI file up to 250 MiB.';return;}
  clearTimeout(pollTimer);job=null;uploadBusy(true);$('retry').hidden=true;$('upload-result').hidden=true;$('progress').hidden=false;$('progress').value=0;$('upload-status').textContent='Uploading…';
  const xhr=new XMLHttpRequest();xhr.open('POST','/v1/videos');xhr.timeout=300000;
  xhr.upload.onprogress=e=>{if(e.lengthComputable){$('progress').value=e.loaded/e.total*100;$('upload-status').textContent=e.loaded===e.total?'Upload sent; waiting for analysis…':`Uploading… ${Math.round(e.loaded/e.total*100)}%`;}};
  xhr.onload=()=>{try{const r=JSON.parse(xhr.responseText);if(xhr.status!==202)throw new Error(describe(r.error));if(!r.id)throw new Error('Missing job identifier.');job=r.id;$('progress').hidden=true;void poll();}catch(error){$('upload-status').textContent=error.message;uploadBusy(false);$('progress').hidden=true;}};
  xhr.onerror=xhr.ontimeout=()=>{$('upload-status').textContent='Upload failed or timed out. Please try again.';uploadBusy(false);$('progress').hidden=true;};
  const data=new FormData();data.append('video',file);xhr.send(data);
};
function stopCamera(message='Camera is off.'){
  lastLiveResult=null;reviewTarget=null;$('review-open').hidden=true;$('review-form').hidden=true;
  cameraGeneration++;session=null;cameraStarting=false;clearTimeout(frameTimer);
  const old=socket;socket=null;if(old){old.onclose=null;old.close();}
  if(stream){for(const track of stream.getTracks()){track.onended=null;track.stop();}stream=null;}
  $('preview').srcObject=null;$('start-camera').disabled=false;$('stop-camera').disabled=true;$('live-status').textContent=message;
  $('live-priority').textContent='Not assessed — camera stopped';$('live-priority').dataset.level='unknown';
  $('live-native').textContent='';
}
const canvas=document.createElement('canvas'),context=canvas.getContext('2d');
async function sendFrame(activeSession){
  if(session!==activeSession||socket?.readyState!==WebSocket.OPEN)return;
  const video=$('preview');
  try{
    if(video.readyState>=2&&video.videoWidth>0&&socket.bufferedAmount<256*1024){
      canvas.width=Math.min(640,video.videoWidth);canvas.height=Math.round(video.videoHeight*canvas.width/video.videoWidth);
      context.drawImage(video,0,0,canvas.width,canvas.height);const ts=Date.now();
      const jpeg=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.8));
      if(jpeg&&session===activeSession&&socket?.readyState===WebSocket.OPEN){
        const meta=new TextEncoder().encode(JSON.stringify({session_id:activeSession,sequence:++seq,ts_ms:ts}));
        const length=new ArrayBuffer(4);new DataView(length).setUint32(0,meta.length);
        socket.send(new Blob([length,meta,jpeg]));$('live-status').textContent=`Streaming · ${seq} frames sent`;
      }
    }
  }catch{stopCamera('Could not send camera frames. Please reconnect.');return;}
  if(session===activeSession)frameTimer=setTimeout(()=>sendFrame(activeSession),200);
}
$('start-camera').onclick=async()=>{
  if(cameraStarting||stream)return;cameraStarting=true;$('start-camera').disabled=true;$('stop-camera').disabled=false;
  const generation=++cameraGeneration;
  $('live-status').textContent='Requesting camera access…';$('live-warning').textContent='';
  try{
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('This browser does not support webcam access over this connection.');
    const acquired=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},frameRate:{ideal:30}},audio:false});
    if(!cameraStarting||generation!==cameraGeneration){acquired.getTracks().forEach(t=>t.stop());return;}
    stream=acquired;$('preview').srcObject=stream;await $('preview').play();
    const activeSession=crypto.randomUUID();session=activeSession;seq=0;lastResult=Date.now();
    socket=new WebSocket(location.origin.replace('https:','wss:')+'/v1/live');$('live-status').textContent='Connecting to analysis…';
    const connecting=setTimeout(()=>{if(session===activeSession&&socket?.readyState!==WebSocket.OPEN)stopCamera('Connection timed out. Please try again.');},180000);
    socket.onopen=()=>{clearTimeout(connecting);socket.send(JSON.stringify({type:'start',camera_id:'test-camera',session_id:activeSession}));};
    socket.onmessage=event=>{if(session!==activeSession)return;try{const value=JSON.parse(event.data);
      if(value.type==='ready'){cameraStarting=false;void sendFrame(activeSession);}
      else if(value.type==='result'){lastResult=Date.now();render('live',value,[value.inference]);}
      else if(value.type==='error')stopCamera(describe(value.error));
    }catch{stopCamera('Invalid response from analysis.');}};
    socket.onclose=event=>{clearTimeout(connecting);if(session===activeSession)stopCamera(event.reason||'Analysis disconnected. Start webcam to reconnect.');};
    socket.onerror=()=>{clearTimeout(connecting);if(session===activeSession)stopCamera('Analysis connection failed. Check your session or try again shortly.');};
    stream.getVideoTracks()[0].onended=()=>stopCamera('Camera access ended.');
  }catch(error){if(generation===cameraGeneration)stopCamera(error.message||'Camera could not start.');}
};
$('stop-camera').onclick=()=>stopCamera();
setInterval(()=>{if(session&&Date.now()-lastResult>6000){$('live-priority').textContent='Waiting for current assessment';$('live-priority').dataset.level='unknown';}},1000);
document.addEventListener('visibilitychange',()=>{if(document.hidden&&stream)stopCamera('Camera stopped while this tab is hidden.');});
window.addEventListener('pagehide',()=>stopCamera());
void restore();
