import test from 'node:test';
import assert from 'node:assert/strict';
import * as rules from '../src/rules.js';
import {contextForCamera} from '../src/site-context.js';
import {createHandheldLease} from '../src/handheld-lease.js';

const current = (extra = {}) => ({ camera_id: 'cam-a', ts_ms: 2000,
  detection_status: 'confirmed', observation_valid: true,
  visibility_status: 'adequate', camera_motion: false, evidence_current: true,
  visual_activity: 'unknown', trend_confidence: 'low', trend_sample_count: 0,
  trend_duration_s: 0, trend_limitations: [], smoke_evidence: 'not_detected', ...extra });
const assess = extra => {
  assert.equal(typeof rules.assessResponsePriority, 'function');
  return rules.assessResponsePriority(current(extra));
};

test('only a current valid idle observation can monitor; smoke and stale visibility never mean clear', () => {
  assert.equal(assess({ detection_status: 'idle' }).response_priority, 'monitor');
  for (const extra of [{ detection_status: 'watch' },
    { detection_status: 'idle', smoke_evidence: 'strong' },
    { detection_status: 'idle', smoke_evidence: 'weak' },
    { detection_status: 'idle', smoke_evidence: 'unknown' },
    { detection_status: 'idle', evidence_current: false },
    { detection_status: 'idle', observation_valid: false },
    { detection_status: 'idle', visibility_status: 'degraded' },
    { detection_status: 'idle', visibility_status: 'unknown' }]) {
    const result = assess(extra);
    assert.equal(result.response_priority, 'inspect_urgently');
    assert.ok(!JSON.stringify(result).includes('safe_to_suppress'));
  }
});

test('forged context and contradictory idle metadata cannot masquerade as clean monitoring', () => {
  for (const extra of [{ site_context: { reviewed: true } }, { visual_activity: 'growing' },
    { visual_activity: 'shrinking' }, { area_reliable: true }]) {
    const result = assess({ detection_status: 'idle', ...extra });
    assert.equal(result.response_priority, 'inspect_urgently');
    if (extra.site_context) assert.equal(result.assessment_quality, 'invalid');
  }
});

test('forged status and malformed metadata fail closed, without reflecting arbitrary input', () => {
  for (const extra of [{ detection_status: 'safe' }, { detection_status: null },
    { observation_valid: 'true' }, { evidence_current: 'true' },
    { trend_confidence: 'high' }, { trend_sample_count: Infinity },
    { trend_duration_s: '2' }, { smoke_evidence: 'absent' },
    { trend_limitations: Array(1) }, { visibility_status: 'clear' }]) {
    const result = assess({ detection_status: 'idle', ...extra });
    assert.equal(result.response_priority, 'inspect_urgently');
    assert.equal(result.assessment_quality, 'invalid');
  }
  for (const value of [undefined, null, [], {}, 'safe']) {
    const result = rules.assessResponsePriority(value);
    assert.equal(result.detection_status, 'unknown');
    assert.equal(result.assessment_quality, 'invalid');
    assert.equal(result.response_priority, 'inspect_urgently');
  }
});

test('reviewed environment context is bounded, immutable and camera-specific; fabricated context is rejected', async () => {
  assert.equal(typeof rules.parseCameraContexts, 'function');
  assert.equal(typeof rules.contextForCamera, 'function');
  const context = { reviewed: true, reviewed_by: 'operator-7', reviewed_at_ms: 1000,
    occupied_area: false, known_hazards: ['flammable_gas'], critical_zones: [] };
  const env = JSON.stringify({ 'cam-a': context });
  const parsed = rules.parseCameraContexts(env);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed['cam-a'])), context);
  assert.ok(Object.isFrozen(parsed['cam-a']));
  assert.equal(rules.contextForCamera(env, 'missing'), null);
  const site_context = rules.contextForCamera(env, 'cam-a');
  const result = assess({ visual_activity: 'shrinking', site_context });
  assert.equal(result.response_priority, 'escalate');
  assert.equal(result.context_status, 'reviewed');
  assert.ok(result.priority_reasons.includes('reviewed_site_hazard_requires_escalation'));
  assert.ok(result.limitations.includes('site_context_does_not_establish_physical_contact'));
  for (const spoof of [context, { ...site_context }, JSON.parse(JSON.stringify(site_context)),
    { ...context, source: 'vlm' }, { reviewed: true }]) {
    const rejected = assess({ site_context: spoof });
    assert.equal(rejected.response_priority, 'inspect_urgently');
    assert.equal(rejected.context_status, 'rejected');
  }
  for (const invalid of ['{', '[]', env.repeat(1000),
    JSON.stringify({ 'cam-a': { ...context, reviewed_by: '' } }),
    JSON.stringify({ 'cam-a': { ...context, reviewed_at_ms: '1000' } }),
    JSON.stringify({ 'cam-a': { ...context, reviewed_at_ms: -1 } }),
    JSON.stringify({ 'cam-a': { ...context, occupied_area: 'false' } }),
    JSON.stringify({ 'cam-a': { ...context, known_hazards: ['model_says_hazard'] } }),
    JSON.stringify({ 'cam-a': { ...context, critical_zones: Array(40).fill('escape_route') } }),
    JSON.stringify({ 'cam-a': { ...context, source: 'vlm' } }),
    JSON.stringify({ '__proto__': context }),
  ]) assert.equal(rules.contextForCamera(invalid, 'cam-a'), null);
});

test('reviewed context is bound to its configured camera and cannot assert future review', () => {
  const site_context = rules.contextForCamera(JSON.stringify({ 'cam-a': { reviewed: true,
    reviewed_by: 'operator', reviewed_at_ms: 1000, occupied_area: true,
    known_hazards: [], critical_zones: [] } }), 'cam-a');
  assert.equal(assess({ camera_id: 'cam-a', ts_ms: 2000, site_context }).response_priority, 'escalate');
  for (const extra of [{ camera_id: 'cam-b', ts_ms: 2000 },
    { camera_id: 'cam-a', ts_ms: 999 }, { camera_id: undefined, ts_ms: 2000 }]) {
    const result = assess({ ...extra, site_context });
    assert.equal(result.context_status, 'rejected');
    assert.equal(result.response_priority, 'inspect_urgently');
  }
});

test('unknown hazards and reviewed empty context never become low hazard or clearance', () => {
  assert.equal(typeof rules.contextForCamera, 'function');
  const site_context = rules.contextForCamera(JSON.stringify({ 'cam-a': { reviewed: true,
    reviewed_by: 'operator', reviewed_at_ms: 1, occupied_area: false,
    known_hazards: [], critical_zones: [] } }), 'cam-a');
  for (const context of [undefined, site_context]) {
    const result = assess({ visual_activity: 'shrinking', site_context: context });
    assert.equal(result.response_priority, 'inspect_urgently');
    assert.equal(result.hazard_level, 'unknown');
    assert.ok(result.limitations.includes('hazard_absence_not_established'));
  }
});

test('a validated local lighter lease plus an explicit reviewed camera policy can monitor only behind the default-off gate', () => {
  const sessionId='123e4567-e89b-42d3-a456-426614174000';
  const policy=contextForCamera(JSON.stringify({ 'cam-a': {reviewed:true,reviewed_by:'operator',reviewed_at_ms:1_000,
    review_expires_at_ms:100_000,expected_handheld_flame_use:true,occupied_area:false,
    known_hazards:[],critical_zones:[]} }), 'cam-a');
  const candidate={version:1,camera_id:'cam-a',incident_id:'incident-42',session_id:sessionId,generation:3,
    candidate_id:'lighter-track-1',model_sha256:'a'.repeat(64),source_ts_ms:2_000,
    frame_ids:['frame-1500','frame-2000'],tool_type:'lighter',flame_relation:'at_tool_tip',
    image_quality:'adequate',fire_region_count:1,smoke_evidence:'not_detected',secondary_burning_evidence:'not_detected'};
  const lease=createHandheldLease(candidate,policy,2_100);
  const input=current({camera_id:'cam-a',incident_id:'incident-42',session_id:sessionId,ts_ms:2_000,now_ms:2_100,
    site_context:policy,handheld_lease:lease,handheld_feature_enabled:true});
  const result=rules.assessResponsePriority(input);
  assert.equal(result.response_priority,'monitor');
  assert.equal(result.operator_review_required,true);
  assert.equal(result.severity,'unknown');
  assert.ok(result.priority_reasons.includes('reviewed_handheld_policy_with_current_local_tool_track'));

  assert.equal(rules.assessResponsePriority({...input,handheld_feature_enabled:false}).response_priority,'inspect_urgently');
  for (const patch of [
    {handheld_lease:null}, {incident_id:'other'}, {session_id:'123e4567-e89b-42d3-a456-426614174001'},
    {smoke_evidence:'weak'}, {visibility_status:'unknown'}, {camera_motion:true}, {visual_activity:'growing'},
    {observation_valid:false}, {evidence_current:false},
  ]) assert.equal(rules.assessResponsePriority({...input,...patch}).response_priority,'inspect_urgently',JSON.stringify(patch));

  const hazardPolicy=contextForCamera(JSON.stringify({ 'cam-a': {reviewed:true,reviewed_by:'operator',reviewed_at_ms:1_000,
    review_expires_at_ms:100_000,expected_handheld_flame_use:true,occupied_area:true,
    known_hazards:[],critical_zones:[]} }), 'cam-a');
  const hazardous=rules.assessResponsePriority({...input,site_context:hazardPolicy});
  assert.equal(hazardous.response_priority,'escalate');
});

test('Scout-only lighter claims and client-copied reviewed policies cannot lower operator priority', () => {
  const forged={reviewed:true,reviewed_by:'operator',reviewed_at_ms:1_000,review_expires_at_ms:100_000,
    expected_handheld_flame_use:true,occupied_area:false,known_hazards:[],critical_zones:[]};
  const scene={contract_version:3,category:'contained_tool_flame',support:'insufficient_evidence',
    provenance:'untrusted_model_output',validation_errors:[],frame_ids:['frame-1','frame-2'],
    assertions:[],tool_assertions:[],evidence_interval:{start_ts_ms:1,end_ts_ms:2}};
  const result=assess({site_context:forged,scene_assessment:scene,handheld_feature_enabled:true});
  assert.equal(result.response_priority,'inspect_urgently');
  assert.equal(result.context_status,'rejected');
});

test('Scout V3 can lower only a validated observed interval under reviewed policy, never the initial live alert', () => {
  const policy=contextForCamera(JSON.stringify({'cam-a':{reviewed:true,reviewed_by:'operator',reviewed_at_ms:1_000,
    review_expires_at_ms:100_000,expected_handheld_flame_use:true,occupied_area:false,
    known_hazards:[],critical_zones:[]}}),'cam-a');
  const scene={contract_version:3,category:'contained_tool_flame',assertions:[],
    tool_assertions:[1_000,2_000,3_000].map(ts=>({frame_id:`frame-${ts}`,candidate_id:null,tool_type:'lighter',
      flame_relation:'at_tool_tip',secondary_burning:'not_observed',smoke:'not_observed',occlusion:'not_observed'})),
    frame_ids:['frame-1000','frame-2000','frame-3000'],provenance:'untrusted_model_output',
    support:'insufficient_evidence',validation_errors:[],evidence_interval:{start_ts_ms:1_000,end_ts_ms:3_000}};
  const input=current({ts_ms:4_000,now_ms:4_000,site_context:policy,scene_assessment:scene,
    scene_evidence_current:true,scene_chronological_match:true,scout_handheld_priority_enabled:true,
    scout_handheld_scene_qualified:true,scout_interval_reassessment:true,fire_region_count:1});

  const interval=rules.assessResponsePriority({...input,priority_scope:'observed_interval'});
  assert.equal(interval.response_priority,'monitor');
  assert.equal(interval.operator_review_required,true);
  assert.equal(interval.severity,'unknown');
  assert.ok(interval.priority_reasons.includes('scout_v3_handheld_scene_with_reviewed_camera_policy'));

  assert.equal(rules.assessResponsePriority({...input,priority_scope:'live'}).response_priority,'inspect_urgently');
  for (const patch of [
    {scout_handheld_priority_enabled:false}, {scout_handheld_scene_qualified:false},
    {scout_interval_reassessment:false}, {fire_region_count:2}, {fire_region_count:0},
    {smoke_evidence:'weak'}, {visibility_status:'degraded'}, {camera_motion:true},
    {visual_activity:'growing'}, {evidence_current:false}, {observation_valid:false},
    {scene_evidence_current:false}, {scene_chronological_match:false},
    {site_context:undefined},
  ]) assert.equal(rules.assessResponsePriority({...input,...patch,priority_scope:'observed_interval'}).response_priority,
    'inspect_urgently',JSON.stringify(patch));

  const event=rules.fireConfirmed({...input,priority_scope:'observed_interval'});
  assert.equal(event.response_priority,'inspect_urgently',
    'Scout interval evidence must not suppress the immediate live confirmation alert');
  assert.equal(Object.hasOwn(event,'scout_handheld_scene_qualified'),false);
});

test('development live-camera lighter test holds urgency pending Scout and monitors only a qualified live scene', () => {
  const policy=contextForCamera(JSON.stringify({'cam-a':{reviewed:true,reviewed_by:'development-fixture',
    reviewed_at_ms:1_000,review_expires_at_ms:100_000,expected_handheld_flame_use:true,
    occupied_area:false,known_hazards:[],critical_zones:[]}}),'cam-a');
  const pending=rules.assessResponsePriority(current({site_context:policy,
    visibility_status:'unknown',camera_motion:null,
    scout_handheld_live_test_enabled:true,scout_handheld_review_pending:true,fire_region_count:1}));
  assert.equal(pending.response_priority,'monitor');
  assert.ok(pending.priority_reasons.includes('scout_handheld_live_scene_review_pending'));

  const scene={contract_version:3,category:'contained_tool_flame',assertions:[],
    tool_assertions:[1_000,2_000,3_000].map(ts=>({frame_id:`frame-${ts}`,candidate_id:null,tool_type:'lighter',
      flame_relation:'at_tool_tip',secondary_burning:'not_observed',smoke:'not_observed',occlusion:'not_observed'})),
    frame_ids:['frame-1000','frame-2000','frame-3000'],provenance:'untrusted_model_output',
    support:'insufficient_evidence',validation_errors:[],limitations:[],evidence_interval:{start_ts_ms:1_000,end_ts_ms:3_000}};
  const live=rules.assessResponsePriority(current({ts_ms:4_000,now_ms:4_000,site_context:policy,
    visibility_status:'unknown',camera_motion:null,
    scene_assessment:scene,scene_evidence_current:true,scene_chronological_match:true,
    scout_handheld_priority_enabled:true,scout_handheld_live_test_enabled:true,
    scout_handheld_scene_qualified:true,fire_region_count:1}));
  assert.equal(live.response_priority,'monitor');
  assert.ok(live.priority_reasons.includes('scout_v3_live_handheld_scene_test'));

  for(const patch of [{scout_handheld_live_test_enabled:false}, {scout_handheld_scene_qualified:false},
    {fire_region_count:2}, {smoke_evidence:'weak'}, {evidence_current:false}, {site_context:undefined},
    {visibility_status:'degraded'}, {camera_motion:true}]) {
    assert.equal(rules.assessResponsePriority(current({ts_ms:4_000,now_ms:4_000,site_context:policy,
      scene_assessment:scene,scene_evidence_current:true,scene_chronological_match:true,
      scout_handheld_priority_enabled:true,scout_handheld_live_test_enabled:true,
      scout_handheld_scene_qualified:true,fire_region_count:1,...patch})).response_priority,
    'inspect_urgently',JSON.stringify(patch));
  }
});

const growing = extra => ({ visual_activity: 'growing', trend_confidence: 'medium',
  trend_sample_count: 3, trend_duration_s: 2, area_reliable: true,
  trend_limitations: ['visual_footprint_not_physical_growth_or_hazard',
    'footprint_change_not_extinction_or_safety'], ...extra });

test('only robust current growing activity escalates visual evidence, not guessed motion or duration', () => {
  const result = assess(growing());
  assert.equal(result.response_priority, 'escalate');
  assert.equal(result.assessment_quality, 'supported');
  assert.ok(result.priority_reasons.includes('robust_growing_visual_activity'));
  for (const extra of [{ detection_status: 'watch' }, { trend_confidence: 'low' },
    { trend_sample_count: 2 }, { trend_duration_s: 1.9 }, { trend_duration_s: undefined },
    { observation_valid: false }, { evidence_current: false }, { area_reliable: false },
    { area_reliable: undefined }, { camera_motion: null }, { camera_motion: undefined },
    { camera_motion: true }, { visibility_status: 'unknown' },
    { trend_limitations: ['visibility_unverified'] }, { trend_limitations: Array(1) },
    { trend_limitations: ['new_warning'] }]) {
    const result = assess(growing(extra));
    assert.equal(result.response_priority, 'inspect_urgently', JSON.stringify(extra));
    assert.ok(result.limitations.includes('visual_activity_not_reliably_supported'));
  }
});

test('VLM fields and forged priorities have no authority; output is bounded deterministic and input-preserving', () => {
  const sample = current(growing({ model_claims: { site_context: { reviewed: true }, hazard: 'explosive' },
    hazards: { electrical: 'present' }, response_priority: 'monitor', severity: 'low',
    cause: 'X'.repeat(100000), priority_reasons: Array(10000).fill('forged') }));
  const before = structuredClone(sample);
  const result = rules.assessResponsePriority(sample);
  assert.deepEqual(sample, before);
  assert.deepEqual(result, assess(growing()));
  assert.deepEqual(result, rules.assessResponsePriority(sample));
  assert.ok(JSON.stringify(result).length < 4096);
  assert.ok(result.priority_reasons.length <= 16);
  assert.ok(result.limitations.length <= 24);
  result.priority_reasons.push('mutated');
  assert.ok(!rules.assessResponsePriority(sample).priority_reasons.includes('mutated'));
});

test('confirmation and update builders overwrite forged severity and priority with the operational policy', () => {
  for (const build of [rules.fireConfirmed, rules.fireUpdate]) {
    const sample = current(growing({ detection_status: 'idle', response_priority: 'monitor',
      operator_priority: 'monitor', severity: 'low', hazard_level: 'low' }));
    const event = build(sample);
    assert.equal(event.response_priority, 'escalate');
    assert.equal(event.operator_priority, 'escalate');
    assert.equal(event.detection_status, 'confirmed');
    assert.equal(event.hazard_level, 'unknown');
    assert.equal(event.severity, 'unknown');
    assert.equal(event.severity_details.score, null);
    assert.equal(event.operator_review_required, true);
    assert.equal(event.type, build === rules.fireConfirmed ? 'fire_confirmed' : 'fire_update');
    assert.equal(build({}).response_priority, 'inspect_urgently');
    assert.deepEqual(rules.evaluateResponsePriority(current()), rules.assessResponsePriority(current()));
  }
});

test('confirmed incident always requires urgent human review, never a physical hazard score', () => {
  for (const extra of [{}, { visual_activity: 'shrinking' }, { observation_valid: false },
    { visibility_status: 'unknown', evidence_current: false }]) {
    const result = assess(extra);
    assert.equal(result.response_priority, 'inspect_urgently');
    assert.equal(result.operator_review_required, true);
    assert.equal(result.severity, 'unknown');
    assert.equal(result.hazard_level, 'unknown');
    assert.ok(result.priority_reasons.includes('confirmed_fire_requires_urgent_review'));
    assert.equal(result.policy_version, 'operational-response-v2-experimental');
    assert.ok(!('score' in result));
    assert.ok(!('risk_score' in result));
    for (const feature of ['fuel_unassessed', 'spatial_spread_unassessed', 'physical_scale_unassessed',
      'crop_scale_unassessed', 'suppression_safety_unassessed']) assert.ok(result.limitations.includes(feature));
  }
});
