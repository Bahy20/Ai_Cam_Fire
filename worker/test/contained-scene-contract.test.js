import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/investigation.js';
import { assessResponsePriority, contextForCamera } from '../src/rules.js';
import { createAnalysisRecord } from '../src/incident-store.js';
const frames = [1000,2000].map(ts_ms => ({frame_id:`frame-${ts_ms}`,ts_ms,roles:['recent']}));
const raw = () => ({observations:[{kind:'flame_at_tool',frame_ids:['frame-1000','frame-2000'],description:'Flame remains at the visible tool tip.'}],hypothesis:{ignition_source:'unknown',ignition_tool:'unknown',fuel_type:'unknown',confidence:'low',action_frame_ids:[],ignition_frame_id:null},scene_assessment:{category:'contained_flame',confidence:'medium',frame_ids:['frame-1000','frame-2000'],limitations:[]}});
const qualify = value => api.qualifyModelInvestigation(value,frames);
const input = cause => ({camera_id:'cam',ts_ms:2000,detection_status:'confirmed',observation_valid:true,evidence_current:true,visibility_status:'unknown',visual_activity:'steady',trend_confidence:'low',trend_sample_count:2,trend_duration_s:1,trend_limitations:[],smoke_evidence:'not_detected',scene_assessment:cause.scene_assessment,scene_evidence_current:true,scene_chronological_match:true,site_context:contextForCamera(JSON.stringify({cam:{reviewed:true,reviewed_by:'human',reviewed_at_ms:0,occupied_area:false,known_hazards:[],critical_zones:[],expected_flame_use:true}}),'cam')});
test('shared exact schema binds frame refs and prompt includes that schema',()=>{
 assert.equal(typeof api.buildInvestigationSchema,'function');
 const schema=api.buildInvestigationSchema(frames);
 assert.deepEqual(schema.required,['contract_version','observations','hypothesis','scene_assertions']);
 assert.equal(schema.additionalProperties,false);
 assert.equal(schema.properties.contract_version.const,2);
 assert.deepEqual(schema.properties.observations.items.properties.frame_ids.items.enum,['frame-1000','frame-2000']);
 assert.deepEqual(api.buildInvestigationSchemaV1(frames).required,['observations','hypothesis','scene_assessment']);
 assert.ok(api.buildInvestigationPrompt(frames).includes(JSON.stringify(schema)));
});
test('contained scene requires structured local evidence in two distinct actual frames',()=>{
 const cause=qualify(raw()); assert.deepEqual(cause.validation_errors,[]);
 assert.equal(cause.scene_assessment.category,'contained_flame');
 assert.equal(cause.scene_assessment.support,'frame_linked_unverified');
 assert.deepEqual(cause.scene_assessment.evidence_interval,{start_ts_ms:1000,end_ts_ms:2000});
 assert.equal(cause.accepted_cause,'unknown'); assert.equal(cause.hazard_absence_verified,false);
 const lighter=raw();lighter.observations[0].kind='tool_visible';lighter.observations[0].description='lighter flame at tip';
 assert.equal(qualify(lighter).scene_assessment.support,'insufficient_evidence');
 const one=raw();one.scene_assessment.frame_ids=['frame-2000'];
 assert.equal(qualify(one).scene_assessment.support,'insufficient_evidence');
});
test('material burning and negated local evidence veto contained claims; legacy scene is uncertain',()=>{
 const bad=raw();bad.observations.push({kind:'material_burning',frame_ids:['frame-2000'],description:'Other material is burning.'});
 assert.equal(qualify(bad).scene_assessment.support,'insufficient_evidence');
 const negated=raw();negated.observations[0].description='Unclear whether flame is at the tool.';
 assert.equal(qualify(negated).scene_assessment.support,'insufficient_evidence');
 const old=raw();delete old.scene_assessment;
 assert.equal(qualify(old).scene_assessment.category,'uncertain');assert.deepEqual(qualify(old).validation_errors,[]);
});
test('application schema diagnostics identify each invalid field and preserve good observations',()=>{
 const bad=raw();bad.observations.push({kind:'bad',frame_ids:['frame-2000'],description:9});
 const cause=qualify(bad);assert.equal(cause.observations.length,1);
 assert.ok(cause.validation_errors.some(e=>e.includes('observations[1].kind')));
 assert.ok(cause.validation_errors.some(e=>e.includes('observations[1].description')));
 assert.equal(cause.scene_assessment.support,'insufficient_evidence');
});
test('unversioned prose scene evidence stays review-only until the structured decision contract is available',()=>{
 const cause=qualify(raw());
 const value=input(cause);const priority=assessResponsePriority(value);
 assert.equal(priority.response_priority,'inspect_urgently');assert.equal(priority.hazard_level,'unknown');
 assert.equal(cause.scene_assessment.support,'frame_linked_unverified','historical scene display remains available');
 for(const extra of [{scene_evidence_current:false},{scene_chronological_match:false},{visibility_status:'degraded'},{ts_ms:8001},{smoke_evidence:'weak'},{visual_activity:'growing'},{site_context:{...value.site_context}},{scene_assessment:{...value.scene_assessment,support:'insufficient_evidence'}}]) assert.equal(assessResponsePriority({...value,...extra}).response_priority,'inspect_urgently');
 const hazardous=contextForCamera(JSON.stringify({cam:{...value.site_context,known_hazards:['electrical']}}),'cam');
 assert.equal(assessResponsePriority({...value,site_context:hazardous}).response_priority,'escalate');
});

test('reviewed lighter use cannot lower urgency until geometry continuity and finite lease are both verified',()=>{
 const reviewedAt=0;const expiry=30*24*60*60*1000;
 const context=contextForCamera(JSON.stringify({cam:{reviewed:true,reviewed_by:'human',reviewed_at_ms:reviewedAt,
  review_expires_at_ms:expiry,context_revision:2,geometry_revision:3,reviewed_reference_image_sha256:'a'.repeat(64),
  reference_dimensions:[640,480],crop_rect:[0,0,1,1],source_zones:[{zone_id:'candle-1',source_type:'candle',bbox_normalized:[0.2,0.2,0.7,0.8]}],
  occupied_area:false,known_hazards:[],critical_zones:[],expected_flame_use:true}}),'cam');
 const scene={contract_version:2,category:'contained_flame',confidence:'medium',frame_ids:['frame-1000','frame-2000'],
  limitations:[],provenance:'untrusted_model_output',support:'frame_linked_unverified',validation_errors:[],
  evidence_interval:{start_ts_ms:1000,end_ts_ms:2000},assertions:[
   {frame_id:'frame-1000',source_id:'candle-1',source_type:'candle'},
   {frame_id:'frame-2000',source_id:'candle-1',source_type:'candle'}]};
 const base={camera_id:'cam',ts_ms:2000,detection_status:'confirmed',observation_valid:true,evidence_current:true,
  visibility_status:'adequate',visual_activity:'steady',trend_confidence:'low',trend_sample_count:2,trend_duration_s:1,
  trend_limitations:[],smoke_evidence:'not_detected',scene_assessment:scene,scene_evidence_current:true,
  scene_chronological_match:true,scene_source_zone_id:'candle-1',scene_context_revision:2,scene_geometry_revision:3,
  scene_reference_image_sha256:'a'.repeat(64),site_context:context,scene_continuity_qualified:true};
 assert.equal(assessResponsePriority({...base,scene_lease_current:false}).response_priority,'inspect_urgently');
 assert.equal(assessResponsePriority({...base,scene_continuity_qualified:false,scene_lease_current:true}).response_priority,'inspect_urgently');
 assert.equal(assessResponsePriority({...base,scene_context_revision:1,scene_lease_current:true}).response_priority,'inspect_urgently');
});
test('D1 codec preserves qualified scene, rejects promoted and mismatched interval',()=>{
 const cause=qualify(raw());const args={cameraId:'cam',incidentId:'cam:1000:1',ts:2000,jobId:1,cause,evidence_manifest:frames,priority:'monitor',reason:'initial_confirmation',incident_closed:false};
 const body=JSON.parse(createAnalysisRecord(args).analysis_json);assert.deepEqual(body.cause.scene_assessment,cause.scene_assessment);
 for(const mutate of [c=>c.scene_assessment.provenance='verified',c=>c.scene_assessment.evidence_interval.end_ts_ms=9999,c=>c.scene_assessment.category='safe']){const c=structuredClone(cause);mutate(c);assert.throws(()=>createAnalysisRecord({...args,cause:c}));}
});

test('site expected_flame_use is optional false in effect and only a reviewed boolean is accepted',()=>{
 const value=input(qualify(raw()));
 const config={...value.site_context};delete config.expected_flame_use;
 assert.equal(assessResponsePriority({...value,site_context:contextForCamera(JSON.stringify({cam:config}),'cam')}).response_priority,'inspect_urgently');
 for(const expected_flame_use of [false,'true',null,1]){
  const context=contextForCamera(JSON.stringify({cam:{...config,expected_flame_use}}),'cam');
  assert.equal(assessResponsePriority({...value,site_context:context}).response_priority,'inspect_urgently');
 }
});
test('old persisted D1 analysis remains valid when scene was absent',async()=>{
 const cause=qualify(raw());
 const row=createAnalysisRecord({cameraId:'cam',incidentId:'cam:1000:1',ts:2000,jobId:1,cause,evidence_manifest:frames,priority:'inspect_urgently',reason:'initial_confirmation',incident_closed:false});
 const old=JSON.parse(row.analysis_json);delete old.cause.scene_assessment;row.analysis_json=JSON.stringify(old);
 const {validateIncidentRecord}=await import('../src/incident-store.js');
 assert.doesNotThrow(()=>validateIncidentRecord(row));
});

test('optional inference usage is strictly bounded in durable analysis records',()=>{
 const cause=qualify(raw());const args={cameraId:'cam',incidentId:'cam:1000:1',ts:2000,jobId:1,cause,evidence_manifest:frames,priority:'monitor',reason:'initial_confirmation',incident_closed:false};
 cause.inference_metadata={mode:'fresh',usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}};
 assert.deepEqual(JSON.parse(createAnalysisRecord(args).analysis_json).cause.inference_metadata,cause.inference_metadata);
 for(const metadata of [{mode:'imagined',usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}},{mode:'cached',usage:{prompt_tokens:-1,completion_tokens:null,total_tokens:null}},{mode:'fresh',usage:{prompt_tokens:10,completion_tokens:4,total_tokens:1}},{mode:'fresh',usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14},raw:'secret'}]) assert.throws(()=>createAnalysisRecord({...args,cause:{...cause,inference_metadata:metadata}}));
});

test('nonchronological scene refs surface indexed-contract diagnostics and cannot monitor',()=>{
 const value=raw();value.scene_assessment.frame_ids.reverse();const cause=qualify(value);
 assert.ok(cause.validation_errors.some(e=>e.startsWith('scene_assessment.frame_ids:')));
 assert.equal(cause.scene_assessment.support,'insufficient_evidence');
 assert.equal(assessResponsePriority(input(cause)).response_priority,'inspect_urgently');
});

test('model-visible smoke vetoes containment even when detector smoke was missed',()=>{
 const value=raw();value.observations.push({kind:'smoke_visible',frame_ids:['frame-2000'],description:'Thick smoke is visible around the flame.'});
 const cause=qualify(value);
 assert.deepEqual(cause.validation_errors,[]);
 assert.equal(cause.scene_assessment.support,'insufficient_evidence');
 assert.ok(cause.scene_assessment.limitations.includes('contradictory_scene_evidence'));
 assert.equal(assessResponsePriority(input(cause)).response_priority,'inspect_urgently');
 assert.equal(qualify(raw()).scene_assessment.support,'frame_linked_unverified');
 assert.equal(assessResponsePriority(input(qualify(raw()))).response_priority,'inspect_urgently');
});
test('negated tool association cannot support containment with straight or curly contractions',()=>{
 for(const negative of ['cannot', "can't", 'can\u2019t', "isn't contained; burning extends beyond the candle.",
   'isn’t contained; burning extends beyond the candle.', 'was not contained; burning extends beyond the candle.',
   'uncertain whether the flame is contained or associated with the tool']) {
  const value=raw();value.observations[0].description=`Flame ${negative} be linked to tool tip.`;
  if(negative.includes('contained;')) value.observations[0].description=`The flame ${negative}`;
  if(negative.startsWith('uncertain')) value.observations[0].description=`It is ${negative}.`;
  const cause=qualify(value);
  assert.deepEqual(cause.validation_errors,[]);
  assert.equal(cause.scene_assessment.support,'insufficient_evidence',negative);
  assert.equal(cause.observations.length,1,'the valid observation remains inspectable');
  assert.equal(assessResponsePriority(input(cause)).response_priority,'inspect_urgently',negative);
 }
});

test('contradictory claims on one frame cannot support a contained-flame scene',()=>{
 const value=raw();
 value.observations[0].frame_ids=['frame-2000'];
 value.observations[0].description='A flame remains at the visible tool tip.';
 value.observations.push({kind:'material_burning',frame_ids:['frame-2000'],description:'The material beyond the tool is burning.'});
 value.scene_assessment.frame_ids=['frame-1000','frame-2000'];
 const cause=qualify(value);
 assert.equal(cause.observations.length,2);
 assert.equal(cause.scene_assessment.support,'insufficient_evidence');
 assert.equal(assessResponsePriority(input(cause)).response_priority,'inspect_urgently');
});
