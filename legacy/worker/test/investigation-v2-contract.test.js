import test from 'node:test';
import assert from 'node:assert/strict';
import {buildInvestigationSchema, buildInvestigationGenerationSchema, buildInvestigationPrompt,
  qualifyModelInvestigation, sceneAssessmentApplies, validateSceneAssessment} from '../src/investigation.js';

const frames = [1, 2].map((n, index) => ({frame_id: `frame-${n}`, ts_ms: n * 1000,
  roles: index ? ['recent'] : ['early'], image_b64: 'AQI='}));
const sourceContext = [{source_id: 'zone-candle-a', source_type: 'candle', reviewed: true,
  frames: frames.map((frame, index) => ({frame_id: frame.frame_id, detection_ids: [`fire-${index + 1}`]}))}];
const assertion = (index, extra = {}) => ({frame_id: frames[index].frame_id, source_id: 'zone-candle-a',
  detection_ids: [`fire-${index + 1}`], source_type: 'candle', containment: 'contained', smoke: 'not_observed',
  secondary_burning: 'not_observed', spread_outside_source: 'not_observed', occlusion: 'not_observed', ...extra});
const v2 = (patch = {}) => ({contract_version: 2,
  observations: [{frame_ids: ['frame-1', 'frame-2'], kind: 'flame_at_tool', description: 'Flame is visible at the candle wick.'}],
  hypothesis: {ignition_source: 'unknown', ignition_tool: 'unknown', fuel_type: 'unknown', confidence: 'low',
    action_frame_ids: [], ignition_frame_id: null},
  scene_assertions: [assertion(0), assertion(1)], ...patch});

test('V2 has one strict structured contract and contains no model-authored scene category or limitations', () => {
  const schema = buildInvestigationSchema(frames, {sources: sourceContext});
  assert.deepEqual(schema.required, ['contract_version', 'observations', 'hypothesis', 'scene_assertions']);
  assert.equal(schema.properties.contract_version.const, 2);
  assert.equal(schema.properties.scene_assessment, undefined);
  assert.deepEqual(schema.properties.scene_assertions.items.required,
    ['frame_id', 'source_id', 'detection_ids', 'source_type', 'containment', 'smoke',
      'secondary_burning', 'spread_outside_source', 'occlusion']);
  assert.ok(JSON.stringify(schema).includes('zone-candle-a'));
  assert.ok(!JSON.stringify(buildInvestigationGenerationSchema(frames, {sources: sourceContext})).includes('uniqueItems'));
  assert.ok(buildInvestigationPrompt(frames, {sources: sourceContext}).includes('scene_assertions'));
});

test('V2 preserves observations and derives only frame-linked contained evidence', () => {
  const result = qualifyModelInvestigation(v2(), {frames, sceneContext: sourceContext});
  assert.deepEqual(result.validation_errors, []);
  assert.equal(result.observations.length, 1);
  assert.equal(result.scene_assessment.contract_version, 2);
  assert.equal(result.scene_assessment.category, 'contained_flame');
  assert.equal(result.scene_assessment.assertions.length, 2);
  assert.equal(result.scene_assessment.support, 'insufficient_evidence');
  assert.equal(sceneAssessmentApplies(result.scene_assessment, {ts_ms: 2000,
    evidence_current: true, chronological_match: true}), true,
    'this semantic check still needs reviewed geometry, continuity, and a live lease in the priority policy');
  assert.equal(result.accepted_cause, 'unknown');
  assert.equal(result.hazard_absence_verified, false);
  assert.deepEqual(validateSceneAssessment(result.scene_assessment, frames, result.observations), result.scene_assessment);
});

test('V2 persistence codec recomputes the category and rejects tampered refs or decision labels', () => {
  const result = qualifyModelInvestigation(v2(), {frames, sceneContext: sourceContext});
  const wrongCategory = structuredClone(result.scene_assessment);
  wrongCategory.category = 'material_burning';
  assert.throws(() => validateSceneAssessment(wrongCategory, frames, result.observations), /invalid V2 scene evidence/);
  const wrongFrameOrder = structuredClone(result.scene_assessment);
  wrongFrameOrder.frame_ids.reverse();
  assert.throws(() => validateSceneAssessment(wrongFrameOrder, frames, result.observations), /invalid V2 scene evidence/);
  const malformed = structuredClone(result.scene_assessment);
  malformed.assertions[0].caption = 'safe';
  assert.throws(() => validateSceneAssessment(malformed, frames, result.observations), /invalid V2 scene assertion/);
});

test('V2 rejects unknown source or detector references with indexed diagnostics and preserves valid siblings', () => {
  const value = v2();
  value.scene_assertions[1].detection_ids = ['detector-output-from-another-frame'];
  const result = qualifyModelInvestigation(value, {frames, sceneContext: sourceContext});
  assert.equal(result.observations.length, 1);
  assert.ok(result.validation_errors.some(error => error.startsWith('scene_assertions[1].detection_ids')));
  assert.equal(result.scene_assessment.assertions.length, 1);
  assert.equal(result.scene_assessment.support, 'insufficient_evidence');
});

test('V2 rejects missing fields, source type mismatches, and duplicate frame/source assertions', () => {
  const missing = v2();
  delete missing.scene_assertions[0].occlusion;
  const missingResult = qualifyModelInvestigation(missing, {frames, sceneContext: sourceContext});
  assert.ok(missingResult.validation_errors.includes('scene_assertions[0].occlusion: required'));
  assert.equal(missingResult.scene_assessment.assertions.length, 1);
  const mismatch = v2();
  mismatch.scene_assertions[0].source_type = 'stationary_burner';
  const mismatchResult = qualifyModelInvestigation(mismatch, {frames, sceneContext: sourceContext});
  assert.ok(mismatchResult.validation_errors.some(error => error.startsWith('scene_assertions[0].source_type')));
  const duplicate = v2();
  duplicate.scene_assertions[1].frame_id = 'frame-1';
  duplicate.scene_assertions[1].detection_ids = ['fire-1'];
  const duplicateResult = qualifyModelInvestigation(duplicate, {frames, sceneContext: sourceContext});
  assert.ok(duplicateResult.validation_errors.some(error => error.includes('duplicate frame/source assertion')));
  assert.equal(duplicateResult.scene_assessment.assertions.length, 0);
});

test('V2 secondary burning overrides containment and smoke contradicting a flame stays uncertain', () => {
  const burning = v2();
  burning.scene_assertions[1].secondary_burning = 'present';
  const burningResult = qualifyModelInvestigation(burning, {frames, sceneContext: sourceContext});
  assert.equal(burningResult.scene_assessment.category, 'material_burning');
  assert.equal(burningResult.scene_assessment.support, 'insufficient_evidence');
  const smoke = v2();
  smoke.scene_assertions[1].smoke = 'present';
  const smokeResult = qualifyModelInvestigation(smoke, {frames, sceneContext: sourceContext});
  assert.equal(smokeResult.scene_assessment.category, 'uncertain');
  assert.equal(smokeResult.scene_assessment.support, 'insufficient_evidence');
});

