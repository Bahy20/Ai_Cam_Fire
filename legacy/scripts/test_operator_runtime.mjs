// Actual workerd OFFLINE contract harness. Synthetic detections and AI boundary only.
// Run only one copy: node --max-old-space-size=128 scripts/test_operator_runtime.mjs
// No credentials, remote requests, downloads, real models or production test hooks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash, randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {makeOperatorFixture} from '../worker/test/helpers/operator-jwt.js';
import {validateJpeg} from '../worker/src/camera-do.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const worker=path.join(root,'worker');
const require=createRequire(path.join(worker,'package.json'));
const scratch='C:/Users/moihammed/AppData/Local/hermes/cache/scratch';
const native=value=>value.replaceAll('\\','/');
const migrations=['0001_init.sql','0002_analysis.sql','0003_event_keys.sql','0004_operator_reviews.sql'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

// Deliberately schema-specific: preserve complete multiline CREATE TRIGGER bodies,
// including internal CASE/END and semicolons. Never split SQL on semicolons.
function migrationStatements(sql) {
  const statements=[];let buffer=[],trigger=false;
  for(const original of sql.split(/\r?\n/)) {
    const line=original.replace(/--.*$/,'').trim();
    if(!line)continue;
    if(!buffer.length)trigger=/^CREATE\s+TRIGGER\b/i.test(line);
    buffer.push(line);
    if(trigger ? /^END;$/.test(line) : line.endsWith(';')) {
      statements.push(buffer.join('\n'));buffer=[];trigger=false;
    }
  }
  assert.equal(buffer.length,0,'unrecognized incomplete migration statement');
  return statements;
}

export async function runOperatorRuntime() {
  assert.ok(process.execArgv.includes('--max-old-space-size=128'),'use the documented capped Node invocation');
  assert.equal(process.platform,'win32','scratch path is intentionally Windows-specific');
  const out=native(fs.mkdtempSync(`${scratch}/operator-runtime-`));
  const resultPath=`${out}/result.json`;
  const result={passed:false,test_layer:'offline_actual_workerd_contract_synthetic_native',
    native_model_verified:false,provider_cancellation_verified:false,actual_pi_verified:false,
    detector_accuracy_verified:false,remote_requests_used:false,
    synthetic_native_response:{response:{}},synthetic_native_response_is_test_double:true,
    camera_id:'cam',out,result_path:resultPath,persistence:`${out}/state`,
    started_at:new Date().toISOString(),assertions:[],checkpoints:[],lifetimes:[],cleanup:[],
    outbound:{jwks_requests:0,rejected_requests:0},migrations:[],artifacts:[]};
  const started=Date.now(),deadline=started+175000;
  let mf=null,db=null,origin=null,lifetime=null,doStorage=null;
  const save=(name,value)=>{fs.writeFileSync(`${out}/${name}`,JSON.stringify(value,null,2)+'\n');
    if(!result.artifacts.includes(name))result.artifacts.push(name);};
  const trace=data=>fs.appendFileSync(`${out}/http.jsonl`,JSON.stringify(data)+'\n');
  const check=()=>assert.ok(Date.now()<deadline,'overall 175s execution deadline exceeded');
  async function bounded(promise,ms,label,cleanup=false) {
    if(!cleanup)check();let timer;
    try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label}: deadline exceeded`)),cleanup?ms:Math.min(ms,deadline-Date.now()));})]);}
    finally{clearTimeout(timer);}
  }
  function pass(name,details={}) {result.assertions.push({name,passed:true,...details});console.log('PASS',name);}
  const sourceNames=fs.readdirSync(path.join(worker,'src')).filter(name=>name.endsWith('.js')).sort().map(name=>`src/${name}`);
  const sourceHashes=()=>Object.fromEntries(sourceNames.map(name=>[name,hash(fs.readFileSync(path.join(worker,name)))]));
  async function tcpClosed(url) {
    const target=new URL(url);
    return new Promise(resolve=>{
      const socket=net.connect({host:target.hostname,port:Number(target.port)});
      socket.setTimeout(1500);
      socket.once('connect',()=>{socket.destroy();resolve({closed:false,error:null});});
      socket.once('error',error=>{socket.destroy();resolve({closed:error.code==='ECONNREFUSED',error:error.code});});
      socket.once('timeout',()=>{socket.destroy();resolve({closed:false,error:'timeout'});});
    });
  }
  async function stop() {
    if(!mf)return;
    const owned=mf,record=lifetime,url=origin;
    // Only this instance's runtime is disposed; no process-name/port-wide kills.
    await bounded(owned.dispose(),12000,'owned Miniflare dispose',true);
    mf=null;db=null;doStorage=null;
    const evidence=url ? await tcpClosed(url) : {closed:false,error:'listener URL not acquired'};
    result.cleanup.push({lifetime:record.label,url,dispose_completed:true,tcp_refused:evidence.closed,tcp_error:evidence.error});
    record.stopped_at=new Date().toISOString();
    assert.equal(evidence.closed,true,`owned listener still accepts TCP: ${url}`);
  }
  async function http(route,body,headers={},expected=200) {
    check();const before=Date.now();
    const response=await fetch(`${origin}${route}`,{method:body===undefined?'GET':'POST',
      headers:{'x-api-key':ingestKey,'content-type':'application/json',...headers},redirect:'manual',
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(Math.min(7000,deadline-Date.now()))});
    const text=await bounded(response.text(),7000,`response body ${route}`);
    let data;try{data=JSON.parse(text);}catch{throw new Error(`${route}: non-JSON status ${response.status}`);}
    // No raw headers, JWTs, API keys or JPEG base64 in artifacts.
    trace({lifetime:lifetime.label,route,method:body===undefined?'GET':'POST',status:response.status,
      before_ms:before,after_ms:Date.now(),response:data});
    assert.equal(response.status,expected,`${route}: ${JSON.stringify(data)}`);
    if(route.startsWith('/operator/'))assert.equal(response.headers.get('cache-control'),'no-store');
    return data;
  }
  async function poll(label,read,predicate,timeout=15000) {
    const until=Math.min(deadline,Date.now()+timeout);let value;
    do{value=await read();if(predicate(value))return value;
      assert.ok(Date.now()<until,`${label} timed out: ${JSON.stringify(value).slice(0,1200)}`);await sleep(150);
    }while(true);
  }
  async function checkpoint(label) {
    const value=await http('/state/camera/cam');save(`${label}.json`,value);
    result.checkpoints.push({label,at_ms:Date.now(),alert:value.alert,incident_id:value.incident_id,
      durability_status:value.durability_status,analysis_status:value.analysis_status});return value;
  }
  async function d1(sql,args=[]) {
    return bounded(db.prepare(sql).bind(...args).all(),7000,'D1 read/write');
  }
  async function exactEvents(incident) {
    const {results}=await d1('SELECT * FROM events WHERE camera_id = ? AND incident_id = ? ORDER BY id',['cam',incident]);
    const publicRows=(await http('/events')).filter(row=>row.camera_id==='cam'&&row.incident_id===incident);
    assert.deepEqual(publicRows.sort((a,b)=>a.id-b.id),results);
    return results;
  }
  async function storageRead(sql,...args) {
    assert.match(sql,/^SELECT\s/i,'DO inspection is strictly read-only');
    assert.ok(doStorage&&native(path.resolve(doStorage)).startsWith(`${out}/state/`),'read only this run scratch SQLite');
    const disk=new DatabaseSync(doStorage,{readOnly:true});
    try{return JSON.parse(JSON.stringify(disk.prepare(sql).all(...args)));}
    finally{disk.close();}
  }
  const ingestKey=randomUUID();
  try {
    result.harness_sha256=hash(fs.readFileSync(fileURLToPath(import.meta.url)));
    result.source_sha256=sourceHashes();
    const {Miniflare,convertV4MiniflareOptions,Response:MFResponse}=require('miniflare');
    const {build}=require('esbuild');
    result.miniflare_version=JSON.parse(fs.readFileSync(path.join(worker,'node_modules/miniflare/package.json'),'utf8')).version;
    result.node_version=process.version;
    const fixture=await makeOperatorFixture();
    const policy=JSON.parse(fixture.env.OPERATOR_POLICY_JSON);
    policy['operator-2']={email:'second@example.test',permissions:['inference:recover'],cameras:['cam']};
    fixture.env.OPERATOR_POLICY_JSON=JSON.stringify(policy);
    const certUrl=`${fixture.issuer}/cdn-cgi/access/certs`;
    const certResponse=await fixture.fetcher(certUrl,{method:'GET',redirect:'manual',credentials:'omit',
      headers:{accept:'application/json'},signal:AbortSignal.timeout(1000)});
    const publicJwks=await certResponse.text(); // public only; private keys never leave fixture closure
    const second={'cf-access-jwt-assertion':await fixture.sign({sub:'operator-2',email:'second@example.test'})};
    const wrapper=`import actual from ${JSON.stringify(native(path.join(worker,'src/index.js')))};
import {CameraDO as ActualCameraDO} from ${JSON.stringify(native(path.join(worker,'src/camera-do.js')))};
export default actual;
export class CameraDO extends ActualCameraDO {
 constructor(state,env) {super(state,{...env,AI:{run:()=>env.TEST_NATIVE_OUTCOME==='hang'?new Promise(()=>{}):Promise.resolve({response:{}})}});}
}`;
    fs.writeFileSync(`${out}/test-wrapper.js`,wrapper);
    const bundle=await bounded(build({stdin:{contents:wrapper,resolveDir:root,sourcefile:'offline-test-wrapper.js'},
      bundle:true,write:false,format:'esm',platform:'neutral',target:'es2022',external:['node:*','cloudflare:*'],logLevel:'silent'}),20000,'bundle');
    const script=bundle.outputFiles[0].text;fs.writeFileSync(`${out}/worker.bundle.mjs`,script);
    result.bundle_sha256=hash(script);
    // Static complement to actual alarm evidence: GET handlers contain no expire call.
    const cameraSource=fs.readFileSync(path.join(worker,'src/camera-do.js'),'utf8');
    const healthGet=cameraSource.slice(cameraSource.indexOf("if (action==='health' &&"),cameraSource.indexOf("return new Response('method not allowed'",cameraSource.indexOf("if (action==='health' &&")));
    assert.ok(healthGet.includes('this.healthMonitor.snapshot()')&&healthGet.includes('this.healthMonitor.history('));
    assert.ok(!healthGet.includes('expire('));
    pass('health_GET_handlers_are_read_only_and_do_not_expire');
    async function boot(outcome) {
      assert.equal(mf,null,'one runtime at a time');
      lifetime={label:`lifetime-${result.lifetimes.length+1}`,native_outcome:outcome,started_at:new Date().toISOString()};
      result.lifetimes.push(lifetime);origin=null;
      const options=convertV4MiniflareOptions({name:'operator-contract',script,modules:true,
        compatibilityDate:'2026-09-01',compatibilityFlags:['nodejs_compat'],host:'127.0.0.1',port:0,
        cf:false,telemetry:{enabled:false},logRequests:false,resourcePersistencePath:result.persistence,
        resourceTmpPath:`${out}/runtime-tmp`,
        bindings:{...fixture.env,APP_ENV:'development',EVIDENCE_STORAGE:'pi',CAMERA_CONTEXTS_JSON:'{}',
          INGEST_API_KEY:ingestKey,DETECTOR_PROVIDER:'edge',VLM_PROVIDER:'workers_ai',
          VLM_MODEL:'@cf/meta/llama-4-scout-17b-16e-instruct',VLM_TIMEOUT_MS:'10',TEST_NATIVE_OUTCOME:outcome},
        durableObjects:{CAMERA_DO:{className:'CameraDO',useSQLite:true}},
        d1Databases:{DB:'operator-contract-d1'},
        outboundService:async request=>{
          if(request.url!==certUrl||request.method!=='GET') {
            result.outbound.rejected_requests++;return MFResponse.json({error:'offline_outbound_forbidden'},{status:502});
          }
          result.outbound.jwks_requests++;
          for(const name of ['authorization','cookie','x-api-key','cf-access-jwt-assertion'])
            assert.equal(request.headers.has(name),false,'JWKS must not receive request credentials');
          return new MFResponse(publicJwks,{status:200,headers:{'content-type':'application/json'}});
        }});
      assert.ok(Array.isArray(options.workers)&&options.workers[0].config,'current Miniflare config shape');
      mf=new Miniflare(options);
      origin=(await bounded(mf.ready,25000,'workerd startup')).origin;
      lifetime.url=origin;
      assert.equal((await http('/health')).ok,true);
      db=await bounded(mf.getD1Database('DB'),7000,'D1 binding');
    }
    await boot('hang');
    // Apply actual migrations through D1. Each trigger is one complete prepared
    // SQL statement, not D1.exec's line-oriented parser. Validate resulting schema
    // against SQLite executing the original, unsplit files.
    await bounded(db.prepare('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)').run(),7000,'migration ledger');
    const reference=new DatabaseSync(':memory:');
    try {
      for(const name of migrations) {
        const sql=fs.readFileSync(path.join(worker,'migrations',name),'utf8');
        reference.exec(sql);
        await bounded(db.batch([...migrationStatements(sql).map(sql=>db.prepare(sql)),
          db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(name)]),10000,`migration ${name}`);
        result.migrations.push({name,sha256:hash(sql)});
      }
      const schemaSql="SELECT name, type, sql FROM sqlite_master WHERE name IN ('cameras','events','operator_reviews','operator_reviews_target','operator_reviews_no_update','operator_reviews_no_delete') ORDER BY name";
      const normalized=rows=>rows.map(row=>({...row,sql:row.sql.replace(/--[^\r\n]*/g,'').replace(/\s+/g,' ').replace(/\s*([(),;])\s*/g,'$1').trim()}));
      assert.deepEqual(normalized((await d1(schemaSql)).results),normalized(reference.prepare(schemaSql).all()));
    } finally {reference.close();}
    assert.deepEqual((await d1('SELECT name FROM d1_migrations ORDER BY id')).results.map(row=>row.name),migrations);
    save('d1-schema.json',(await d1("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")).results);
    pass('real_D1_migrations_0001_through_0004_and_complete_append_only_triggers');
    const imagePath=path.join(root,'test_images','v1_hit_30.jpg'),image=fs.readFileSync(imagePath);
    const jpeg=image.toString('base64'),dimensions=validateJpeg(jpeg);
    result.image={path:native(imagePath),bytes:image.length,sha256:hash(image),dimensions,
      dimension_validation:'actual validateJpeg header/resource helper; not pixel decoding or detector validation'};
    assert.ok(jpeg.length<=512*1024,'existing JPEG exceeds transient image limit');
    pass('existing_JPEG_read_unchanged_dimensions_from_production_validateJpeg');
    const base=Date.now();
    async function observe(index,large=false) {
      const [w,h]=dimensions;
      const bbox=large?[0,0,Math.floor(w*.5),Math.floor(h*.5)]:[0,0,Math.floor(w*.1),Math.floor(h*.1)];
      return http('/observation/camera/cam',{camera_id:'cam',ts_ms:base+index*1000,
        frame_wh:dimensions,jpeg_b64:jpeg,detections:[{cls:'fire',conf:.8,bbox_xyxy:bbox}]});
    }
    for(let i=0;i<5;i++) {
      const response=await observe(i);assert.equal(response.hits,i+1);
      assert.equal(response.alert,i===4?'confirmed':i===0?'idle':'watch');
    }
    const timed=await poll('native deadline fallback',()=>http('/state/camera/cam'),s=>
      !s.analysis_status.active&&!s.analysis_status.queued&&!s.analysis_status.pending_followup&&
      s.analysis_status.native_inference_pending&&s.durability_status.pending_events===0&&s.cause?.vlm_error==='vlm_timeout');
    assert.equal(timed.cause.source,'rules_fallback');assert.equal(timed.cause.accepted_cause,'unknown');
    assert.equal(timed.durability_status.coordinator,'sqlite');
    const incident=timed.incident_id;result.incident_id=incident;
    await checkpoint('timeout-native-still-pending');
    const initialRows=await exactEvents(incident);save('initial-events.json',initialRows);
    assert.deepEqual(initialRows.map(row=>row.event_kind).sort(),['analysis','confirmation']);
    const initialAnalysis=initialRows.find(row=>row.event_kind==='analysis');
    assert.equal(JSON.parse(initialAnalysis.analysis_json).cause.vlm_error,'vlm_timeout');
    assert.equal(initialAnalysis.cause,'unknown');assert.equal(initialAnalysis.snapshot_key,null);
    pass('five_public_JPEG_observations_confirm_and_persist_timeout_without_cancelling_native',{incident_id:incident});
    // Deliberately separate client time from receipt time. Node/workerd on this
    // Windows host showed a 10ms cross-process clock offset; do not require
    // sub-millisecond ordering between their independent clocks.
    const heartbeat={camera_id:'cam',heartbeat_id:randomUUID(),sent_at_ms:Date.now()-20000,status:'ok'};
    const receiptBefore=Date.now(),sent=await http('/heartbeat/camera/cam',heartbeat),receiptAfter=Date.now();
    assert.equal(sent.accepted,true);assert.equal(sent.health.status,'online');
    const clockAllowanceMs=100;
    assert.ok(sent.health.last_seen_ms>=receiptBefore-clockAllowanceMs&&sent.health.last_seen_ms<=receiptAfter+clockAllowanceMs);
    assert.ok(sent.health.last_seen_ms-heartbeat.sent_at_ms>=19000,'client timestamp is not accepted receipt freshness');
    result.receipt_clock_check={node_before_ms:receiptBefore,node_after_ms:receiptAfter,
      server_receipt_ms:sent.health.last_seen_ms,client_sent_ms:heartbeat.sent_at_ms,clock_allowance_ms:clockAllowanceMs};
    const lastSeen=sent.health.last_seen_ms;result.first_heartbeat_receipt_ms=lastSeen;
    save('heartbeat-first.json',sent);
    await stop();await boot('complete');
    const restored=await checkpoint('interrupted-native-restored');
    assert.equal(restored.incident_id,incident);assert.equal(restored.durability_status.native_inference_interrupted,true);
    assert.equal(restored.analysis_status.native_inference_pending,true);assert.equal(restored.analysis_status.active,false);
    assert.deepEqual(await exactEvents(incident),initialRows);
    assert.deepEqual(await http('/health/camera/cam'),sent.health);
    const duplicate=await http('/heartbeat/camera/cam',heartbeat);
    assert.equal(duplicate.accepted,false);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.health.last_seen_ms,lastSeen);
    pass('restart_preserves_native_interruption_gate_confirmation_analysis_and_server_heartbeat_receipt');
    pass('duplicate_heartbeat_does_not_refresh_receipt');
    // Current Miniflare's storage-inspection RPC requires extends DurableObject;
    // actual CameraDO is fetch-style. Inspect ONLY its uniquely identified scratch
    // SQLite, read-only; never add a production or wrapper inspection backdoor.
    const doDir=`${result.persistence}/do/operator-contract-CameraDO`;
    const candidates=[];
    for(const entry of fs.readdirSync(doDir)) {
      if(!/^[0-9a-f]{64}\.sqlite$/.test(entry))continue;
      const file=`${doDir}/${entry}`,disk=new DatabaseSync(file,{readOnly:true});
      try {
        const tables=disk.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name);
        if(tables.includes('fire_coordinator_checkpoint')&&tables.includes('camera_health_events'))candidates.push(file);
      }finally{disk.close();}
    }
    assert.equal(candidates.length,1,'unique scratch CameraDO SQLite required');
    doStorage=candidates[0];result.do_sqlite_path=doStorage;
    result.do_readback_method='read-only SQLite; actual CameraDO does not extend RPC DurableObject';
    const recovery=(await http('/operator/cameras/cam/recovery',undefined,fixture.headers)).recovery;
    assert.equal(recovery.required,true);assert.equal(recovery.live_native_operation,false);
    const proposal={request_id:randomUUID(),action:'propose',expected_generation:recovery.generation,
      expected_job_id:recovery.analysis_job_id,provider_outcome:'completed',provider_reference:'synthetic-provider-contract-case-123',
      rationale:'Synthetic external-provider outcome attestation for offline contract testing only; no real provider verification.'};
    const proposed=await http('/operator/cameras/cam/recovery',proposal,fixture.headers);
    assert.equal(proposed.recovery.required,true);assert.equal(proposed.audit.actor_subject,'operator-1');
    const approval={request_id:randomUUID(),action:'approve',expected_generation:recovery.generation,
      expected_job_id:recovery.analysis_job_id,proposal_id:proposal.request_id,review_reference:'synthetic-independent-review-456',
      rationale:'Synthetic independent-operator attestation exercises authorization and durable release, not provider cancellation.'};
    await http('/operator/cameras/cam/recovery',approval,fixture.headers,403);
    const accepted=await http('/operator/cameras/cam/recovery',approval,second);
    assert.equal(accepted.recovery.required,false);assert.equal(accepted.audit.actor_subject,'operator-2');
    assert.equal(accepted.recovery.backend_status_verified_by_application,false);
    const retry=await http('/operator/cameras/cam/recovery',approval,second);
    assert.equal(retry.idempotent,true);assert.equal(retry.recovery.required,false);
    assert.equal((await http('/operator/cameras/cam/recovery',proposal,fixture.headers)).idempotent,true);
    const audits=await http('/operator/cameras/cam/recovery-audits',undefined,second);
    assert.equal(audits.records.length,2);assert.equal(audits.has_more,false);
    assert.deepEqual(audits.records.map(row=>row.request_id).sort(),[proposal.request_id,approval.request_id].sort());
    const storedAudits=await storageRead('SELECT record_json FROM fire_native_recovery_audit ORDER BY rowid DESC');
    assert.deepEqual(storedAudits.map(row=>JSON.parse(row.record_json)),audits.records);
    const storedCheckpoint=JSON.parse((await storageRead('SELECT checkpoint_json FROM fire_coordinator_checkpoint WHERE singleton = 1'))[0].checkpoint_json);
    assert.equal(storedCheckpoint.cameraId,'cam');
    assert.equal(storedCheckpoint.incidentId,incident);
    assert.equal(storedCheckpoint.nativeInferenceInterrupted,false);
    assert.equal(storedCheckpoint.nativeInference,false);
    save('released-coordinator-checkpoint.json',storedCheckpoint);save('recovery-audits.json',audits);
    assert.equal((await checkpoint('recovery-released')).durability_status.native_inference_interrupted,false);
    pass('real_signed_two_operator_recovery_self_approval_403_independent_200_and_durable_audits');
    pass('recovery_retries_are_idempotent_no_extra_audit');
    for(const action of ['reviews','recovery','recovery-audits'])
      await http(`/operator/cameras/cam/${action}`,undefined,{},401);
    await http('/operator/cameras/cam/reviews',{}, {},401);
    // Alter a valid signature without changing its syntactically valid JWT claims.
    const parts=fixture.headers['cf-access-jwt-assertion'].split('.');
    const signature=Buffer.from(parts[2],'base64url');signature[0]^=1;parts[2]=signature.toString('base64url');
    await http('/operator/cameras/cam/recovery',undefined,{'cf-access-jwt-assertion':parts.join('.')},401);
    pass('ingest_key_only_denied_all_operator_routes_and_bad_RSA_signature_rejected');
    await observe(5,true); await observe(6); await observe(7);
    const completed=await poll('time-spread later scene analysis',()=>http('/state/camera/cam'),s=>
      s.analysis_status.latest_job_id===2&&!s.analysis_status.active&&!s.analysis_status.queued&&
      !s.analysis_status.pending_followup&&!s.analysis_status.native_inference_pending&&
      s.durability_status.pending_events===0&&s.cause?.source==='workers_ai');
    assert.equal(completed.cause.accepted_cause,'unknown');assert.equal(completed.cause.requires_human_review,true);
    assert.equal(completed.cause.ignition_source,'unknown');
    const finalRows=await exactEvents(incident);save('synthetic-completed-events.json',finalRows);
    assert.equal(finalRows.length,3);assert.equal(finalRows.filter(row=>row.event_kind==='confirmation').length,1);
    const target=finalRows.find(row=>row.event_key===`${incident}:analysis:2`);assert.ok(target);
    const event=JSON.parse(target.analysis_json);
    assert.equal(event.analysis_reason,'later_scene_evidence');assert.equal(event.analysis_status,'complete');
    assert.equal(event.cause.source,'workers_ai');assert.equal(event.cause.accepted_cause,'unknown');
    assert.equal(target.cause,'unknown');assert.equal(target.snapshot_key,null);
    assert.deepEqual(event.cause,completed.cause);assert.deepEqual(event.evidence_manifest,completed.evidence_manifest);
    assert.ok(event.evidence_manifest.some(frame=>frame.ts_ms===base+5000&&frame.roles.includes('peak')));
    assert.deepEqual(finalRows.find(row=>row.event_key===initialAnalysis.event_key),initialAnalysis);
    await checkpoint('synthetic-completed-peak');
    result.analysis_event_key=target.event_key;
    pass('larger_measured_peak_completes_synthetic_binding_analysis_exact_D1_public_readback_cause_unknown');
    const reviewBody={request_id:randomUUID(),incident_id:incident,analysis_event_key:target.event_key,
      expected_revision:0,disposition:'accept',ignition_source:'electrical',ignition_tool:'unknown',
      independent_evidence:{kind:'verified_investigation',reference:'synthetic-human-review-case-789',
        summary:'Synthetic independent human evidence fixture only; no evidence about a real fire.'},
      rationale:'Offline contract test of separate attribution; this claim is not machine-verified factual truth.'};
    const reviewed=await http('/operator/cameras/cam/reviews',reviewBody,fixture.headers);
    assert.equal(reviewed.operator_review.revision,1);assert.equal(reviewed.operator_review.subject,'operator-1');
    assert.equal(reviewed.operator_review.analysis_event_key,target.event_key);
    assert.equal(reviewed.operator_review.factual_correctness_verified,false);
    const reviewRetry=await http('/operator/cameras/cam/reviews',reviewBody,fixture.headers);
    assert.equal(reviewRetry.idempotent,true);assert.deepEqual(reviewRetry.operator_review,reviewed.operator_review);
    const history=await http(`/operator/cameras/cam/reviews?incident_id=${encodeURIComponent(incident)}`,undefined,fixture.headers);
    assert.deepEqual(history.reviews,[reviewed.operator_review]);assert.equal(history.latest_revision,1);assert.equal(history.has_more,false);
    const reviewRows=(await d1('SELECT * FROM operator_reviews WHERE camera_id=? AND incident_id=?',['cam',incident])).results;
    assert.equal(reviewRows.length,1);assert.equal(reviewRows[0].request_id,reviewBody.request_id);
    assert.equal(reviewRows[0].analysis_event_key,target.event_key);assert.equal(reviewRows[0].revision,1);
    assert.deepEqual(await exactEvents(incident),finalRows,'human review must not mutate original model event JSON or scalars');
    // Exercise actual D1 append-only triggers; failed writes are not application writes.
    for(const sql of ['UPDATE operator_reviews SET rationale = rationale WHERE request_id = ?',
      'DELETE FROM operator_reviews WHERE request_id = ?']) {
      await assert.rejects(()=>bounded(db.prepare(sql).bind(reviewBody.request_id).run(),7000,'append-only rejection'),/immutable append-only history/);
    }
    assert.equal((await d1('SELECT COUNT(*) AS total FROM operator_reviews')).results[0].total,1);
    save('operator-review.json',history);save('operator-review-d1.json',reviewRows);
    pass('human_review_exact_analysis_key_separate_immutable_model_events_idempotent_single_revision');
    pass('actual_D1_append_only_update_and_delete_triggers_reject_mutation');
    // Let the real production 60-second deadline run. No fake clock, threshold
    // override, manual alarm invocation or further camera POST until offline.
    const remaining=Math.max(0,lastSeen+61500-Date.now());
    console.log('WAIT_REAL_HEALTH_ALARM_MS',remaining);
    await bounded(sleep(remaining),remaining+2000,'real health deadline');
    const beforeHistory=Date.now();
    const rawHealth=await storageRead('SELECT * FROM camera_health_events ORDER BY sequence');
    save('health-raw-before-public-poll.json',rawHealth);
    // This durable row must already exist BEFORE any post-deadline public GET.
    assert.equal(rawHealth.filter(row=>row.status==='offline').length,1,'alarm, not GET, must persist offline transition');
    const offlineHistory=await poll('durable offline history',()=>http('/health-events/camera/cam'),h=>h.events.some(row=>row.status==='offline'),5000);
    const offline=offlineHistory.events.filter(row=>row.status==='offline');assert.equal(offline.length,1);
    assert.ok(offline[0].at_ms>=lastSeen+60000);assert.ok(offline[0].at_ms<=beforeHistory);
    assert.equal(offline[0].last_seen_ms,lastSeen);
    assert.equal((await http('/health/camera/cam')).status,'offline');
    assert.deepEqual(await http('/health-events/camera/cam'),offlineHistory);
    save('health-offline.json',offlineHistory);
    pass('real_60_second_alarm_durably_records_one_offline_without_new_camera_traffic_before_GET',
      {receipt_ms:lastSeen,offline_ms:offline[0].at_ms,elapsed_ms:offline[0].at_ms-lastSeen});
    const degradedBody={camera_id:'cam',heartbeat_id:randomUUID(),sent_at_ms:Date.now(),status:'inference_error'};
    const degraded=await http('/heartbeat/camera/cam',degradedBody);
    assert.equal(degraded.accepted,true);assert.equal(degraded.health.status,'degraded');
    assert.equal(degraded.transitions.length,1);assert.equal(degraded.transitions[0].reason,'inference_error');
    const degradedRetry=await http('/heartbeat/camera/cam',degradedBody);assert.equal(degradedRetry.accepted,false);
    assert.equal(degradedRetry.health.last_seen_ms,degraded.health.last_seen_ms);
    const healthFinal=await http('/health-events/camera/cam');
    assert.deepEqual(healthFinal.events.map(row=>row.status),['degraded','offline','online']);
    assert.deepEqual(await storageRead('SELECT status FROM camera_health_events ORDER BY sequence DESC'),
      [{status:'degraded'},{status:'offline'},{status:'online'}]);
    save('health-final.json',healthFinal);
    pass('fresh_degraded_heartbeat_records_exactly_one_recovery_transition_duplicate_does_not_refresh');
    assert.deepEqual(await exactEvents(incident),finalRows);
    assert.equal(hash(fs.readFileSync(imagePath)),result.image.sha256);
    assert.equal(result.outbound.rejected_requests,0);assert.ok(result.outbound.jwks_requests>0);
    result.source_sha256_after=sourceHashes();
    result.source_changed_during_run=JSON.stringify(result.source_sha256)!==JSON.stringify(result.source_sha256_after);
    assert.equal(result.source_changed_during_run,false,'production sources changed during contract execution');
    pass('no_remote_outbound_or_real_model_calls_existing_image_unchanged');
    result.passed=true;
  } catch(error) {
    result.error={name:error.name,message:error.message,stack:error.stack};process.exitCode=1;
  } finally {
    try{await stop();}catch(error){result.cleanup_error=error.message;result.passed=false;process.exitCode=1;}
    result.cleanup_verified=mf===null&&result.cleanup.length===result.lifetimes.length&&
      result.cleanup.every(row=>row.dispose_completed&&row.tcp_refused);
    if(!result.cleanup_verified){result.passed=false;process.exitCode=1;}
    result.finished_at=new Date().toISOString();result.elapsed_ms=Date.now()-started;
    save('result.json',result);
    console.log('RESULT_PATH',resultPath);
    console.log(JSON.stringify({passed:result.passed,assertions:result.assertions.length,cleanup_verified:result.cleanup_verified,
      elapsed_ms:result.elapsed_ms,error:result.error?.message,cleanup:result.cleanup}));
  }
  return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await runOperatorRuntime();
