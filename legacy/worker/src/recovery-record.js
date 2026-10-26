const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FIELDS = ['request_id','action','camera_id','generation','analysis_job_id','proposal_id','provider_outcome',
  'provider_reference','review_reference','rationale','actor_subject','actor_email','decided_at_ms'];
const text = (value,min,max) => typeof value === 'string' && value.length >= min && value.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(value) && value === value.trim();

// This codec validates stored metadata, not operator authority. Only a fresh,
// independently authenticated operator can create a recovery decision.
export function validateRecoveryRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      Object.keys(record).length !== FIELDS.length || FIELDS.some(key=>!Object.hasOwn(record,key)) ||
      !UUID.test(record.request_id) || !['propose','approve'].includes(record.action) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(record.camera_id) ||
      !Number.isSafeInteger(record.generation) || record.generation < 1 ||
      !Number.isSafeInteger(record.analysis_job_id) || record.analysis_job_id < 0 ||
      !['completed','cancelled'].includes(record.provider_outcome) ||
      !text(record.provider_reference,8,512) || !text(record.rationale,20,2000) ||
      !text(record.actor_subject,1,256) || !text(record.actor_email,3,254) ||
      !Number.isSafeInteger(record.decided_at_ms) || record.decided_at_ms < 0 || record.decided_at_ms > 8640000000000000 ||
      (record.action === 'propose' ? record.proposal_id !== null || record.review_reference !== null :
        !UUID.test(record.proposal_id) || record.proposal_id === record.request_id || !text(record.review_reference,8,512)) ||
      new TextEncoder().encode(JSON.stringify(record)).length > 8192) {
    throw new Error('invalid_native_recovery_record');
  }
  return record;
}
