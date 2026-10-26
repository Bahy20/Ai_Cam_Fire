import test from 'node:test';
import assert from 'node:assert/strict';
import { contextForCamera } from '../src/site-context.js';
import { CameraDO } from '../src/camera-do.js';
import { normalizeObservation } from '../src/observations.js';
import { createSceneLease, advanceSceneLease, isSceneLeaseExpired,
  validateStoredSceneLease } from '../src/scene-lease.js';

const DAY = 24 * 60 * 60 * 1000;
const reference = 'b'.repeat(64);
const cameraId = 'cam-1';
const incidentId = 'cam-1:1000:1';
const zoneId = 'candle-1';
const context = contextForCamera(JSON.stringify({[cameraId]:{
  reviewed:true, reviewed_by:'operator', reviewed_at_ms:1_000, review_expires_at_ms:1_000 + 30 * DAY,
  context_revision:4, geometry_revision:7, reviewed_reference_image_sha256:reference,
  reference_dimensions:[640,480], crop_rect:[0,0,1,1], expected_flame_use:true,
  source_zones:[{zone_id:zoneId,source_type:'candle',bbox_normalized:[0.2,0.2,0.7,0.8]}],
  occupied_area:false, known_hazards:[], critical_zones:[]
}}), cameraId);

const scene = () => ({contract_version:2, category:'contained_flame',
  frame_ids:['frame-2000','frame-3000'], provenance:'untrusted_model_output',
  support:'insufficient_evidence', validation_errors:[],
  evidence_interval:{start_ts_ms:2_000,end_ts_ms:3_000}, assertions:[
    {frame_id:'frame-2000',source_id:zoneId,detection_ids:['det-2000'],source_type:'candle',containment:'contained',smoke:'not_observed',
      secondary_burning:'not_observed',spread_outside_source:'not_observed',occlusion:'not_observed'},
    {frame_id:'frame-3000',source_id:zoneId,detection_ids:['det-3000'],source_type:'candle',containment:'contained',smoke:'not_observed',
      secondary_burning:'not_observed',spread_outside_source:'not_observed',occlusion:'not_observed'},
  ]});

const chain = () => ({qualified:true, camera_id:cameraId, incident_id:incidentId, session_id:'session-a',
  source_zone_id:zoneId, context_revision:4, geometry_revision:7, reference_image_sha256:reference,
  chain_start_ts_ms:1_000, chain_end_ts_ms:4_000, frame_ids:['frame-1000','frame-2000','frame-3000','frame-4000'],
  max_source_gap_ms:1_000, all_fire_regions_inside_zone:true, unique_region_match:true,
  image_quality_usable:true, background_stable:true, camera_motion:false, smoke_absent:true,
  secondary_burning_absent:true, spread_absent:true, source_geometry_matched:true});

const candidate = patch => ({camera_id:cameraId, incident_id:incidentId, analysis_job_id:2,
  cancellation_generation:9, session_id:'session-a', source_zone_id:zoneId, source_type:'candle',
  site_context:context, scene_assessment:scene(), continuity:chain(),
  supporting_frames:[{frame_id:'frame-2000',source_ts_ms:2_000,received_at_ms:10_000,detection_ids:['det-2000']},
    {frame_id:'frame-3000',source_ts_ms:3_000,received_at_ms:11_000,detection_ids:['det-3000']}],
  current_observation:{source_ts_ms:4_000,received_at_ms:12_000}, now_ms:12_500, ...patch});

test('lease starts at the freshest attached frame and never starts a new five-second clock at VLM completion', () => {
  const lease = createSceneLease(candidate());
  assert.equal(lease.support_source_ts_ms,3_000);
  assert.equal(lease.support_received_at_ms,11_000);
  assert.equal(lease.expires_source_ts_ms,8_000);
  assert.equal(lease.expires_at_ms,16_000);
  assert.equal(lease.remaining_ms_at_issue,3_500);
  assert.equal(lease.useful_at_issue,true);
  assert.equal(isSceneLeaseExpired(lease,{now_ms:15_999,source_ts_ms:7_999}),false);
  assert.equal(isSceneLeaseExpired(lease,{now_ms:16_000,source_ts_ms:null}),true,
    'silence expires on wall time without inventing a camera frame');
  assert.equal(isSceneLeaseExpired(lease,{now_ms:15_000,source_ts_ms:8_001}),true,
    'source time cannot outlive the lease');
});

test('late or mismatched investigation results never issue a live lease', () => {
  for (const patch of [
    {now_ms:16_000}, {current_observation:{source_ts_ms:8_001,received_at_ms:12_000}},
    {current_observation:{source_ts_ms:4_000,received_at_ms:16_001}},
    {continuity:{...chain(),incident_id:'other'}},
    {continuity:{...chain(),context_revision:3}},
    {continuity:{...chain(),max_source_gap_ms:2_001}},
    {continuity:{...chain(),background_stable:false}},
    {site_context:{...context}},
    {scene_assessment:{...scene(),frame_ids:['frame-1000','frame-3000']}},
    {scene_assessment:{...scene(),assertions:scene().assertions.map((row,index)=>index?row:{...row,secondary_burning:'present'})}},
    {scene_assessment:{...scene(),assertions:scene().assertions.slice(0,1)}},
  ]) assert.equal(createSceneLease(candidate(patch)),null,JSON.stringify(patch));
});

test('fractional source timestamps are preserved and a near-expired site review shortens the lease', () => {
  const fractional=candidate({
    scene_assessment:{...scene(),frame_ids:['frame-2000.125','frame-3000.125'],
      evidence_interval:{start_ts_ms:2_000.125,end_ts_ms:3_000.125},assertions:scene().assertions.map((row,index)=>
        ({...row,frame_id:`frame-${index ? '3000.125':'2000.125'}`}))},
    supporting_frames:[{frame_id:'frame-2000.125',source_ts_ms:2_000.125,received_at_ms:10_000,detection_ids:['det-2000']},
      {frame_id:'frame-3000.125',source_ts_ms:3_000.125,received_at_ms:11_000,detection_ids:['det-3000']}],
    current_observation:{source_ts_ms:4_000.125,received_at_ms:12_000},
    continuity:{...chain(),chain_start_ts_ms:1_000.125,chain_end_ts_ms:4_000.125,
      frame_ids:['frame-1000.125','frame-2000.125','frame-3000.125','frame-4000.125']},
  });
  const lease=createSceneLease(fractional);
  assert.equal(lease.support_source_ts_ms,3_000.125);
  assert.equal(lease.expires_source_ts_ms,8_000.125);

  const shortReview=contextForCamera(JSON.stringify({[cameraId]:{
    reviewed:true,reviewed_by:'operator',reviewed_at_ms:1_000,review_expires_at_ms:13_000,
    context_revision:4,geometry_revision:7,reviewed_reference_image_sha256:reference,
    reference_dimensions:[640,480],crop_rect:[0,0,1,1],expected_flame_use:true,
    source_zones:[{zone_id:zoneId,source_type:'candle',bbox_normalized:[0.2,0.2,0.7,0.8]}],
    occupied_area:false,known_hazards:[],critical_zones:[]
  }}),cameraId);
  const shortened=createSceneLease(candidate({site_context:shortReview}));
  assert.equal(shortened.expires_at_ms,13_000);
  assert.equal(shortened.useful_at_issue,false);
});

test('new observations cancel or retain a lease without ever extending its fixed expiry', () => {
  const lease=createSceneLease(candidate());
  const safe={camera_id:cameraId,incident_id:incidentId,session_id:'session-a',source_zone_id:zoneId,
    context_revision:4,geometry_revision:7,source_ts_ms:5_000,received_at_ms:13_000,
    observation_valid:true,fire_region_count:1,unique_region_match:true,inside_reviewed_zone:true,
    camera_motion:false,image_quality_usable:true,background_stable:true,smoke_present:false,
    secondary_burning:false,spread_outside_source:false,continuity_qualified:true,reference_image_sha256:reference,
    now_ms:13_000};
  const retained=advanceSceneLease(lease,safe);
  assert.equal(retained.lease.expires_at_ms,lease.expires_at_ms);
  assert.equal(retained.lease.expires_source_ts_ms,lease.expires_source_ts_ms);
  assert.equal(retained.cancelled,false);
  const secondary=advanceSceneLease(lease,{...safe,secondary_burning:true});
  assert.equal(secondary.lease,null);assert.equal(secondary.hazard_latched,true);
  const spread=advanceSceneLease(lease,{...safe,spread_outside_source:true});
  assert.equal(spread.hazard_latched,true);
  for (const patch of [{smoke_present:true},{camera_motion:true},{inside_reviewed_zone:false},
    {fire_region_count:2},{unique_region_match:false},{continuity_qualified:false},
    {observation_valid:false},{context_revision:5},{incident_id:'other'}]) {
    const result=advanceSceneLease(lease,{...safe,...patch});
    assert.equal(result.lease,null,JSON.stringify(patch));assert.equal(result.cancelled,true);
  }
});

test('stored lease codec rejects unsupported versions and inconsistent expiry or evidence', () => {
  const lease=createSceneLease(candidate());
  assert.deepEqual(validateStoredSceneLease(lease),lease);
  for (const patch of [{version:2},{expires_at_ms:20_000},{support_source_ts_ms:9_000},
    {frame_ids:['frame-2000','frame-2000']},{cancellation_generation:-1}]) {
    assert.throws(()=>validateStoredSceneLease({...lease,...patch}));
  }
});

function liveFixture() {
  const now = Date.now();
  const sourceTimes = [now - 2_000, now - 1_000];
  const liveContext = contextForCamera(JSON.stringify({[cameraId]:{
    reviewed:true, reviewed_by:'operator', reviewed_at_ms:now - 20_000, review_expires_at_ms:now + DAY,
    context_revision:4, geometry_revision:7, reviewed_reference_image_sha256:reference,
    reference_dimensions:[640,480], crop_rect:[0,0,1,1], expected_flame_use:true,
    source_zones:[{zone_id:zoneId,source_type:'candle',bbox_normalized:[0.2,0.2,0.7,0.8]}],
    occupied_area:false, known_hazards:[], critical_zones:[]
  }}), cameraId);
  const frames = sourceTimes.map((ts, index) => ({frame_id:`frame-${ts}`, source_ts_ms:ts,
    received_at_ms:now - 1_000 + index * 250, detection_ids:[`det-live-${index}`]}));
  const liveScene = {contract_version:2, category:'contained_flame', frame_ids:frames.map(frame=>frame.frame_id),
    provenance:'untrusted_model_output', support:'insufficient_evidence', validation_errors:[],
    evidence_interval:{start_ts_ms:sourceTimes[0],end_ts_ms:sourceTimes[1]},
    assertions:frames.map((frame,index)=>({frame_id:frame.frame_id,source_id:zoneId,
      detection_ids:[...frame.detection_ids],source_type:'candle',containment:'contained',smoke:'not_observed',
      secondary_burning:'not_observed',spread_outside_source:'not_observed',occlusion:'not_observed'}))};
  const incident = `${cameraId}:${now - 4_000}:1`;
  const candidate = {camera_id:cameraId,incident_id:incident,analysis_job_id:2,cancellation_generation:9,
    session_id:'session-live',source_zone_id:zoneId,source_type:'candle',site_context:liveContext,
    scene_assessment:liveScene,continuity:{qualified:true,camera_id:cameraId,incident_id:incident,
      session_id:'session-live',source_zone_id:zoneId,context_revision:4,geometry_revision:7,
      reference_image_sha256:reference,chain_start_ts_ms:sourceTimes[0],chain_end_ts_ms:now,
      frame_ids:[...frames.map(frame=>frame.frame_id),`frame-${now}`],max_source_gap_ms:1_000,
      all_fire_regions_inside_zone:true,unique_region_match:true,image_quality_usable:true,
      background_stable:true,camera_motion:false,smoke_absent:true,secondary_burning_absent:true,
      spread_absent:true,source_geometry_matched:true}, supporting_frames:frames,
    current_observation:{source_ts_ms:now,received_at_ms:now}, now_ms:now};
  const sent=[];
  const camera=new CameraDO({storage:{},getWebSockets:()=>[{send:value=>sent.push(JSON.parse(value))}]},
    {EVIDENCE_STORAGE:'pi'});
  camera.startEnrichment=()=>{};
  camera.cameraId=cameraId;camera.contextCamera=cameraId;camera.siteContext=liveContext;
  camera.sessionId='session-live';camera.alert='confirmed';camera.incidentId=incident;
  camera.incidentSequence=1;camera.analysisJob=2;camera.sceneLeaseGeneration=9;
  camera.lastObservationTs=now;camera.lastReceiptAtMs=now;camera.fire={startedAt:now-4_000,peakArea:900};
  camera.currentObservation=normalizeObservation({ts_ms:now,frame_wh:[640,480],camera_motion:false,
    detections:[{cls:'fire',conf:0.8,bbox_xyxy:[250,240,280,280]}]});
  camera.measurement={area_px:1_200,area_fraction:1_200/(640*480),area_reliable:true,
    frame_wh:[640,480],visibility_status:'adequate'};
  camera.cause={scene_assessment:liveScene,validation_errors:[]};
  camera.evidenceManifest=frames.map(frame=>({frame_id:frame.frame_id,ts_ms:frame.source_ts_ms}));
  return {camera,candidate,sent,now};
}

test('camera issues a live monitor update only from a complete current lease, then alarm expiry returns to urgent', async () => {
  const {camera,candidate,sent,now}=liveFixture();
  const reassessment=camera.applySceneReassessment(candidate);
  assert.equal(reassessment?.response_priority,'monitor');
  assert.equal(reassessment.trigger,'model_result');
  assert.equal(reassessment.evidence_source_ts_ms,candidate.supporting_frames.at(-1).source_ts_ms);
  assert.ok(camera.sceneLease);
  assert.equal(camera.snapshot().response_priority,'monitor');

  const lease=camera.sceneLease;
  let scheduled=null;
  camera.state.storage={getAlarm:async()=>null,setAlarm:async value=>{scheduled=value;},sync:async()=>{}};
  camera.journal={assertCurrent(){},pending(){return [];}};
  camera.saveCoordinator=()=>{};
  await camera.armEarliestAlarm(lease.expires_at_ms+10_000);
  assert.equal(scheduled,lease.expires_at_ms,'the durable alarm is capped by the lease deadline');
  const actualNow=Date.now;
  Date.now=()=>lease.expires_at_ms;
  try { await camera.alarm(); }
  finally { Date.now=actualNow; }
  assert.equal(camera.sceneLease,null);
  assert.equal(camera.sceneLeaseGeneration,10);
  assert.equal(camera.snapshot().response_priority,'inspect_urgently');
  const expiry=sent.flatMap(item=>Array.isArray(item)?item:[item]).at(-1);
  assert.equal(expiry.trigger,'lease_expiry');
  assert.equal(expiry.ts_ms,lease.support_source_ts_ms,'expiry keeps the last camera timestamp');
  assert.equal(expiry.evidence_source_ts_ms,lease.support_source_ts_ms);
  assert.equal(expiry.effective_at_ms,lease.expires_at_ms);
  assert.ok(expiry.event_sequence > reassessment.event_sequence);
  assert.equal(expiry.type,'fire_update');
  assert.notEqual(expiry.type,'fire_cleared');
  assert.ok(now<=lease.expires_at_ms);
});

test('a new detector frame without edge continuity cancels a live lease and restores urgency', () => {
  const {camera,candidate,sent}=liveFixture();
  assert.equal(camera.applySceneReassessment(candidate)?.response_priority,'monitor');
  const nextTs=camera.lastObservationTs+100;
  const result=camera.ingest({ts_ms:nextTs,frame_wh:[640,480],camera_motion:false,
    detections:[{cls:'fire',conf:0.8,bbox_xyxy:[250,240,280,280]}]},cameraId);
  assert.equal(camera.sceneLease,null);
  assert.equal(camera.sceneLeaseGeneration,10);
  const event=sent.flatMap(item=>Array.isArray(item)?item:[item]).at(-1);
  assert.equal(event.trigger,'observation');
  assert.equal(event.response_priority,'inspect_urgently');
  assert.deepEqual(result.published,['fire_update']);
});

test('secondary burning latches urgent priority for the whole incident', () => {
  const {camera,candidate,sent}=liveFixture();
  const burning={...candidate.scene_assessment,category:'material_burning',assertions:
    candidate.scene_assessment.assertions.map((row,index)=>index===1?{...row,secondary_burning:'present'}:row)};
  candidate.scene_assessment=burning;
  camera.cause.scene_assessment=burning;
  const event=camera.applySceneReassessment(candidate);
  assert.equal(event?.response_priority,'inspect_urgently');
  assert.equal(event?.trigger,'model_result');
  assert.equal(camera.sceneLease,null);
  assert.equal(camera.sceneHazardLatchIncidentId,camera.incidentId);
  const staleSafe={...candidate,scene_assessment:{...burning,category:'contained_flame',
    assertions:burning.assertions.map(row=>({...row,secondary_burning:'not_observed'}))}};
  camera.cause.scene_assessment=staleSafe.scene_assessment;
  assert.equal(camera.applySceneReassessment(staleSafe),null);
  assert.equal(camera.sceneHazardLatchIncidentId,camera.incidentId);
  assert.equal(camera.snapshot().response_priority,'inspect_urgently');
  const events=sent.flatMap(item=>Array.isArray(item)?item:[item]);
  assert.equal(events.at(-1).response_priority,'inspect_urgently');
});
