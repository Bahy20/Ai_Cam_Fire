import {randomUUID} from 'node:crypto';
import {qualifyModelInvestigation,scoutHandheldAssessmentApplies} from '../../worker/src/investigation.js';
import {toInvestigation,MINICPM_MODEL,MINICPM_REVISION} from './minicpm.js';

export const POLICY_VERSION='minicpm-only-v2';
const AGE=10000,RECEIPT=5000;
const clearObservation=row=>['flame','smoke','burning_material','occlusion','flame_relation'].every(k=>row[k]==='not_observed');
function lighterSupported(q,frames){
  const scene=q.scene_assessment;
  return scoutHandheldAssessmentApplies(scene,{frames,observations:q.observations,
    ts_ms:scene.evidence_interval?.end_ts_ms,evidence_current:true,chronological_match:true,
    model_result_valid:q.validation_errors.length===0});
}

// Production coordinator: only validated VLM findings can supply detections.
// Pixel measurements can reject a view but cannot assert absence of fire.
export class VlmCoordinator {
  constructor({cameraId,sessionId=randomUUID(),mode='live',store,scout,expectedLighterUse=false,
    siteHazard=false,now=Date.now,onResult=()=>{},streaming=false}){
    Object.assign(this,{cameraId,sessionId,mode,store,scout,expectedLighterUse,siteHazard,now,onResult,streaming});
    const previous=mode==='live'?store.previous(cameraId):null;
    this.hazardLatch=Boolean(previous?.incident_history?.model_hazard);
    this.incidentId=this.hazardLatch?previous.incident_id??randomUUID():null;
    this.latestHazard=this.hazardLatch?previous?.incident_history?.latest_hazard??null:null;
    this.hazardSmoke=this.hazardLatch&&Boolean(previous?.incident_history?.smoke_confirmed);
    this.hazardFire=this.hazardLatch&&Boolean(previous?.incident_history?.fire_confirmed);
    this.lastReview=previous?.incident_history?.last_review??null;
    this.connected=true;this.current=null;this.lastTs=null;this.receivedAt=null;this.invalid=false;
    this.generation=0;this.barrier=-Infinity;this.rows=[];this.images=[];this.scene=null;this.lastRow=null;
    this.clearRows=[];this.lastAcceptedTs=-Infinity;
    this.native={state:'connecting',started_at_ms:this.now(),assessment:null,assessment_ts_ms:null};
    this.inference=null;this.running=null;this.lastDispatch=-Infinity;this.lastAnalyzedTs=-Infinity;this.eof=false;
    store.start(sessionId,cameraId,mode);
  }
  sourceNow(){return this.mode==='live'?Math.max(this.lastTs??0,this.now()):this.lastTs??0;}
  receiptStale(){return this.mode==='live'&&(this.receivedAt===null||this.now()-this.receivedAt>RECEIPT);}
  usable(){return Boolean(this.connected&&this.current&&!this.invalid&&!this.receiptStale());}
  currentRow(){return this.usable()&&this.lastRow&&this.sourceNow()-this.lastRow.frame.ts_ms<=AGE?this.lastRow.row:null;}
  sceneCurrent(){return this.usable()&&this.scene&&this.scene.generation===this.generation&&
    this.sourceNow()-this.scene.startTs<=AGE;}
  clearEvidenceCurrent(){return Boolean(this.clearRows.length===8&&this.sceneCurrent()&&this.scene.negative);}
  accept(frame){
    if(!this.connected)return this.result();
    if(!Number.isSafeInteger(frame.ts_ms)||frame.ts_ms<0||!Array.isArray(frame.frame_wh)||
      frame.frame_wh.length!==2||!frame.frame_wh.every(v=>Number.isInteger(v)&&v>0&&v<=1920)||
      typeof frame.image_b64!=='string'||!['adequate','unknown','degraded'].includes(frame.visibility)){
      this.gap('invalid_frame');return this.result();
    }
    if(this.lastTs!==null&&frame.ts_ms<=this.lastTs)return this.result();
    if(this.lastTs!==null&&frame.ts_ms-this.lastTs>2000)this.gap('observation_gap');
    this.current=frame;this.lastTs=frame.ts_ms;this.receivedAt=this.now();
    if(frame.visibility==='degraded'||frame.camera_motion===true){this.gap('view_degraded_or_moving');return this.result();}
    this.invalid=false;this.gapReason=null;
    this.images=[...this.images,{frame_id:`frame-${frame.ts_ms}`,ts_ms:frame.ts_ms,frame_wh:frame.frame_wh,
      roles:['recent'],image_b64:frame.image_b64}].filter(f=>f.ts_ms>=frame.ts_ms-8000).slice(-24);
    this.publish('frame');this.maybeAnalyze();return this.result();
  }
  gap(reason='capture_gap'){
    this.barrier=Math.max(this.barrier,this.sourceNow());this.generation++;this.invalid=true;this.gapReason=reason;
    this.rows=[];this.images=[];this.scene=null;this.lastRow=null;this.clearRows=[];
    this.native={...this.native,assessment:null,assessment_ts_ms:null,text:''};this.publish('gap');
  }
  acceptNativeState(state){if(this.connected){
    if(['unavailable','reconnecting','invalid_response','stalled'].includes(state)){
      this.scene=null;this.lastRow=null;this.rows=[];this.clearRows=[];this.barrier=Math.max(this.barrier,this.sourceNow());
      this.native={...this.native,assessment:null,assessment_ts_ms:null};
    }
    this.native={...this.native,state};this.publish('native_state');
  }}
  applyRows(rows,frames){
    toInvestigation({frames:rows},frames); // Validate the complete response before changing state.
    for(let i=0;i<rows.length;i++){
      const row=rows[i],frame=frames[i],ts=frame.ts_ms;
      if(ts<=this.barrier||ts<=this.lastAcceptedTs||this.sourceNow()-ts>AGE||ts>this.sourceNow()||
        this.lastRow&&ts<=this.lastRow.frame.ts_ms)continue;
      this.lastRow={row,frame};this.lastAcceptedTs=ts;
      if(clearObservation(row)){
        if(this.clearRows.length&&ts-this.clearRows.at(-1).ts_ms>5000)this.clearRows=[];
        this.clearRows=[...this.clearRows,{frame_id:frame.frame_id,ts_ms:ts}].slice(-8);
      }else this.clearRows=[];
      this.rows=[...this.rows,{row,frame}].filter(v=>v.frame.ts_ms>=ts-8000).slice(-12);
      if(row.flame==='present'||row.smoke==='present'||row.burning_material==='present')this.incidentId??=randomUUID();
      if(row.smoke==='present'||row.burning_material==='present'||row.flame==='present'&&row.flame_relation==='separate'){
        this.hazardLatch=true;this.latestHazard={ts_ms:ts,frame_id:frame.frame_id,smoke:row.smoke,flame:row.flame,
          burning_material:row.burning_material,description:row.description};
        this.hazardSmoke||=row.smoke==='present';this.hazardFire||=row.flame==='present'||row.burning_material==='present';
      }
    }
    if(!this.rows.length)return;
    let start=Math.max(0,this.rows.length-3);
    while(start>0&&this.rows.at(-1).frame.ts_ms-this.rows[start].frame.ts_ms<2000)start--;
    const interval=this.rows.slice(start),samples=interval.length>3?[interval[0],interval[Math.floor((interval.length-1)/2)],interval.at(-1)]:interval;
    const support=samples.map(v=>v.frame);
    const q=qualifyModelInvestigation(toInvestigation({frames:samples.map(v=>v.row)},support),{frames:support,source:'modal',model:MINICPM_MODEL});
    const temporal=support.length===3&&support.at(-1).ts_ms-support[0].ts_ms>=2000&&!q.validation_errors.length;
    const unobscured=v=>['smoke','burning_material','occlusion'].every(k=>v[k]==='not_observed');
    const negative=temporal&&interval.every(({row:r})=>unobscured(r)&&r.flame==='not_observed'&&r.flame_relation==='not_observed');
    const contained=temporal&&interval.every(({row:r})=>unobscured(r)&&
      (r.flame==='not_observed'&&r.flame_relation==='not_observed'||
       r.flame==='present'&&r.lighter==='present'&&r.flame_relation==='at_tool_tip'))&&lighterSupported(q,support);
    this.scene={negative,contained,startTs:support[0].ts_ms,endTs:support.at(-1).ts_ms,generation:this.generation,
      category:negative?'no_visual_hazard':q.scene_assessment.category,frame_ids:support.map(f=>f.frame_id),observations:q.observations};
  }
  acceptNative(report,image){
    if(!this.connected||!this.streaming||report.session_id!==this.sessionId||!['minicpm-native-duplex','minicpm-native-visual'].includes(report.engine))return;
    this.native={...this.native,engine:report.engine,mode:report.engine==='minicpm-native-visual'?'native_visual_stream':'native_duplex',
      context_epoch:report.context_epoch,state:report.is_listen?'listening':'speaking',received_at_ms:this.now(),
      first_received_at_ms:this.native.first_received_at_ms??this.now(),native_chunks:report.native_chunks,
      source_ts_ms:report.source_ts_ms,elapsed_ms:report.elapsed_ms,context_tokens:report.context_tokens,
      text:(report.text??'').slice(0,2048),validation_error:report.validation_error??null,
      received_frames:report.received_frames,dropped_frames:report.dropped_frames};
    if(report.validation_error){
      this.scene=null;this.lastRow=null;this.rows=[];this.clearRows=[];
      this.native.assessment=null;this.native.assessment_ts_ms=null;
      this.barrier=Math.max(this.barrier,this.sourceNow());
      this.publish('native_invalid_report');return;
    }
    if(report.assessment&&image?.jpeg&&this.usable()){
      const ts=report.assessment_source_ts_ms;
      if(Number.isSafeInteger(ts)&&ts>this.barrier&&ts>this.lastAcceptedTs&&ts<=this.sourceNow()&&this.sourceNow()-ts<=AGE&&
        (!this.lastRow||ts>this.lastRow.frame.ts_ms)){
        const frame={frame_id:`frame-${ts}`,ts_ms:ts,frame_wh:report.frame_wh??this.current.frame_wh,
          roles:['recent'],image_b64:image.jpeg.toString('base64')};
        try{
          this.applyRows([report.assessment],[frame]);
          this.native.assessment=report.assessment;this.native.assessment_ts_ms=ts;
          this.inference={mode:'fresh',source:'modal',model:MINICPM_MODEL,revision:MINICPM_REVISION,engine:report.engine,
            elapsed_ms:report.elapsed_ms,completed_at_ms:this.now(),purpose:'native_scene',validation_errors:[],frame_ids:[frame.frame_id],native_chunks:report.native_chunks};
          this.store.inference(this.sessionId,{...this.inference,raw:JSON.stringify(report.assessment),archive:this.store.archive(this.sessionId,[frame])});
        }catch{this.native.validation_error='native_invalid_report';this.scene=null;this.lastRow=null;this.rows=[];this.clearRows=[];
          this.barrier=Math.max(this.barrier,this.sourceNow());}
      }
    }
    this.publish('native_result');
  }
  maybeAnalyze({final=false}={}){
    if(this.streaming||!this.usable()||!this.scout?.configured||this.running||this.images.length<(final?1:3)||
      this.lastTs<=this.lastAnalyzedTs||!final&&this.sourceNow()-this.lastDispatch<5000)return;
    const pool=this.images.filter(f=>f.ts_ms>=this.lastTs-8000);
    if(!pool.length||!final&&(pool.length<3||pool.at(-1).ts_ms-pool[0].ts_ms<2000))return;
    const frames=pool.length<3?pool:[pool[0],pool[Math.floor((pool.length-1)/2)],pool.at(-1)],generation=this.generation;
    this.lastDispatch=this.sourceNow();this.lastAnalyzedTs=frames.at(-1).ts_ms;
    const started=this.now(),archive=this.store.archive(this.sessionId,frames);
    this.running=Promise.resolve().then(()=>this.scout.analyze(frames,{timeout:this.mode==='recorded'?60000:30000,
      shouldRun:()=>this.connected&&generation===this.generation&&this.usable()&&this.sourceNow()-frames[0].ts_ms<=AGE})).then(response=>{
      const metadata={mode:response.mode??'fresh',source:'modal',model:MINICPM_MODEL,revision:MINICPM_REVISION,
        purpose:'scene',frame_ids:frames.map(f=>f.frame_id),usage:response.usage??null,elapsed_ms:this.now()-started,completed_at_ms:this.now(),validation_errors:[]};
      // A translated prose observation cannot substitute for the strict per-image enums.
      toInvestigation(response.assessment,frames);
      this.store.inference(this.sessionId,{...metadata,raw:String(response.provider_raw??'').slice(0,32768),archive});
      if(!this.connected||generation!==this.generation||!this.usable()||this.sourceNow()-frames[0].ts_ms>AGE)return;
      this.applyRows(response.assessment.frames,frames);this.inference=metadata;this.publish('assessment');
    }).catch(error=>{
      const failure={mode:'failed',source:'modal',model:MINICPM_MODEL,error:error.message,elapsed_ms:this.now()-started,usage:null,validation_errors:[]};
      this.store.inference(this.sessionId,{...failure,...(error.raw?{raw:String(error.raw).slice(0,32768)}:{})});
      if(!this.connected||generation!==this.generation)return;
      this.inference=failure;this.scene=null;this.lastRow=null;this.rows=[];this.clearRows=[];
      this.barrier=Math.max(this.barrier,this.sourceNow());this.publish('assessment_failed');
    }).finally(()=>{this.running=null;});
  }
  priority(){
    const answer=(level,reason,label)=>({policy_version:POLICY_VERSION,scope:this.mode==='live'?'live':'observed_interval',level,reason,label});
    if(!this.connected)return answer('unknown','disconnected','Analysis connection unavailable');
    if(this.hazardLatch&&!this.clearEvidenceCurrent()){
      const current=this.currentRow();const present=current&&(current.smoke==='present'||current.burning_material==='present'||current.flame==='present'&&current.flame_relation==='separate');
      return answer(this.siteHazard?'escalate':'inspect_urgently','verified_hazard_unresolved',present?
        'Fire or smoke observed — inspect urgently':'Earlier fire/smoke alert unresolved — operator review required');
    }
    if(!this.usable()){
      const dark=this.invalid&&(this.current?.metrics?.quality_reasons??[]).some(r=>['uniform_extreme_luminance','insufficient_scene_illumination'].includes(r));
      return dark?answer('unknown','camera_dark_or_blank','Camera image is dark or blank — check the camera and lighting'):
        answer('unknown','observation_unavailable','Current view unavailable');
    }
    const row=this.currentRow();
    if(!row&&this.streaming&&['connecting','reconnecting'].includes(this.native.state))return answer('unknown','model_starting',
      this.native.state==='reconnecting'?'Reconnecting live analysis — keep the camera running':'Starting live analysis — keep the camera running');
    if(!row&&this.streaming&&this.native.state==='unavailable')return answer('unknown','model_unavailable','Live analysis connection failed — reconnect the webcam');
    if(!row&&this.streaming&&this.native.validation_error)return answer('unknown','model_report_invalid','Live model report incomplete — waiting for a valid report');
    if(!row)return answer('unknown','assessment_required','Waiting for a current valid visual assessment');
    if(row.occlusion!=='not_observed')return answer('unknown','scene_uncertain','Scene unclear — review required');
    if(this.siteHazard&&row.flame==='present')return answer('escalate','reviewed_site_hazard','Flame in a hazardous location — inspect urgently');
    if(this.sceneCurrent()&&this.scene.negative)return answer('monitor','no_visual_hazard_observed','No flame or smoke observed in recent scene — monitor');
    if(this.sceneCurrent()&&this.scene.contained&&this.expectedLighterUse)return answer('monitor','contained_lighter','Lighter flame at its tip; no secondary burning observed — monitor');
    if(row.flame==='present'){
      if(row.lighter==='present'&&row.flame_relation==='at_tool_tip'&&this.expectedLighterUse)
        return answer('unknown','lighter_evidence_pending','Lighter observed — gathering repeated scene evidence');
      return answer('inspect_urgently','uncontained_flame','Flame needs inspection');
    }
    return answer('unknown','scene_uncertain','Insufficient clear visual evidence — review required');
  }
  result(){
    const row=this.currentRow(),fresh=Boolean(row),sceneCurrent=this.sceneCurrent();
    const status=v=>!fresh||v==='uncertain'?'unknown':v==='present'?'detected':'not_detected';
    const available=this.usable();
    return {version:1,session_id:this.sessionId,camera_id:this.cameraId,mode:this.mode,incident_id:this.incidentId,
      source_ts_ms:this.lastTs,received_at_ms:this.receivedAt,emitted_at_ms:this.now(),
      detection:{source:'minicpm',state:this.hazardLatch&&!this.clearEvidenceCurrent()?'confirmed':row?.flame==='present'?'watch':fresh?'idle':'unknown',
        fire:status(row?.flame),smoke:status(row?.smoke),smoke_status:status(row?.smoke),scene:sceneCurrent?this.scene.category:'uncertain'},
      priority:this.priority(),inference:this.inference,
      cause:{status:'unknown',hypothesis:null,verified_cause:'unknown',supporting_frame_ids:[],observations:[]},
      incident_history:{unresolved:Boolean(this.incidentId),model_hazard:this.hazardLatch,smoke_confirmed:this.hazardSmoke,
        fire_confirmed:this.hazardFire,
        latest_hazard:this.latestHazard,last_review:this.lastReview,reviewable:this.mode==='live'&&this.connected&&this.hazardLatch,
        clear_observations:this.clearRows.length,clear_required:8,clear_evidence_current:this.clearEvidenceCurrent()},
      native_stream:this.streaming?{engine:'minicpm-native-visual',mode:'native_visual_stream',...this.native,startup_elapsed_ms:Math.max(0,this.now()-this.native.started_at_ms),
        assessment_status:fresh?'current':this.native.assessment?'expired':this.native.native_chunks?
          this.now()-(this.native.first_received_at_ms??this.now())>AGE?'not_reporting':'awaiting_report':'starting'}:null,
      scene_assessment:{status:sceneCurrent?'current':this.scene?'expired':'not_assessed',category:sceneCurrent?this.scene.category:'uncertain',
        observations:sceneCurrent?this.scene.observations:[],frame_ids:sceneCurrent?this.scene.frame_ids:[],end_ts_ms:this.scene?.endTs??null},
      view:{status:available?'available_for_analysis':'unavailable',reason:available?null:this.gapReason??'no_valid_observation',
        visibility:this.current?.visibility??'unknown',quality_reasons:this.current?.metrics?.quality_reasons??[],
        processed_frame_age_ms:this.receivedAt===null?null:Math.max(0,this.now()-this.receivedAt),
        source_frame_age_ms:this.mode==='live'&&this.lastTs!==null?Math.max(0,this.now()-this.lastTs):null},
      evidence:{frame_ids:sceneCurrent?this.scene.frame_ids:[],scene_end_ts_ms:this.scene?.endTs??null},
      limitations:['operator_priority_is_not_physical_risk','cause_is_unverified','model_only_visual_assessment']};
  }
  publish(trigger,status='active'){const result=this.result();this.store.save(this.sessionId,result,status);this.onResult({...result,trigger});}
  reviewAlert({incident_id,last_hazard_ts_ms,action,actor}){
    if(!['false_alarm','incident_resolved'].includes(action))throw new Error('invalid_review_action');
    if(!this.connected||this.mode!=='live'||!this.hazardLatch||incident_id!==this.incidentId||last_hazard_ts_ms!==(this.latestHazard?.ts_ms??null))throw new Error('alert_updated_review_again');
    const review={incident_id,action,actor,reviewed_at_ms:this.now(),last_hazard:this.latestHazard};
    this.store.review(this.sessionId,review);
    const invalid=this.invalid;
    this.lastReview=review;this.hazardLatch=false;this.hazardSmoke=false;this.hazardFire=false;this.incidentId=null;this.latestHazard=null;
    this.gap('operator_review');this.invalid=invalid;
    this.native={state:'connecting',started_at_ms:this.now(),assessment:null,assessment_ts_ms:null};
    this.inference=null;this.publish('operator_review');return this.result();
  }
  tick(){if(this.connected){if(this.receiptStale())this.clearRows=[];this.publish('tick');this.maybeAnalyze();}}
  async drain(){if(this.running)await this.running;}
  async finish(){await this.drain();this.maybeAnalyze({final:true});await this.drain();this.eof=true;this.publish('complete','complete');return this.result();}
  disconnect(){if(!this.connected)return;this.connected=false;this.generation++;this.publish('disconnect','disconnected');}
}
