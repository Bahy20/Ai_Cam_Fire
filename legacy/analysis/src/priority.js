import { scoutHandheldAssessmentApplies } from '../../worker/src/investigation.js';

export const POLICY_VERSION='two-server-priority-v6';
export const LIMITS=Object.freeze({refresh:5000,pending:30000,timeout:30000,sceneAge:10000,receiptAge:5000});

// Structural checks are shared with the existing Scout V3 validator. Freshness
// is enforced separately using the real source and receipt clocks, never rebased.
export function lighterSupported(qualified,frames) {
  const scene=qualified.scene_assessment;
  return scoutHandheldAssessmentApplies(scene,{frames,observations:qualified.observations,
    ts_ms:scene.evidence_interval?.end_ts_ms,evidence_current:true,chronological_match:true,
    model_result_valid:qualified.validation_errors.length===0});
}
export function priorityFor(c) {
  const common={policy_version:POLICY_VERSION,scope:c.mode==='live'?'live':'observed_interval'};
  const answer=(level,reason,label)=>({...common,level,reason,label});
  if(!c.connected) return answer('unknown','disconnected','Analysis connection unavailable');
  if(!c.current) return c.hazardLatch?answer('inspect_urgently','verified_hazard_unresolved','Previous visual hazard unresolved — inspect urgently'):
    answer('unknown','no_valid_observation','Waiting for video');
  const active=c.hazardLatch || c.lifecycle.alert==='confirmed' || Boolean(c.incidentId) || c.smoke?.confirmed;
  if(c.receiptStale() || c.invalid) return answer(active?'inspect_urgently':'unknown','observation_unavailable','Current view unavailable');
  if(c.escalation) return answer('escalate',c.growing?'supported_growth':'reviewed_site_hazard','Confirmed fire requires escalation');
  if(!c.hazardLatch && !c.siteHazard && !c.growing && c.sceneCurrent() && (c.scene.negativeEvidence || c.scene.lighterEvidence)){
    const conflict=c.current.smoke.detection_count>0 || c.current.fire.detection_count>(c.scene.negativeEvidence?0:1);
    if(conflict)return answer('unknown','detector_model_disagreement','Detector warning not corroborated by recent visual reports — review required');
    if(c.scene.negativeQualified)return answer('monitor','no_visual_hazard_observed','No flame or smoke observed in recent scene — monitor');
    if(c.scene.negativeEvidence)return answer('unknown','recent_warning_unverified','Recent warning remains unresolved — waiting for renewed visual evidence');
    if(c.scene.lighterEvidence && c.expectedLighterUse && !c.scene.qualified)
      return answer('unknown','recent_warning_unverified','Lighter scene observed; recent detector warning still needs review');
  }
  if(active && !c.hazardLatch && !c.modelSignalCurrent() && c.quietObservations>=8 && c.current.visibility!=='adequate')
    return answer('unknown','historical_signal_unverified','Previous alert not re-observed — unresolved; review required');
  if(c.hazardLatch || c.smoke?.signalConfirmed || c.current.smoke.confidence>=.25 && c.fireIncident || c.current.fire.detection_count>1) return answer('inspect_urgently','smoke_or_secondary_fire','Smoke or other fire evidence — inspect urgently');
  if(!c.fireIncident && (c.current.smoke.detection_count>0 || c.incidentId)) return answer('pending','smoke_unconfirmed','Possible smoke — unconfirmed; assessing scene');
  if(c.current.smoke.detection_count>0 && c.scene?.qualified && c.expectedLighterUse && c.sceneCurrent())
    return answer('pending','smoke_unconfirmed','Possible smoke — unconfirmed; reassessing lighter scene');
  if(!active && c.current.fire.detection_count===0) return answer('monitor','no_current_detection','No flame or smoke detected');
  if(c.scene && c.scene.qualified && c.expectedLighterUse && c.sceneCurrent() && c.current.fire.detection_count<=1)
    return answer('monitor','contained_lighter',c.current.fire.detection_count?'Lighter flame visible — monitor':'Contained lighter scene — monitor');
  if(c.scene?.failed || c.scene && !c.sceneCurrent()) return answer('inspect_urgently','scene_failed_or_expired','Scene assessment unavailable or expired');
  if(c.scene && !c.scene.qualified) return answer('inspect_urgently','scene_uncertain','Flame scene needs inspection');
  if(c.pendingAt!==null && c.now()-c.pendingAt<LIMITS.pending && !c.scene)
    return answer('pending','scene_pending','Flame detected — assessing scene');
  return answer('inspect_urgently','assessment_required','Flame requires inspection');
}
