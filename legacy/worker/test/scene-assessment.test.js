import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifyModelInvestigation, unknownSceneAssessment, validateSceneAssessment, sceneAssessmentApplies } from '../src/investigation.js';
const frames=[{frame_id:'frame-1',ts_ms:1,roles:['early']},{frame_id:'frame-2',ts_ms:2,roles:['recent']}];
const hypothesis={ignition_source:'unknown',ignition_tool:'unknown',fuel_type:'unknown',confidence:'low',action_frame_ids:[],ignition_frame_id:null};
test('unknown scene is detached, untrusted and cannot qualify for monitoring',()=>{
 const unknown=unknownSceneAssessment();const cloned=validateSceneAssessment(unknown,frames);
 cloned.limitations.push('detached');assert.deepEqual(unknown.limitations,['scene_not_supplied']);
 assert.equal(unknown.category,'uncertain');assert.equal(unknown.provenance,'untrusted_model_output');
 assert.equal(sceneAssessmentApplies(unknown,{ts_ms:2,evidence_current:true,chronological_match:true}),false);
});
test('positive tool association needs two chronological actual frames and remains unverified',()=>{
 const observations=[{kind:'flame_at_tool',frame_ids:['frame-1','frame-2'],description:'Visible flame stays at tool tip.'}];
 const cause=qualifyModelInvestigation({observations,hypothesis,scene_assessment:{category:'contained_flame',confidence:'high',frame_ids:['frame-1','frame-2'],limitations:[]}},frames);
 assert.deepEqual(cause.validation_errors,[]);assert.equal(cause.scene_assessment.support,'frame_linked_unverified');
 assert.equal(sceneAssessmentApplies(cause.scene_assessment,{ts_ms:2,evidence_current:true,chronological_match:true}),false,
  'the current prose-linked scene contract cannot authorize a live priority downgrade');
 assert.deepEqual(validateSceneAssessment(cause.scene_assessment,frames,observations),cause.scene_assessment);
 assert.equal(cause.accepted_cause,'unknown');
});
