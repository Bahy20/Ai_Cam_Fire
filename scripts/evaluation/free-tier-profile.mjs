// Local, deterministic 24-hour workload through the real Worker and CameraDO
// handlers. This measures the application's SQLite operations; it is not a
// Cloudflare billing measurement and cannot pass the account reconciliation gate.
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,readdirSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import worker from '../../worker/src/index.js';
import {CameraDO} from '../../worker/src/camera-do.js';
import {canonicalObservationBatchHash} from '../../worker/src/observation-batch.js';
import {buildReadinessReport} from './readiness.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const PILOT_PROFILE=Object.freeze({version:1,samples_per_second:3,batch_seconds:2,
  samples_per_batch:6,heartbeat_seconds:30,simulated_duration_ms:86_400_000,
  samples_per_day:259_200,batches_per_day:43_200,short_incidents_per_day:100,
  long_incident_samples:900,retry_fraction:0.01,outage_seconds:120});
const key='local-profile-key';
const cameraId='free-tier-profile';
const sessionId='4a111a7f-fb0b-4798-babd-719f7f5f2f39';
const hash='0'.repeat(64);
const defaultOutput=path.join(root,'.hermes','free-tier-profile-20261019.json');

function meters(){return {worker_requests:0,worker_request_bytes:0,worker_response_bytes:0,
  durable_object_requests:0,durable_object_generation_claims:0,durable_object_alarm_invocations:0,do_alarm_metadata_reads:0,
  do_alarm_metadata_writes:0,local_do_sqlite_result_rows_read:0,
  local_do_sqlite_changed_rows:0,local_do_sqlite_changed_rows_by_table:{},local_do_sqlite_row_deletes:0,
  local_do_sqlite_index_rows_written_estimate:0,local_do_sqlite_index_rows_written_by_table:{},
  local_d1_result_rows_read:0,local_d1_changed_rows:0,local_d1_row_deletes:0,
  local_d1_index_rows_written_estimate:0,
  local_do_sqlite_page_bytes:0,local_d1_page_bytes:0,local_d1_event_payload_bytes:0,
  observation_samples_reduced:0,accepted_samples:0,stale_samples:0,
  committed_batches:0,idempotent_retries:0,heartbeats:0,evidence_packs:0,local_do_duration_ms:0};}

function instrumentedSqlite(db,metrics,{d1=false}={}){
  const tableIndexes=new Map();
  const indexesFor=table=>{
    if(!tableIndexes.has(table)){
      const indexes=db.prepare(`PRAGMA index_list(${table})`).all().map(row=>
        db.prepare(`PRAGMA index_info('${String(row.name).replaceAll("'","''")}')`).all()
          .map(column=>String(column.name).toLowerCase()).filter(Boolean));
      tableIndexes.set(table,indexes);
    }
    return tableIndexes.get(table);
  };
  return {exec(query,...args){
    const statement=db.prepare(query),table=(/^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+[`"]?([\w]+)/i.exec(query)?.[1] ?? 'unknown').toLowerCase();
    if(statement.columns().length){
      const rows=statement.all(...args);
      if(d1)metrics.local_d1_result_rows_read+=rows.length;else metrics.local_do_sqlite_result_rows_read+=rows.length;
      return {toArray:()=>rows,changes:0};
    }
    const result=statement.run(...args),changes=Number(result.changes ?? 0);
    if(!/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(query))return {toArray:()=>[],changes:0};
    const mutation=/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.exec(query)?.[1].toUpperCase();
    const indexes=indexesFor(table);
    let touchedIndexes=indexes.length;
    if(mutation==='UPDATE'){
      const assignments=/\bSET\s+([\s\S]*?)(?:\bWHERE\b|$)/i.exec(query)?.[1] ?? '';
      const updatedColumns=new Set(assignments.split(',').map(part=>
        part.split('=')[0].trim().replace(/[`"\[\]]/g,'').toLowerCase()).filter(Boolean));
      touchedIndexes=indexes.filter(columns=>columns.some(column=>updatedColumns.has(column))).length;
    }
    const indexRows=changes*touchedIndexes;
    if(d1){
      metrics.local_d1_changed_rows+=changes;
      metrics.local_d1_index_rows_written_estimate+=indexRows;
      if(/^\s*DELETE\b/i.test(query))metrics.local_d1_row_deletes+=changes;
    }
    else {
      metrics.local_do_sqlite_changed_rows+=changes;
      metrics.local_do_sqlite_index_rows_written_estimate+=indexRows;
      if(changes)metrics.local_do_sqlite_changed_rows_by_table[table]=(metrics.local_do_sqlite_changed_rows_by_table[table] ?? 0)+changes;
      if(indexRows)metrics.local_do_sqlite_index_rows_written_by_table[table]=
        (metrics.local_do_sqlite_index_rows_written_by_table[table] ?? 0)+indexRows;
      if(/^\s*DELETE\b/i.test(query))metrics.local_do_sqlite_row_deletes+=changes;
    }
    return {toArray:()=>[],changes};
  }};
}

function workloadSample(sequence,ts,positive){
  return {attempt_sequence:sequence,ts_ms:ts,status:'ok',frame_wh:[100,80],
    detections:positive?[{cls:'fire',conf:.8,bbox_xyxy:[10,10,30,30]}]:[],
    jpeg_sha256:hash,local_image_available:false,visibility:'adequate',camera_motion:false,
    quality:{stability:'stable',blur_score:.1,occlusion:'none'},reason:null};
}

function scenarioMap(){
  const positives=new Set();
  for(let i=0;i<PILOT_PROFILE.long_incident_samples;i++)positives.add(i);
  const firstShort=1500,spacing=Math.floor((PILOT_PROFILE.samples_per_day-firstShort-2000)/PILOT_PROFILE.short_incidents_per_day);
  for(let episode=0;episode<PILOT_PROFILE.short_incidents_per_day;episode++){
    const start=firstShort+episode*spacing;
    for(let offset=0;offset<5;offset++)positives.add(start+offset);
  }
  return positives;
}

function createRuntime(metrics,waiters){
  const doDb=new DatabaseSync(':memory:'),d1Db=new DatabaseSync(':memory:');
  for(const name of readdirSync(path.join(root,'worker','migrations')).filter(name=>/^\d+_.+\.sql$/.test(name)).sort())
    d1Db.exec(readFileSync(path.join(root,'worker','migrations',name),'utf8'));
  let alarmAt=null;
  const storage={sql:instrumentedSqlite(doDb,metrics),transactionSync(callback){
    doDb.exec('BEGIN IMMEDIATE');try{const result=callback();doDb.exec('COMMIT');return result;}
    catch(error){doDb.exec('ROLLBACK');throw error;}
  },sync:async()=>{},getAlarm:async()=>{metrics.do_alarm_metadata_reads++;return alarmAt;},
    setAlarm:async value=>{metrics.do_alarm_metadata_writes++;alarmAt=value;},
    deleteAlarm:async()=>{metrics.do_alarm_metadata_writes++;alarmAt=null;},
    put:async()=>{},get:async()=>undefined,delete:async()=>{}};
  const eventDb=instrumentedSqlite(d1Db,metrics,{d1:true});
  const env={APP_ENV:'development',VLM_EVALUATION_MODE:'true',DETECTOR_PROVIDER:'edge',
    EVIDENCE_STORAGE:'pi',INGEST_API_KEY:key,DB:{prepare:sql=>({bind:(...params)=>({
      first:async()=>eventDb.exec(sql,...params).toArray()[0]??null,
      all:async()=>({results:eventDb.exec(sql,...params).toArray()}),
      run:async()=>{const result=eventDb.exec(sql,...params);return {success:true,meta:{changes:result.changes}};}
    })})}};
  const createCamera=()=>{
    const instance=new CameraDO({storage,waitUntil:promise=>waiters.push(promise),getWebSockets:()=>[]},env);
    metrics.durable_object_generation_claims++;
    return instance;
  };
  let camera=createCamera();
  env.CAMERA_DO={idFromName:id=>id,get:id=>({fetch:async request=>{
    metrics.durable_object_requests++;
    const started=performance.now();
    try{return await camera.fetch(request);}finally{metrics.local_do_duration_ms+=performance.now()-started;}
  }})};
  const close=()=>{doDb.close();d1Db.close();};
  return {get camera(){return camera;},env,storage,close,alarm:()=>alarmAt,
    restart(){camera=createCamera();},setAlarm:value=>{alarmAt=value;},
    d1Count:()=>d1Db.prepare('SELECT COUNT(*) AS count FROM events').get().count,
    d1Bytes:()=>d1Db.prepare('SELECT COALESCE(SUM(length(analysis_json)),0) AS bytes FROM events').get().bytes,
    pageCount:()=>d1Db.prepare('PRAGMA page_count').get().page_count,
    pageSize:()=>d1Db.prepare('PRAGMA page_size').get().page_size,
    doPageCount:()=>doDb.prepare('PRAGMA page_count').get().page_count,
    doPageSize:()=>doDb.prepare('PRAGMA page_size').get().page_size};
}

async function sendWorker(runtime,metrics,route,body){
  const json=JSON.stringify(body);
  const request=new Request(`http://127.0.0.1${route}`,{method:'POST',headers:{'x-api-key':key,'content-type':'application/json'},body:json});
  metrics.worker_requests++;metrics.worker_request_bytes+=new TextEncoder().encode(json).length;
  const response=await worker.fetch(request,runtime.env,{}),text=await response.text();
  metrics.worker_response_bytes+=new TextEncoder().encode(text).length;
  if(!response.ok)throw new Error(`profile_http_${response.status}:${text.slice(0,200)}`);
  return text?JSON.parse(text):null;
}

function fullDayBatch(sequence,startAttempt,positives,simBase){
  const start=startAttempt-1;
  const samples=Array.from({length:6},(_,offset)=>{
    const index=start+offset,ts=simBase+Math.round(index*1000/3);
    return workloadSample(index+1,ts,positives.has(index));
  });
  return {protocol_version:2,session_id:sessionId,generation:1,batch_sequence:sequence,
    clock_mode:'replay',payload_hash:hash,samples};
}

async function actualDay(runtime,metrics,waiters,simBase){
  const positives=scenarioMap(),retryBatches=Math.floor(PILOT_PROFILE.batches_per_day*PILOT_PROFILE.retry_fraction);
  const retryEvery=Math.floor(PILOT_PROFILE.batches_per_day/retryBatches);
  let nextHeartbeat=simBase+PILOT_PROFILE.heartbeat_seconds*1000,alarmCount=0;
  let restartCount=0,restartDuplicateAck=false;
  await sendWorker(runtime,metrics,`/v2/sessions/camera/${cameraId}`,{protocol_version:2,session_id:sessionId,expected_generation:0},simBase);
  Date.now=()=>simBase;
  await sendWorker(runtime,metrics,`/heartbeat/camera/${cameraId}`,{
    camera_id:cameraId,heartbeat_id:randomUUID(),sent_at_ms:simBase,status:'ok'});
  metrics.heartbeats++;
  for(let batchNo=1;batchNo<=PILOT_PROFILE.batches_per_day;batchNo++){
    const firstAttempt=(batchNo-1)*6+1,batch=fullDayBatch(batchNo,firstAttempt,positives,simBase);
    const now=batch.samples.at(-1).ts_ms;
    Date.now=()=>now;
    batch.payload_hash=await canonicalObservationBatchHash(batch);
    const ack=await sendWorker(runtime,metrics,`/v2/observations/camera/${cameraId}`,batch,now);
    metrics.committed_batches++;
    metrics.observation_samples_reduced+=batch.samples.length;
    metrics.accepted_samples+=ack.dispositions.filter(item=>item.status==='accepted').length;
    if(batchNo%retryEvery===0){
      const duplicate=await sendWorker(runtime,metrics,`/v2/observations/camera/${cameraId}`,batch,now);
      if(duplicate.idempotent!==true)throw new Error('lost_ack_retry_not_idempotent');
      metrics.idempotent_retries++;
    }
    if(waiters.length){const pending=waiters.splice(0);for(const promise of pending)await promise;}
    if(batchNo===PILOT_PROFILE.batches_per_day/2){
      runtime.restart();restartCount++;
      const recoveredAck=await sendWorker(runtime,metrics,`/v2/observations/camera/${cameraId}`,batch,now);
      restartDuplicateAck=recoveredAck.idempotent===true;
    }
    while(nextHeartbeat<=now){
      Date.now=()=>nextHeartbeat;
      const heartbeat={camera_id:cameraId,heartbeat_id:randomUUID(),sent_at_ms:nextHeartbeat,status:'ok'};
      await sendWorker(runtime,metrics,`/heartbeat/camera/${cameraId}`,heartbeat,nextHeartbeat);
      metrics.heartbeats++;
      if(runtime.alarm()!==null && runtime.alarm()<=nextHeartbeat){
        runtime.setAlarm(null);metrics.durable_object_alarm_invocations++;alarmCount++;
        const startedAlarm=performance.now();await runtime.camera.alarm();
        metrics.local_do_duration_ms+=performance.now()-startedAlarm;
      }
      nextHeartbeat+=PILOT_PROFILE.heartbeat_seconds*1000;
    }
    Date.now=()=>now;
    if(batchNo%3600===0)process.stdout.write(`simulated ${batchNo}/${PILOT_PROFILE.batches_per_day} batches\n`);
  }
  const staleTarget=simBase+PILOT_PROFILE.simulated_duration_ms+PILOT_PROFILE.outage_seconds*1000;
  Date.now=()=>staleTarget;
  let nextSeq=PILOT_PROFILE.samples_per_day+1,nextBatch=PILOT_PROFILE.batches_per_day+1;
  const outageStartTs=simBase+Math.round((PILOT_PROFILE.samples_per_day-1)*1000/3);
  for(let offset=0;offset<360;offset+=6){
    const samples=Array.from({length:6},(_,i)=>{
      const index=offset+i,ts=outageStartTs+Math.round((index+1)*1000/3);
      return workloadSample(nextSeq++,ts,false);
    });
    const batch={protocol_version:2,session_id:sessionId,generation:1,batch_sequence:nextBatch++,
      clock_mode:'live',payload_hash:hash,samples};
    batch.payload_hash=await canonicalObservationBatchHash(batch);
    const ack=await sendWorker(runtime,metrics,`/v2/observations/camera/${cameraId}`,batch,staleTarget);
    metrics.stale_samples+=ack.dispositions.filter(item=>item.status==='skipped_stale').length;
    metrics.accepted_samples+=ack.dispositions.filter(item=>item.status==='accepted').length;
  }
  const currentTs=staleTarget+333;
  Date.now=()=>currentTs;
  const recovered={protocol_version:2,session_id:sessionId,generation:1,batch_sequence:nextBatch,
    clock_mode:'live',payload_hash:hash,samples:[workloadSample(nextSeq,currentTs,false)]};
  recovered.payload_hash=await canonicalObservationBatchHash(recovered);
  const recoveryAck=await sendWorker(runtime,metrics,`/v2/observations/camera/${cameraId}`,recovered,currentTs);
  metrics.observation_samples_reduced+=360;
  metrics.observation_samples_reduced+=1;
  metrics.accepted_samples+=recoveryAck.dispositions.filter(item=>item.status==='accepted').length;
  return {retryBatches,alarmCount,staleRecoveryDispositionCount:metrics.stale_samples,
    recoveryFinalDisposition:recoveryAck.dispositions[0]?.status,positives:positives.size,
    restartCount,restartDuplicateAck};
}

function sourceHashes(){
  const files=['worker/src/camera-do.js','worker/src/camera-health.js','worker/src/coordinator-journal.js',
    'worker/src/index.js','worker/src/incident-store.js','worker/src/observation-batch.js',
    'scripts/evaluation/readiness.mjs','worker/test/readiness.test.js','worker/test/camera-health.test.js',
    'scripts/evaluation/free-tier-profile.mjs'];
  return Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(path.join(root,file))).digest('hex')]));
}

export async function runFreeTierProfile({out=defaultOutput}={}){
  const metrics=meters(),waiters=[],runtime=createRuntime(metrics,waiters);
  const realNow=Date.now,simBase=Date.UTC(2026,9,19),started=performance.now();
  try {
    const recovery=await actualDay(runtime,metrics,waiters,simBase);
    for(const promise of waiters.splice(0))await promise;
    const duration=performance.now()-started;
    const eventRows=runtime.d1Count(),d1Bytes=runtime.d1Bytes();
    metrics.local_d1_event_payload_bytes=d1Bytes;
    metrics.local_d1_page_bytes=runtime.pageCount()*runtime.pageSize();
    metrics.local_do_sqlite_page_bytes=runtime.doPageCount()*runtime.doPageSize();
    metrics.local_do_sqlite_and_alarm_row_write_estimate=metrics.local_do_sqlite_changed_rows+
      metrics.local_do_sqlite_index_rows_written_estimate+metrics.do_alarm_metadata_writes;
    const incidentRows=runtime.camera.journal.pending().length;
    const invariants={sample_count:metrics.observation_samples_reduced===PILOT_PROFILE.samples_per_day+361,
      full_day_batches:metrics.committed_batches===PILOT_PROFILE.batches_per_day,
      accepted_idle_and_incident_samples:metrics.accepted_samples>=PILOT_PROFILE.samples_per_day,
      retry_count:metrics.idempotent_retries===recovery.retryBatches,
      durable_restart:recovery.restartCount===1,
      lost_ack_after_restart_is_idempotent:recovery.restartDuplicateAck,
      stale_outage_records:recovery.staleRecoveryDispositionCount>0,
      recovered_current_sample:recovery.recoveryFinalDisposition==='accepted',
      confirmed_incidents:eventRows===202,
      periodic_alarm_floor:recovery.alarmCount>=1440,
      local_do_row_write_estimate_under_60k:metrics.local_do_sqlite_and_alarm_row_write_estimate<60_000,
      durable_generation_claims:metrics.durable_object_generation_claims===2,
      no_remote_inference_binding:runtime.env.AI===undefined&&runtime.env.AI_EVALUATION===undefined&&
        runtime.env.VLM_EVALUATION_MODE==='true'};
    const result={profile:'one_camera_3fps_24h_mixed_event_and_retry_simulation',profile_version:1,
      runtime:'local Worker and CameraDO code with Node SQLite surrogate',cloudflare_billing_measured:false,
      remote_ai_enabled:false,account_reconciled:false,profile:PILOT_PROFILE,
      simulation:{wall_duration_ms:duration,simulated_duration_ms:PILOT_PROFILE.simulated_duration_ms,
        source_hashes:sourceHashes(),evidence_path:path.resolve(out)},meters:metrics,
      recovery:{...recovery,local_capture_during_outage_samples:360,
        outage_duration_ms:PILOT_PROFILE.outage_seconds*1000},
      validation:{invariants,passed:Object.values(invariants).every(Boolean),persisted_event_rows:eventRows,
        pending_outbox_rows:incidentRows,
        simulated_day_local_do_sql_changed_rows:metrics.local_do_sqlite_changed_rows,
        local_do_row_write_estimate:metrics.local_do_sqlite_and_alarm_row_write_estimate},
      public_free_plan_projection:{as_of:'2026-10-19',account_plan_verified:false,
        public_limits:{workers_requests_per_day:100000,workers_cpu_ms_per_invocation:10,
          durable_object_requests_including_alarms_per_day:100000,
          durable_object_duration_gb_seconds:13000,durable_object_sqlite_rows_read:5000000,
          durable_object_sqlite_rows_written:100000,durable_object_sqlite_storage_bytes:5_000_000_000,
          d1_rows_read:5000000,d1_rows_written:100000,d1_storage_account_total_bytes:5_000_000_000,
          workers_ai_neurons_per_day:10000},
        app_traffic_estimate:{workers_requests:metrics.worker_requests,
          workers_request_headroom_fraction:Math.max(0,1-metrics.worker_requests/100000),
          durable_object_requests:metrics.durable_object_requests+metrics.durable_object_alarm_invocations,
          durable_object_request_headroom_fraction:Math.max(0,1-(metrics.durable_object_requests+
            metrics.durable_object_alarm_invocations)/100000)},
        unmeasured_account_meters:['workers_cpu_ms_per_invocation','durable_object_duration_gb_seconds',
          'durable_object_sqlite_rows_read',
          'durable_object_sqlite_rows_written_with_indexes_and_alarm_rows','d1_rows_read_scanned',
          'd1_rows_written_with_indexes','durable_object_sqlite_storage_account_total',
          'd1_storage_account_total','workers_ai_neurons']},
      limitations:['local_sqlite_changed_rows_and_result_rows_are_not_cloudflare_billed_usage',
        'local_result_row_counts_do_not_measure_rows_scanned_by_d1_or_durable_objects',
        'local_changed_row_counts_omit_billed_index_rows_and_alarm_storage_rows',
        'account_dashboard_allowances_and_unrelated_account_usage_not_reconciled',
        'cloudflare_worker_duration_and_do_duration_not_measured',
        'no_jpeg_upload_or_remote_ai_calls_in_cost_profile',
        'recovery_queue_samples_are_simulated_without_a_120_second_wall_clock_wait']};
    result.readiness=buildReadinessReport({free_tier_profile:{simulated_duration_ms:result.simulation.simulated_duration_ms,
      measured_row_writes_per_day:metrics.local_do_sqlite_changed_rows,simulation_complete:result.validation.passed,
      cloudflare_runtime_measurements:false,account_reconciled:false,evidence_paths:[path.resolve(out)]}}).stages.free_tier_profile;
    mkdirSync(path.dirname(path.resolve(out)),{recursive:true});
    writeFileSync(path.resolve(out),JSON.stringify(result,null,2));
    if(!result.validation.passed)throw new Error(`profile_invariants_failed:${JSON.stringify(invariants)}`);
    return result;
  } finally {
    Date.now=realNow;
    runtime.close();
  }
}

const outArg=process.argv.indexOf('--out');
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const out=outArg>=0?path.resolve(process.argv[outArg+1]):defaultOutput;
  runFreeTierProfile({out}).then(result=>{
    console.log(JSON.stringify({passed:result.validation.passed,readiness:result.readiness,
      simulated_duration_ms:result.simulation.simulated_duration_ms,meters:result.meters,
      evidence_path:result.simulation.evidence_path},null,2));
  }).catch(error=>{console.error(error.message);process.exitCode=1;});
}
