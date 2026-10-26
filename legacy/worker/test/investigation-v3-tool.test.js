import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildInvestigationGenerationSchemaV3, buildInvestigationPromptV3,
  buildInvestigationSchemaV3, qualifyModelInvestigation, validateSceneAssessment,
  scoutHandheldAssessmentApplies} from '../src/investigation.js';

const frames = [1, 2].map((n, index) => ({frame_id: `frame-${n}`, ts_ms: n * 1000,
  roles: index ? ['recent'] : ['early'], image_b64: 'AQI='}));
const candidateContext = {handheld_candidates: [{candidate_id: 'tool-track-1', frame_ids: ['frame-1', 'frame-2']}]} ;
const tool = (frame_id, patch = {}) => ({frame_id, candidate_id: 'tool-track-1', tool_type: 'lighter',
  flame_relation: 'at_tool_tip', secondary_burning: 'not_observed', smoke: 'not_observed',
  occlusion: 'not_observed', ...patch});
const v3 = (patch = {}) => ({contract_version: 3,
  observations: [{frame_ids: ['frame-1', 'frame-2'], kind: 'flame_visible', description: 'A small flame is visible.'}],
  hypothesis: {ignition_source: 'unknown', ignition_tool: 'unknown', fuel_type: 'unknown', confidence: 'low',
    action_frame_ids: [], ignition_frame_id: null}, scene_assertions: [],
  tool_assertions: [tool('frame-1'), tool('frame-2')], ...patch});

test('V3 has an exact tool assertion contract even without a fixed reviewed source', () => {
  const schema = buildInvestigationSchemaV3(frames, candidateContext);
  assert.deepEqual(schema.required, ['contract_version', 'observations', 'hypothesis', 'scene_assertions', 'tool_assertions']);
  assert.equal(schema.properties.contract_version.const, 3);
  assert.deepEqual(schema.properties.tool_assertions.items.required,
    ['frame_id', 'candidate_id', 'tool_type', 'flame_relation', 'secondary_burning', 'smoke', 'occlusion']);
  assert.ok(JSON.stringify(schema).includes('tool-track-1'));
  assert.ok(!JSON.stringify(buildInvestigationGenerationSchemaV3(frames, candidateContext)).includes('uniqueItems'));
  const prompt=buildInvestigationPromptV3(frames,candidateContext);
  assert.ok(prompt.includes('tool_assertions'));
  assert.match(prompt,/Inspect every attached image individually/i);
  assert.match(prompt,/A dark earlier frame does not negate a later visible flame/i);
  assert.match(prompt,/one tool assertion for every attached frame where both the lighter and its flame are visible/i);
  assert.match(prompt,/For one flame at a lighter tip, use flame_at_tool only/i);
  assert.match(prompt,/Every at_tool_tip assertion needs a flame_at_tool observation for the same frame/i);
  assert.match(prompt,/If three frames show the same lighter-tip flame, return three tool_assertions/i);
  assert.match(prompt,/first identify up to four visible physical features internally/i);
  assert.match(prompt,/Do not let bright sparks dominate object identification/i);
  assert.match(prompt,/The output schema has no feature-list field/i);
  assert.match(prompt,/For EVERY attached frame where both the handheld device and flame are visible/i);
  assert.match(prompt,/return exactly one tool_assertions row for that frame/i);
  assert.match(prompt,/Do not collapse repeated visible evidence into a single recent-frame assertion/i);
});

test('V3 derives descriptive contained-tool flame from two chronological observations without a fixed zone', () => {
  const result = qualifyModelInvestigation(v3(), {frames, sceneContext: candidateContext});
  assert.deepEqual(result.validation_errors, []);
  assert.equal(result.observations.length, 1);
  assert.equal(result.scene_assessment.category, 'contained_tool_flame');
  assert.equal(result.scene_assessment.support, 'insufficient_evidence');
  assert.equal(result.scene_assessment.provenance, 'untrusted_model_output');
  assert.equal(result.accepted_cause, 'unknown');
  assert.equal(result.hazard_absence_verified, false);
  assert.deepEqual(validateSceneAssessment(result.scene_assessment, frames, result.observations), result.scene_assessment);
});

test('V3 reports indexed frame and candidate errors while preserving observations', () => {
  const value = v3({tool_assertions: [tool('foreign-frame'), tool('frame-2', {candidate_id: 'not-issued'})]});
  const result = qualifyModelInvestigation(value, {frames, sceneContext: candidateContext});
  assert.equal(result.observations.length, 1);
  assert.ok(result.validation_errors.some(error => error.startsWith('tool_assertions[0].frame_id:')));
  assert.ok(result.validation_errors.some(error => error.startsWith('tool_assertions[1].candidate_id:')));
  assert.equal(result.scene_assessment.category, 'uncertain');
});

test('V3 rejects duplicate rows and does not hide secondary burning or uncertainty', () => {
  const duplicate = v3({tool_assertions: [tool('frame-1'), tool('frame-1')]});
  const duplicateResult = qualifyModelInvestigation(duplicate, {frames, sceneContext: candidateContext});
  assert.ok(duplicateResult.validation_errors.some(error => error.includes('duplicate frame/candidate assertion')));
  assert.equal(duplicateResult.scene_assessment.category, 'uncertain');

  const burning = v3({tool_assertions: [tool('frame-1'), tool('frame-2', {secondary_burning: 'present'})]});
  assert.equal(qualifyModelInvestigation(burning, {frames, sceneContext: candidateContext}).scene_assessment.category,
    'material_burning');
  const unclear = v3({tool_assertions: [tool('frame-1'), tool('frame-2', {occlusion: 'uncertain'})]});
  assert.equal(qualifyModelInvestigation(unclear, {frames, sceneContext: candidateContext}).scene_assessment.category,
    'uncertain');
});

test('V3 leaves tool identity null when no authenticated local candidate is supplied', () => {
  const withoutCandidate = v3({tool_assertions: [tool('frame-1', {candidate_id: null}),
    tool('frame-2', {candidate_id: null})]});
  const result = qualifyModelInvestigation(withoutCandidate, {frames});
  assert.deepEqual(result.validation_errors, []);
  assert.equal(result.scene_assessment.category, 'contained_tool_flame');
  assert.equal(result.scene_assessment.support, 'insufficient_evidence');
});

test('captured Scout V3 lighter-frame miss remains uncertain and cannot imply hazard absence', () => {
  const raw=JSON.parse(readFileSync(new URL('../../test_fixtures/scout-v3-lighter-flame-miss.json',import.meta.url)));
  const probeFrames=Array.from({length:6},(_,index)=>({
    frame_id:`frame-${2_797_191_424_812+index*2_200}`,
    ts_ms:2_797_191_424_812+index*2_200,
    roles:index===0?['early']:index===5?['recent']:[],image_b64:'AQI='}));
  const result=qualifyModelInvestigation(raw,{frames:probeFrames});
  assert.deepEqual(result.validation_errors,[],'the provider output was schema-valid');
  assert.equal(result.observations[0].kind,'unknown');
  assert.equal(result.observations[0].description,'no visible flame or smoke');
  assert.equal(result.scene_assessment.category,'uncertain');
  assert.equal(result.hazard_absence_verified,false);
  assert.equal(result.accepted_cause,'unknown');
});

test('captured Scout V3 frame-by-frame response describes the lighter but leaves cause and support unresolved', () => {
  const raw=JSON.parse(readFileSync(new URL('../../test_fixtures/scout-v3-lighter-frame-by-frame-response.json',import.meta.url)));
  const frameIds=[...new Set([...raw.observations.flatMap(row=>row.frame_ids),
    ...raw.tool_assertions.map(row=>row.frame_id)])];
  const probeFrames=frameIds.map(frame_id=>({frame_id,ts_ms:Number(frame_id.slice(6)),roles:[],image_b64:'AQI='}))
    .sort((left,right)=>left.ts_ms-right.ts_ms);
  const result=qualifyModelInvestigation(raw,{frames:probeFrames});
  assert.deepEqual(result.validation_errors,[],'the captured provider response satisfies the V3 contract');
  assert.equal(result.observations.filter(row=>row.kind==='flame_at_tool').length,4);
  assert.equal(result.scene_assessment.category,'contained_tool_flame');
  assert.equal(result.scene_assessment.tool_assertions.length,4);
  assert.equal(result.scene_assessment.support,'insufficient_evidence');
  assert.equal(result.hypothesis.ignition_source,'unknown');
  assert.equal(result.accepted_cause,'unknown');
  assert.equal(result.hazard_absence_verified,false);
});

test('captured Scout V3 lighter evidence may reassess only its fresh observed interval', () => {
  const raw=JSON.parse(readFileSync(new URL('../../test_fixtures/scout-v3-lighter-frame-by-frame-response.json',import.meta.url)));
  const frameIds=[...new Set([...raw.observations.flatMap(row=>row.frame_ids),
    ...raw.tool_assertions.map(row=>row.frame_id)])];
  const probeFrames=frameIds.map(frame_id=>({frame_id,ts_ms:Number(frame_id.slice(6)),roles:[],image_b64:'AQI='}))
    .sort((left,right)=>left.ts_ms-right.ts_ms);
  const result=qualifyModelInvestigation(raw,{frames:probeFrames});
  const options={frames:probeFrames,observations:result.observations,
    ts_ms:result.scene_assessment.evidence_interval.end_ts_ms+1_000,
    evidence_current:true,chronological_match:true,model_result_valid:true};

  assert.equal(result.scene_assessment.support,'insufficient_evidence');
  assert.equal(result.hazard_absence_verified,false);
  assert.equal(scoutHandheldAssessmentApplies(result.scene_assessment,options),true,
    'the bounded decision is a queue-priority reassessment, not a safety or cause finding');
  for (const patch of [
    {model_result_valid:false}, {evidence_current:false}, {chronological_match:false},
    {ts_ms:result.scene_assessment.evidence_interval.end_ts_ms+5_001},
    {observations:[...result.observations,{frame_ids:[result.scene_assessment.frame_ids[0]],
      kind:'material_burning',description:'Material is burning.'}]},
    {observations:result.observations.map(row=>row.kind==='flame_at_tool'?{...row,kind:'unknown'}:row)},
  ]) assert.equal(scoutHandheldAssessmentApplies(result.scene_assessment,{...options,...patch}),false,
    JSON.stringify(patch));

  const oneMissingRow=structuredClone(result.scene_assessment);
  oneMissingRow.tool_assertions.pop();
  oneMissingRow.frame_ids.pop();
  assert.equal(scoutHandheldAssessmentApplies(oneMissingRow,options),false);
});
