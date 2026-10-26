import {OperatorError, requireOperatorPrincipal} from './operator-auth.js';
import {validateRecoveryRecord} from './recovery-record.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const common=['request_id','action','expected_generation','expected_job_id','rationale'];
const proposalFields=[...common,'provider_outcome','provider_reference'];
const decisionFields=[...common,'proposal_id','review_reference'];
const fail=(status,code)=>{throw new OperatorError(status,code);};
function scope(camera,principal) {
  const actor=requireOperatorPrincipal(principal,'inference:recover',camera.cameraId);
  if (!camera.journal || !camera.lifetimeCurrent()) fail(503,'coordinator_state_unavailable');
  return actor;
}
export function nativeRecoveryStatus(camera,principal) {
  scope(camera,principal);
  return {required:camera.nativeInferenceInterrupted,live_native_operation:camera.nativeInference!==null,
    generation:camera.journal.generation,analysis_job_id:camera.analysisJob,
    backend_status_verified_by_application:false,policy:'two_distinct_operators_external_provider_evidence',
    proposal_max_age_ms:900000,audit_count:camera.journal.recoveryAuditCount()};
}
export function applyNativeRecovery(camera,principal,body,{nowMs=Date.now()}={}) {
  const actor=scope(camera,principal);
  const fields=body?.action==='propose'?proposalFields:decisionFields;
  if (!body || typeof body!=='object' || Array.isArray(body) || !['propose','approve'].includes(body.action) ||
      Object.keys(body).length!==fields.length || fields.some(key=>!Object.hasOwn(body,key)) ||
      typeof body.request_id!=='string' || !UUID.test(body.request_id) ||
      !Number.isSafeInteger(body.expected_generation) || body.expected_generation<1 ||
      !Number.isSafeInteger(body.expected_job_id) || body.expected_job_id<0 ||
      (body.action==='approve' && (typeof body.proposal_id!=='string' || !UUID.test(body.proposal_id))))
    fail(400,'native_recovery_invalid_request');
  const prior=camera.journal.findRecoveryAudit(body.request_id);
  if (prior) {
    const claims={camera_id:camera.cameraId,action:body.action,generation:body.expected_generation,
      analysis_job_id:body.expected_job_id,rationale:body.rationale,actor_subject:actor.subject,actor_email:actor.email,
      ...(body.action==='propose'?{provider_outcome:body.provider_outcome,provider_reference:body.provider_reference}:
        {proposal_id:body.proposal_id,review_reference:body.review_reference})};
    if (Object.entries(claims).some(([key,value])=>prior[key]!==value)) fail(409,'native_recovery_request_conflict');
    return {audit:{...prior,provenance:'operator_attestation',factual_correctness_verified:false},
      idempotent:true,recovery:nativeRecoveryStatus(camera,principal)};
  }
  const proposal=body.action==='approve'?camera.journal.findRecoveryAudit(body.proposal_id):null;
  if (body.action==='approve' && (!proposal || proposal.action!=='propose' || proposal.camera_id!==camera.cameraId))
    fail(409,'native_recovery_proposal_not_found');
  if (proposal && (proposal.actor_subject===actor.subject || proposal.actor_email.toLowerCase()===actor.email.toLowerCase()))
    fail(403,'native_recovery_independent_reviewer_required');
  if (proposal && (proposal.generation!==body.expected_generation || proposal.analysis_job_id!==body.expected_job_id ||
      nowMs<proposal.decided_at_ms || nowMs-proposal.decided_at_ms>=900000)) fail(409,'native_recovery_proposal_stale');
  const record={request_id:body.request_id,action:body.action,camera_id:camera.cameraId,
    generation:body.expected_generation,analysis_job_id:body.expected_job_id,proposal_id:proposal?.request_id??null,
    provider_outcome:proposal?.provider_outcome??body.provider_outcome,
    provider_reference:proposal?.provider_reference??body.provider_reference,review_reference:proposal?body.review_reference:null,
    rationale:body.rationale,actor_subject:actor.subject,actor_email:actor.email,decided_at_ms:nowMs};
  try {validateRecoveryRecord(record);} catch {fail(400,'native_recovery_invalid_request');}
  if (body.expected_generation!==camera.journal.generation || body.expected_job_id!==camera.analysisJob)
    fail(409,'native_recovery_stale_state');
  if (!camera.nativeInferenceInterrupted) fail(409,'native_recovery_not_required');
  if (camera.nativeInference || camera.analysisActive || camera.pendingAnalysis) fail(409,'native_recovery_work_in_progress');
  if (camera.journal.recoveryAuditCount()>=1024) fail(503,'native_recovery_audit_full');
  const interrupted=camera.nativeInferenceInterrupted;
  if (body.action==='approve') camera.nativeInferenceInterrupted=false;
  try {camera.saveCoordinator([],record);}
  catch(error) {camera.nativeInferenceInterrupted=interrupted;throw error;}
  const stored=camera.journal.findRecoveryAudit(record.request_id);
  if (!stored) fail(503,'native_recovery_readback_failed');
  return {audit:{...stored,provenance:'operator_attestation',factual_correctness_verified:false},
    idempotent:false,recovery:nativeRecoveryStatus(camera,principal)};
}
