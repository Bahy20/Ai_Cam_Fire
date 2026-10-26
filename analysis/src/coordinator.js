import { randomUUID } from 'node:crypto';
import { DetectionLifecycle } from '../../worker/src/lifecycle.js';
import { normalizeObservation } from '../../worker/src/observations.js';
import { createEvidenceState,appendEvidence,selectEvidence } from '../../worker/src/evidence.js';
import { qualifyModelInvestigation } from '../../worker/src/investigation.js';
import { estimateTrend } from '../../worker/src/trend.js';
import { lighterSupported,priorityFor,LIMITS } from './priority.js';
import {toInvestigation,MINICPM_MODEL,MINICPM_REVISION} from './minicpm.js';

function candidateCauseFrames(qualified,frames) {
  const claim=qualified.hypothesis;
  if(qualified.validation_errors.length || claim?.ignition_source!=='human' || claim.ignition_tool!=='lighter')return [];
  const times=new Map(frames.map(frame=>[frame.frame_id,frame.ts_ms]));
  const ids=kind=>qualified.observations.filter(item=>item.kind===kind).flatMap(item=>item.frame_ids)
    .filter(id=>times.has(id));
  const hands=ids('hand_near_fuel').filter(id=>claim.action_frame_ids.includes(id));
  const tools=ids('flame_at_tool').filter(id=>(qualified.scene_assessment.tool_assertions??[]).some(row=>
    row.frame_id===id && row.tool_type==='lighter' && row.flame_relation==='at_tool_tip'));
  const burning=ids('material_burning');
  for(const hand of hands)for(const tool of tools)for(const material of burning)
    if(times.get(hand)<times.get(tool) && times.get(tool)<times.get(material))return [hand,tool,material];
  return [];
}

export class Coordinator {
  constructor({cameraId,sessionId=randomUUID(),mode='live',store,scout,expectedLighterUse=false,
    siteHazard=false,now=Date.now,onResult=()=>{},streaming=false}) {
    Object.assign(this,{cameraId,sessionId,mode,store,scout,expectedLighterUse,siteHazard,now,onResult,streaming});
    this.native={state:'connecting',received_at_ms:null,text:'',assessment:null};this.nativeFrames=[];this.nativeBarrierTs=-Infinity;
    const previous=mode==='live'?store.previous(cameraId):null;
    this.lifecycle=new DetectionLifecycle({alert:previous?.detection.state==='confirmed'?'confirmed':'idle'});
    this.incidentId=this.lifecycle.alert==='confirmed'?previous.incident_id:null;
    this.fireIncident=this.lifecycle.alert==='confirmed';
    this.smoke={confirmed:previous?.incident_history?.smoke_confirmed??previous?.detection.smoke_status==='confirmed',hits:[],negatives:0,quiet:0};
    this.smoke.signalConfirmed=false;
    if(this.smoke.confirmed)this.incidentId=previous.incident_id;
    this.generation=0;this.current=null;this.receivedAt=null;this.lastTs=null;this.connected=true;this.eof=false;
    this.invalid=false;this.qualityReasons=[];this.scene=null;this.hazardLatch=Boolean(previous?.incident_history?.model_hazard);this.escalation=false;this.pendingAt=null;this.lastVetoTs=-Infinity;
    if(this.hazardLatch && !this.incidentId)this.incidentId=previous.incident_id;
    this.quietObservations=0;
    this.lastNegativeVetoTs=-Infinity;
    this.cause=null;this.causeSupportingFrameIds=[];this.causeAttempts=0;this.inference=null;this.running=null;this.lastDispatch=-Infinity;this.lastAnalyzedTs=-Infinity;
    this.evidence=createEvidenceState();this.images=new Map();this.sceneFrames=[];this.lastPublished=null;this.trendWindow=[];this.growing=false;
    store.start(sessionId,cameraId,mode);
  }
  receiptStale(){return this.mode==='live' && (this.receivedAt===null || this.now()-this.receivedAt>LIMITS.receiptAge);}
  sourceNow(){return this.mode==='live'?Math.max(this.lastTs??0,this.now()):this.lastTs??0;}
  sceneCurrent(){return Boolean(this.scene && !this.scene.failed && this.sourceNow()-(this.scene.startTs??this.scene.endTs)<=LIMITS.sceneAge &&
    this.scene.generation===this.generation && !this.receiptStale());}
  currentNativeAssessment(){return !this.invalid && !this.receiptStale() && this.native.assessment &&
    this.sourceNow()-this.native.assessment_ts_ms<=LIMITS.sceneAge?this.native.assessment:null;}
  modelSignalCurrent(){
    const row=this.currentNativeAssessment();
    return Boolean(row && [row.flame,row.smoke,row.burning_material].includes('present') ||
      this.sceneCurrent() && this.scene?.observations?.some(o=>['flame_visible','flame_at_tool','smoke_visible','material_burning'].includes(o.kind)));
  }
  accept(frame) {
    if(!this.connected) return this.result();
    const o=normalizeObservation(frame);
    if(!o.observation_valid) {this.gap('invalid_observation');return this.result();}
    if(this.lastTs!==null && o.ts_ms<=this.lastTs) return this.result();
    this.qualityReasons=Array.isArray(frame.metrics?.quality_reasons)?frame.metrics.quality_reasons
      .filter(reason=>typeof reason==='string' && /^[a-z_]{1,80}$/.test(reason)).slice(0,16):[];
    if(o.visibility==='degraded' || o.camera_motion===true) {
      this.current=o;this.lastTs=o.ts_ms;this.receivedAt=this.now();this.gap('view_degraded_or_moving');return this.result();
    }
    if(this.lastTs!==null && o.ts_ms-this.lastTs>2000) this.gap('observation_gap');
    this.lastTs=o.ts_ms;this.receivedAt=this.now();this.invalid=false;this.gapReason=null;this.current=o;
    // This expires a detector's CURRENT claim, not the incident. Unknown-quality
    // negatives cannot declare a previous fire/smoke incident resolved or safe.
    this.quietObservations=o.detections.length===0?Math.min(8,this.quietObservations+1):0;
    if(o.detections.length){
      this.lastNegativeVetoTs=o.ts_ms;
      if(this.scene)this.scene.negativeQualified=false;
    }
    if(this.quietObservations>=8)this.smoke.signalConfirmed=false;
    const smokeCandidate=o.smoke.detection_count>0;
    this.smoke.quiet=smokeCandidate?0:Math.min(8,this.smoke.quiet+1);
    if(this.smoke.quiet>=8)this.smoke.signalConfirmed=false;
    // Retain low-score proposals as candidates. The .25 tier is inherited from
    // the detector evidence contract, not a calibrated probability of smoke.
    this.smoke.hits.push({ts:o.ts_ms,strong:o.smoke.confidence>=.25,candidate:smokeCandidate});
    this.smoke.hits=this.smoke.hits.slice(-12);
    const strongSmoke=this.smoke.hits.filter(f=>f.strong);
    if(strongSmoke.length>=5 && strongSmoke.at(-1).ts-strongSmoke[0].ts>=1000)this.smoke.confirmed=this.smoke.signalConfirmed=true;
    this.smoke.negatives=!smokeCandidate && o.visibility==='adequate'?this.smoke.negatives+1:0;
    if(this.smoke.negatives===8){
      this.smoke.confirmed=this.smoke.signalConfirmed=false;this.smoke.hits=[];
      if(!this.fireIncident){
        this.incidentId=null;this.generation++;this.resetNativeEvidence();this.scene=null;this.hazardLatch=false;this.cause=null;this.pendingAt=null;
        this.causeSupportingFrameIds=[];this.sceneFrames=[];this.evidence=createEvidenceState();this.images.clear();
      }
    }
    const before=this.lifecycle.alert;
    let step;
    if(o.detections.length===0 && o.visibility!=='adequate'){
      this.lifecycle.gap();step={transition:null};
    }else step=this.lifecycle.accept(o);
    const fire=o.fire.detection_count>0;
    this.trendWindow.push({ts:o.ts_ms,area_ratio:o.fire.area_fraction,reliable:o.fire.area_reliable,
      camera_motion:o.camera_motion,visibility:o.visibility});
    this.trendWindow=this.trendWindow.filter(f=>f.ts>=o.ts_ms-8000).slice(-24);
    const trend=estimateTrend(this.trendWindow);
    this.growing=trend.visual_activity==='growing' && trend.confidence==='medium' && o.fire.area_reliable &&
      o.visibility==='adequate' && o.camera_motion===false;
    if(fire)this.fireIncident=true;
    const smokeFrames=this.smoke.hits.filter(f=>f.candidate);
    const sustainedSmoke=smokeFrames.length>=3 && smokeFrames.at(-1).ts-smokeFrames[0].ts>=2000;
    if((fire || sustainedSmoke || this.smoke.confirmed) && !this.incidentId) {this.incidentId=randomUUID();this.pendingAt=this.now();this.causeAttempts=0;}
    if(this.incidentId && this.pendingAt===null) this.pendingAt=this.now();
    // Current detector warnings revoke the lease; only validated scene evidence
    // latches a material/smoke hazard for the incident. A weak detector candidate
    // must not permanently poison every future correctly assessed frame.
    if(o.smoke.confidence>=.25 || this.smoke.signalConfirmed || o.fire.detection_count>1 || this.growing) {
      // A conflicting detector proposal revokes monitoring authority, but does
      // not erase an independently valid native scene assessment.
      if(this.streaming && this.scene && !this.scene.failed){this.scene.detectorVeto=true;this.scene.qualified=false;this.scene.negativeQualified=false;}
      else this.scene={failed:true,generation:this.generation};
      this.lastVetoTs=o.ts_ms;
    }
    this.escalation=(this.siteHazard || this.growing) && this.lifecycle.alert==='confirmed';
    const key=`snap:${o.ts_ms}`;
    const added=appendEvidence(this.evidence,o,key);
    if(added.accepted) this.evidence=added.state;
    const image={frame_id:`frame-${o.ts_ms}`,ts_ms:o.ts_ms,frame_wh:o.frame_wh,positive_fire:o.fire.confidence>=.08,positive_smoke:smokeCandidate,
      roles:['recent'],image_b64:frame.image_b64,received_at_ms:this.receivedAt};
    this.images.set(key,image);
    for(const retired of added.retired_keys) this.images.delete(retired);
    this.sceneFrames.push(image);
    this.sceneFrames=this.sceneFrames.filter(f=>f.ts_ms>=o.ts_ms-6000).slice(-24);
    const fireCleared=o.visibility==='adequate' && (step.transition==='cleared' || before==='watch' && this.lifecycle.alert==='idle');
    if(fireCleared)this.fireIncident=false;
    if(fireCleared && !smokeCandidate && !this.smoke.confirmed) {
      this.incidentId=null;this.generation++;this.resetNativeEvidence();this.scene=null;this.hazardLatch=false;this.cause=null;this.causeSupportingFrameIds=[];
      this.pendingAt=null;this.lastVetoTs=-Infinity;this.evidence=createEvidenceState();this.images.clear();this.sceneFrames=[];this.trendWindow=[];
    }
    this.publish('frame');this.maybeAnalyze();return this.result();
  }
  resetNativeEvidence(){
    this.nativeBarrierTs=Math.max(this.nativeBarrierTs,this.sourceNow());
    this.nativeFrames=[];
    this.native={...this.native,assessment:null,assessment_ts_ms:null,text:''};
  }
  gap(reason='capture_gap') {
    this.resetNativeEvidence();
    this.quietObservations=0;
    this.smoke.hits=[];this.smoke.negatives=0;this.smoke.quiet=0;
    this.lifecycle.gap();this.invalid=true;this.generation++;this.scene=null;
    this.sceneFrames=[];this.evidence=createEvidenceState();this.images.clear();this.trendWindow=[];this.growing=false;this.gapReason=reason;
    // Once an assessment has been interrupted, pending cannot mask its failure.
    if(this.incidentId) this.scene={failed:true,generation:this.generation};
    this.publish('gap');
  }
  scenePack() {
    const latest=this.sceneFrames.at(-1)?.ts_ms??0;
    const pool=this.sceneFrames.filter(f=>(f.positive_fire || f.positive_smoke) && f.ts_ms>=latest-3000);
    if(pool.length<3 || pool.at(-1).ts_ms-pool[0].ts_ms<2000) return null;
    return [pool[0],pool[Math.floor(pool.length/2)],pool.at(-1)];
  }
  maybeAnalyze({final=false}={}) {
    if(this.streaming && this.mode==='live')return;
    if(!this.connected || this.eof&&!final || !this.incidentId || !this.current || !final&&!this.current.fire.detection_count&&!this.current.smoke.detection_count || this.invalid || this.receiptStale() ||
       this.running || this.now()-this.lastDispatch<LIMITS.refresh) return;
    const rolling=this.scenePack();if(!rolling) return;
    // First call preserves ignition context; later calls prioritize a full fresh scene.
    const causal=!this.scout.sceneOnly && this.fireIncident && this.causeAttempts===0;
    let frames=rolling;
    if(causal) {
      const onset=selectEvidence(this.evidence).map(f=>({...this.images.get(f.snapshot_key),...f})).filter(f=>f.image_b64).slice(0,3);
      const recent=[rolling[0],rolling[Math.floor(rolling.length/2)],rolling.at(-1)];
      frames=[...new Map([...onset,...recent].map(f=>[f.frame_id,f])).values()].sort((a,b)=>a.ts_ms-b.ts_ms).slice(-6);
    }
    const generation=this.generation,incident=this.incidentId;
    if(causal)this.causeAttempts++;
    this.lastDispatch=this.now();this.lastAnalyzedTs=frames.at(-1).ts_ms;
    const started=this.now();
    const archive=this.store.archive(this.sessionId,frames);
    this.running=Promise.resolve().then(()=>this.scout.analyze(frames,{sessionId:this.sessionId,incidentId:incident,purpose:causal?'cause':'scene',
      timeout:this.mode==='recorded'?60000:LIMITS.timeout,
      shouldRun:()=>this.connected && generation===this.generation && incident===this.incidentId &&
        this.sourceNow()-frames.at(-1).ts_ms<=LIMITS.sceneAge && !this.receiptStale()})).then(response=>{
      const qualified=qualifyModelInvestigation(response.raw,{frames,source:response.source??'workers_ai',model:response.model});
      const metadata={mode:response.mode??'fresh',model:response.model??this.scout.model??'@cf/meta/llama-4-scout-17b-16e-instruct',
        source:response.source??'workers_ai',revision:response.revision??null,
        elapsed_ms:this.now()-started,usage:response.usage??null,validation_errors:qualified.validation_errors,
        frame_ids:frames.map(f=>f.frame_id),started_at_ms:started,completed_at_ms:this.now(),archive,purpose:causal?'cause':'scene'};
      this.store.inference(this.sessionId,{...metadata,raw:JSON.stringify({translated:response.raw,native:response.provider_raw??null}).slice(0,32768)});
      if(!this.connected || generation!==this.generation || incident!==this.incidentId) return;
      this.inference=metadata;
      const category=qualified.scene_assessment.category;
      if(!qualified.validation_errors.length && (category==='material_burning' || category==='smoke_only' || qualified.observations.some(o=>['material_burning','smoke_visible'].includes(o.kind)))) {
        this.hazardLatch=true;
        if(category==='smoke_only' || qualified.observations.some(o=>o.kind==='smoke_visible'))this.smoke.confirmed=this.smoke.signalConfirmed=true;
      }
      this.scene={qualified:lighterSupported(qualified,frames) && qualified.scene_assessment.evidence_interval.start_ts_ms>this.lastVetoTs,
        category,endTs:qualified.scene_assessment.evidence_interval?.end_ts_ms??Math.max(...frames.map(f=>f.ts_ms)),generation,
        failed:qualified.validation_errors.length>0,frame_ids:qualified.scene_assessment.frame_ids,observations:qualified.observations};
      if(causal){this.cause=qualified;this.causeSupportingFrameIds=candidateCauseFrames(qualified,frames);}
      this.publish('assessment');
    }).catch(error=>{
      const failure={mode:'failed',model:this.scout.model??null,source:this.scout.source??'workers_ai',error:error.code??error.message,elapsed_ms:this.now()-started,usage:null,validation_errors:[]};
      this.store.inference(this.sessionId,{...failure,...(error.raw?{raw:String(error.raw).slice(0,32768)}:{})});
      if(!this.connected || generation!==this.generation || incident!==this.incidentId) return;
      this.inference=failure;this.scene={failed:true,generation};this.publish('assessment_failed');
    }).finally(()=>{this.running=null;});
  }
  acceptNativeState(state){
    if(!this.connected)return;
    this.native={...this.native,state};this.publish('native_state');
  }
  acceptNative(report,image){
    if(!this.connected || !this.streaming || report.session_id!==this.sessionId || report.engine!=='minicpm-native-duplex')return;
    this.native={...this.native,state:report.is_listen?'listening':'speaking',received_at_ms:this.now(),
      first_received_at_ms:this.native.first_received_at_ms??this.now(),
      native_chunks:report.native_chunks,source_ts_ms:report.source_ts_ms,elapsed_ms:report.elapsed_ms,
      context_tokens:report.context_tokens,
      text:(report.text??'').slice(0,2048),validation_error:report.validation_error??null,
      received_frames:report.received_frames,dropped_frames:report.dropped_frames};
    if(report.assessment && image?.jpeg){
      const ts=report.assessment_source_ts_ms;
      if(!Number.isSafeInteger(ts) || ts<=this.nativeBarrierTs || this.sourceNow()-ts>LIMITS.sceneAge || ts>this.now()+1000){this.publish('native_stale');return;}
      const frame={frame_id:`frame-${ts}`,ts_ms:ts,roles:['recent'],frame_wh:report.frame_wh??this.current?.frame_wh??[640,480],image_b64:image.jpeg.toString('base64')};
      try{
        toInvestigation({frames:[report.assessment]},[frame]);
        this.native.assessment=report.assessment;this.native.assessment_ts_ms=ts;
        if(!this.nativeFrames.length || ts>this.nativeFrames.at(-1).frame.ts_ms)
          this.nativeFrames=[...this.nativeFrames,{frame,row:report.assessment}]
            .filter(v=>v.frame.ts_ms>=Math.max(ts-8000,this.sourceNow()-LIMITS.sceneAge)).slice(-12);
        // Keep a small pool and choose an actual >=2s interval. The last three
        // fast reports can span 1999ms forever due to source-clock jitter.
        let start=Math.max(0,this.nativeFrames.length-3);
        while(start>0 && this.nativeFrames.at(-1).frame.ts_ms-this.nativeFrames[start].frame.ts_ms<2000)start--;
        const interval=this.nativeFrames.slice(start);
        const samples=interval.length>3?[interval[0],interval[Math.floor((interval.length-1)/2)],interval.at(-1)]:interval;
        const frames=samples.map(v=>v.frame);
        const raw=toInvestigation({frames:samples.map(v=>v.row)},frames);
        const qualified=qualifyModelInvestigation(raw,{frames,source:'modal',model:MINICPM_MODEL});
        const row=report.assessment;
        if(row.flame==='present' || row.smoke==='present' || row.burning_material==='present'){
          if(!this.incidentId){this.incidentId=randomUUID();this.pendingAt=this.now();}
          if(row.flame==='present')this.fireIncident=true;
        }
        if(!qualified.validation_errors.length && (row.burning_material==='present' || row.smoke==='present'))this.hazardLatch=true;
        const clearInterval=interval.every(({row})=>['smoke','burning_material','occlusion'].every(k=>row[k]==='not_observed') &&
          (row.flame==='not_observed' && row.flame_relation==='not_observed' ||
            row.flame==='present' && row.lighter==='present' && row.flame_relation==='at_tool_tip'));
        const lighterEvidence=clearInterval && lighterSupported(qualified,frames);
        const negativeEvidence=!qualified.validation_errors.length && frames.length===3 && frames.at(-1).ts_ms-frames[0].ts_ms>=2000 &&
          interval.every(v=>['flame','smoke','burning_material','occlusion'].every(k=>v.row[k]==='not_observed'));
        this.scene={qualified:lighterEvidence && frames[0].ts_ms>this.lastVetoTs,lighterEvidence,negativeEvidence,
          negativeQualified:negativeEvidence && frames[0].ts_ms>Math.max(this.lastVetoTs,this.lastNegativeVetoTs),
          category:qualified.scene_assessment.category,startTs:frames[0].ts_ms,endTs:ts,generation:this.generation,
          failed:qualified.validation_errors.length>0,frame_ids:frames.map(f=>f.frame_id),observations:qualified.observations};
        this.inference={mode:'fresh',source:'modal',model:MINICPM_MODEL,revision:MINICPM_REVISION,engine:report.engine,
          elapsed_ms:report.elapsed_ms,completed_at_ms:this.now(),purpose:'native_scene',validation_errors:qualified.validation_errors,
          frame_ids:frames.map(f=>f.frame_id),native_chunks:report.native_chunks};
        this.store.inference(this.sessionId,{...this.inference,raw:JSON.stringify(row),archive:this.store.archive(this.sessionId,frames)});
      }catch{this.native.validation_error='native_invalid_report';}
    }
    this.publish('native_result');
  }
  tick() {if(!this.connected)return;this.publish('tick');this.maybeAnalyze();}
  async drain(){if(this.running)await this.running;}
  async finish() {
    this.eof=true;await this.drain();
    const supportedScene=this.inference?.purpose==='scene' && this.scene?.qualified && this.sceneCurrent() && !this.hazardLatch && !this.growing &&
      !this.current?.smoke.detection_count && this.current?.fire.detection_count<=1;
    if(this.lastAnalyzedTs<this.lastTs && !supportedScene) {this.maybeAnalyze({final:true});await this.drain();}
    this.publish('complete','complete');return this.result();
  }
  disconnect() {if(!this.connected)return;this.connected=false;this.generation++;this.resetNativeEvidence();this.publish('disconnect','disconnected');}
  result() {
    const q=this.cause,h=q?.hypothesis;
    const hasFire=Boolean(this.current?.fire.detection_count);
    const nativeCurrent=this.currentNativeAssessment();
    const modelSmoke=nativeCurrent && this.native.assessment.smoke==='present' || this.sceneCurrent() &&
      this.scene?.observations?.some(row=>row.kind==='smoke_visible');
    const smokeNow=Boolean(this.current?.smoke.detection_count) || modelSmoke;
    return {version:1,session_id:this.sessionId,camera_id:this.cameraId,mode:this.mode,incident_id:this.incidentId,
      source_ts_ms:this.lastTs,received_at_ms:this.receivedAt,emitted_at_ms:this.now(),
      detection:{state:this.lifecycle.alert,fire:!this.current || this.invalid?'unknown':hasFire?'detected':'not_detected',
        smoke:!this.current || this.invalid || this.receiptStale()?'unknown':smokeNow?(this.smoke.signalConfirmed || modelSmoke?'detected':'candidate'):'not_detected',
        smoke_status:smokeNow?(this.smoke.signalConfirmed || modelSmoke?'confirmed':'candidate'):this.smoke.confirmed?'historical':'not_detected',
        scene:this.scene?.category??'uncertain',fire_confidence:this.current?.fire.confidence??null,
        smoke_confidence:this.current?.smoke.confidence??null,fire_boxes:this.current?.fire.detection_count??0},
      cause:{status:h?.status==='frame_linked_unverified' || this.causeSupportingFrameIds.length?'hypothesis':
        !this.incidentId&&!hasFire?'not_applicable':'unknown',
        hypothesis:h??null,verified_cause:'unknown',supporting_frame_ids:this.causeSupportingFrameIds,
        observations:q?.observations??[]},
      priority:priorityFor(this),inference:this.inference,
      incident_history:{unresolved:Boolean(this.incidentId),smoke_confirmed:this.smoke.confirmed,
        fire_confirmed:this.lifecycle.alert==='confirmed',model_hazard:this.hazardLatch,quiet_observations:this.quietObservations},
      native_stream:this.streaming?{engine:'minicpm-native-duplex',mode:'native_duplex',...this.native,
        assessment_status:nativeCurrent?'current':this.native.assessment?'expired':this.native.native_chunks?
          this.now()-(this.native.first_received_at_ms??this.now())>LIMITS.sceneAge?'not_reporting':'awaiting_report':'starting',
        state:this.native.received_at_ms!==null && this.now()-this.native.received_at_ms>5000?'stalled':this.native.state}:null,
      scene_assessment:{status:!this.scene?'not_assessed':this.scene.failed?'invalid':this.sceneCurrent()?'current':'expired',
        category:this.scene?.category??'uncertain',observations:this.scene?.observations??[],
        frame_ids:this.scene?.frame_ids??[],end_ts_ms:this.scene?.endTs??null},
      view:{status:!this.current || this.invalid || this.receiptStale()?'unavailable':'available_for_detection',
        reason:!this.current?'no_valid_observation':this.invalid?this.gapReason:this.receiptStale()?'processed_frame_stale':null,
        visibility:this.current?.visibility??'unknown',quality_reasons:this.qualityReasons,
        processed_frame_age_ms:this.receivedAt===null?null:Math.max(0,this.now()-this.receivedAt),
        source_frame_age_ms:this.lastTs===null || this.mode!=='live'?null:this.now()-this.lastTs},
      evidence:{frame_ids:this.scene?.frame_ids??[],scene_end_ts_ms:this.scene?.endTs??null},
      limitations:['operator_priority_is_not_physical_risk','cause_hypothesis_is_unverified']};
  }
  publish(trigger,status='active') {
    const result=this.result();
    const signature=JSON.stringify([result.source_ts_ms,result.priority,result.detection,this.inference?.completed_at_ms,result.native_stream,trigger==='complete']);
    if(signature===this.lastPublished)return;
    this.lastPublished=signature;this.store.save(this.sessionId,result,status);this.onResult({...result,trigger});
  }
}
