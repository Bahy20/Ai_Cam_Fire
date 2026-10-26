// Test-only RPC double for suites that exercise analysis behavior rather than
// the durable ledger itself. Budget limits and production admission are covered
// by inference-runtime and Scout integration tests.
export const SCOUT_TEST_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

export function testInferenceBinding() {
  const running = new Set();
  return {
    idFromName: name => name,
    get: () => ({fetch: async request => {
      const action = new URL(request.url).pathname.split('/').at(-1);
      const body = request.method === 'POST' ? await request.json() : {};
      if (action === 'reserve') {
        if (running.has(body.key)) return Response.json({mode: 'skipped', reason: 'vlm_inference_still_running'});
        running.add(body.key);
        return Response.json({mode: 'fresh'});
      }
      if (action === 'complete') {
        running.delete(body.key);
        return Response.json({completed: true});
      }
      return Response.json({recorded: true});
    }}),
  };
}

export function testInferenceEnvironment(overrides = {}) {
  const cameraDo = Object.hasOwn(overrides, 'CAMERA_DO') ? overrides.CAMERA_DO : testInferenceBinding();
  const model = Object.hasOwn(overrides, 'VLM_MODEL') ?
    (overrides.VLM_MODEL === 'test-model' ? SCOUT_TEST_MODEL : overrides.VLM_MODEL) : SCOUT_TEST_MODEL;
  return {
    ...overrides,
    // These suites use mocked provider responses and must not escape local eval.
    APP_ENV: 'development',
    VLM_EVALUATION_MODE: 'true',
    CAMERA_DO: cameraDo,
    VLM_PROVIDER: overrides.VLM_PROVIDER ?? 'workers_ai',
    VLM_MODEL: model,
  };
}

export function withPersistenceEvidence(run) {
  const causes = (Array.isArray(run.causes) ? run.causes : []).map(event => ({
    ...event,
    evidence_manifest: event.evidence_manifest ?? [],
  }));
  const persisted_events = causes.map(event => {
    const priority = event.response_priority ?? event.operator_priority;
    const analysis = {cause: event.cause, evidence_manifest: event.evidence_manifest};
    if (event.priority_scope !== undefined) analysis.priority_scope = event.priority_scope;
    if (priority !== undefined) analysis.response_priority = priority;
    if (event.priority_assessment) analysis.priority_assessment = event.priority_assessment;
    return {
      camera_id: event.camera_id,
      ts_ms: event.ts_ms,
      incident_id: event.incident_id,
      event_key: event.analysis_job_id === undefined ? undefined :
        `${event.incident_id}:analysis:${event.analysis_job_id}`,
      event_kind: 'analysis',
      snapshot_key: null,
      cause: event.cause?.probable_cause,
      confidence: event.cause?.confidence,
      operator_priority: priority,
      analysis_json: JSON.stringify({...analysis,event_kind:'analysis',analysis_status:'complete',
        ...(event.analysis_job_id === undefined ? {} : {analysis_job_id:event.analysis_job_id})}),
    };
  });
  if (run.confirmation !== null && run.confirmation !== undefined) {
    const event = run.confirmation;
    const priority = event.response_priority ?? event.operator_priority;
    const priorityKeys = ['response_priority','operator_priority','context_status','detection_status',
      'priority_reasons','basis','assessment_quality','limitations','operator_review_required','policy_version',
      'severity','hazard_level','advisory_only'];
    const priority_assessment = Object.fromEntries(priorityKeys.filter(key => Object.hasOwn(event,key))
      .map(key => [key,event[key]]));
    const analysis = {event_kind:'confirmation',analysis_status:'pending'};
    if (event.priority_scope !== undefined) analysis.priority_scope = event.priority_scope;
    if (priority !== undefined) analysis.response_priority = priority;
    if (Object.keys(priority_assessment).length) analysis.priority_assessment = priority_assessment;
    persisted_events.push({camera_id:event.camera_id,ts_ms:event.ts_ms,incident_id:event.incident_id,
      event_key:`${event.incident_id}:confirmation`,event_kind:'confirmation',snapshot_key:null,
      cause:'unknown',confidence:'low',operator_priority:priority,analysis_json:JSON.stringify(analysis)});
  }
  return {...run, causes,
    persisted_events: Object.hasOwn(run, 'persisted_events') ? run.persisted_events : persisted_events};
}
