// Offline CONTRACT smoke test: real public HTTP routes + workerd process restarts.
// No images, detector inference, VLM calls, remote D1, R2, deployment or installs.
// Run: node scripts/test_coordinator_restart.mjs [--fail-after-watch]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = value => value.replaceAll('\\', '/');
const worker = native(path.join(root, 'worker'));
const wrangler = `${worker}/node_modules/wrangler/bin/wrangler.js`;
const config = `${worker}/wrangler.dev.jsonc`;
const ports = [8797, 9239];
const origin = `http://127.0.0.1:${ports[0]}`;
const scratch = 'C:/Users/moihammed/AppData/Local/hermes/cache/scratch';
const MAX_RUN_MS = 300000;

// Read process identity/ancestry, never command lines or environment/credentials.
function processTable() {
  const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,@{n='Born';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"],
  {encoding: 'utf8', windowsHide: true, timeout: 12000, maxBuffer: 4 * 1024 * 1024});
  const rows = JSON.parse(text);
  return Array.isArray(rows) ? rows : [rows];
}
function listeners() {
  const text = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'],
    {encoding: 'utf8', windowsHide: true, timeout: 8000});
  return text.split(/\r?\n/).flatMap(line => {
    const parts = line.trim().split(/\s+/);
    if (parts[0] !== 'TCP' || parts[3] !== 'LISTENING') return [];
    const port = Number(parts[1].split(':').at(-1));
    return ports.includes(port) ? [{port, address: parts[1], pid: Number(parts[4])}] : [];
  });
}
const sameProcess = (a, b) => a && b && a.ProcessId === b.ProcessId && a.Born === b.Born && a.Name === b.Name;
function collectTree(record, table) {
  const rootProcess = table.find(p => p.ProcessId === record.child.pid);
  if (!record.identity && !record.done && rootProcess) record.identity = rootProcess;
  if (sameProcess(record.identity, rootProcess)) record.owned.set(rootProcess.ProcessId, rootProcess);
  let changed;
  do {
    changed = false;
    for (const proc of table) {
      const parent = record.owned.get(proc.ParentProcessId);
      const liveParent = table.find(p => p.ProcessId === proc.ParentProcessId);
      if (!record.owned.has(proc.ProcessId) && parent && sameProcess(parent, liveParent) && proc.Born >= parent.Born) {
        record.owned.set(proc.ProcessId, proc); changed = true;
      }
    }
  } while (changed);
}

export async function runRestartSmoke(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    console.log('node scripts/test_coordinator_restart.mjs [--fail-after-watch]\nWindows-only; fixed loopback ports 8797/9239; fresh scratch persistence; 300s deadline + bounded cleanup.\n--fail-after-watch intentionally fails to verify nonzero exit and owned-tree cleanup.');
    return;
  }
  assert.ok(argv.every(arg => arg === '--fail-after-watch'), 'unknown argument');
  assert.equal(process.platform, 'win32', 'this harness uses Windows PID identity and tree cleanup');
  const out = native(fs.mkdtempSync(`${scratch}/coordinator-restart-`));
  const persistence = `${out}/state`;
  const envFile = `${out}/offline.env`;
  const resultPath = `${out}/result.json`;
  fs.writeFileSync(envFile, 'APP_ENV=development\nINGEST_API_KEY=\n');
  const result = {passed: false, test_layer: 'offline_actual_workerd_contract',
    detector_accuracy_verified: false, vlm_inference_verified: false, pi_archive_verified: false,
    remote_services_used: false, out, persistence, result_path: resultPath,
    ports, camera_id: `restart-contract-${Date.now()}`, started_at: new Date().toISOString(),
    checkpoints: [], lifetimes: [], cleanup: [], commands: []};
  const children = [];
  const save = (name, value) => fs.writeFileSync(`${out}/${name}`, JSON.stringify(value, null, 2) + '\n');
  const trace = value => fs.appendFileSync(`${out}/http.jsonl`, JSON.stringify(value) + '\n');
  const deadline = Date.now() + MAX_RUN_MS;
  const guard = () => {assert.ok(Date.now() < deadline, 'overall 300s run deadline exceeded');};
  let interrupted = null;
  const onSignal = signal => {interrupted = signal;};
  const onInt = () => onSignal('SIGINT'), onTerm = () => onSignal('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  const check = () => {guard(); assert.equal(interrupted, null, `interrupted: ${interrupted}`);};
  // Deliberately do not inherit credentials, NODE_OPTIONS or project secret env.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'HOME',
      'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TMP', 'TEMP', 'NUMBER_OF_PROCESSORS',
      'PROCESSOR_ARCHITECTURE'].includes(key.toUpperCase())));
  Object.assign(env, {CI: 'true', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1',
    CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'true',
    WRANGLER_LOG_PATH: `${out}/wrangler-internal.log`});
  function start(args, label) {
    check();
    const logPath = `${out}/${label}.log`;
    const fd = fs.openSync(logPath, 'a');
    const command = [native(process.execPath), wrangler, ...args];
    const child = spawn(process.execPath, [wrangler, ...args],
      {cwd: worker, env, stdio: ['ignore', fd, fd], windowsHide: true});
    fs.closeSync(fd);
    const record = {child, label, logPath, owned: new Map(), identity: null, done: false, error: null};
    child.on('error', error => {record.error = error; record.done = true;});
    child.on('exit', (code, signal) => {record.done = true; record.code = code; record.signal = signal;});
    children.push(record);
    collectTree(record, processTable());
    result.commands.push({label, pid: child.pid, argv: command, log: logPath});
    return record;
  }
  async function stop(record) {
    if (record.cleaned) return;
    const before = processTable();
    collectTree(record, before);
    // First terminate the exact ChildProcess handle, not a name or port owner.
    if (!record.done) record.child.kill();
    await sleep(300);
    // Windows kill() may leave descendants. Only terminate positively identified
    // owned survivors with unchanged PID+creation time; never kill all workerd.
    let table = processTable();
    const survivors = [...record.owned.values()].filter(p => sameProcess(p, table.find(q => q.ProcessId === p.ProcessId)));
    for (const proc of survivors) {
      table = processTable();
      if (!sameProcess(proc, table.find(p => p.ProcessId === proc.ProcessId))) continue;
      // Refresh ancestry before /T, so newly spawned owned descendants are known.
      collectTree(record, table);
      try {
        execFileSync('taskkill.exe', ['/PID', String(proc.ProcessId), '/T', '/F'],
          {encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: 'pipe'});
      } catch (error) {
        const still = processTable().some(p => sameProcess(p, proc));
        if (still) throw new Error(`owned PID ${proc.ProcessId} cleanup failed: ${error.message}`);
      }
    }
    const finalTable = processTable();
    const remaining = [...record.owned.values()].filter(p => finalTable.some(q => sameProcess(p, q)));
    assert.deepEqual(remaining, [], `owned processes remain after ${record.label}`);
    record.cleaned = true;
    result.cleanup.push({label: record.label, root_pid: record.child.pid,
      owned_pids: [...record.owned.keys()], remaining_owned_pids: []});
  }
  const common = ['--config', config, '--env-file', envFile, '--local', '--persist-to', persistence];
  async function command(args, label) {
    const record = start([...args, ...common], label);
    try {
      const until = Math.min(deadline, Date.now() + 60000);
      while (!record.done) {
        check(); assert.ok(Date.now() < until, `${label} exceeded 60s`);
        collectTree(record, processTable());
        await sleep(100);
      }
      if (record.error) throw record.error;
      assert.equal(record.code, 0, `${label} failed; see ${record.logPath}`);
    } finally {await stop(record);}
    return record;
  }
  async function http(route, body) {
    check();
    const response = await fetch(`${origin}${route}`, {method: body === undefined ? 'GET' : 'POST',
      headers: {'content-type': 'application/json'}, redirect: 'manual',
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      signal: AbortSignal.timeout(Math.min(5000, deadline - Date.now()))});
    const text = await response.text();
    let data;
    try {data = JSON.parse(text);} catch {throw new Error(`${route}: invalid JSON HTTP ${response.status}: ${text.slice(0, 200)}`);}
    trace({lifetime: result.lifetimes.length, route, request: body ?? null, status: response.status, response: data});
    assert.notEqual(response.status, 401, 'local auth unexpectedly required; do not guess credentials');
    assert.equal(response.status, 200, `${route}: HTTP ${response.status}: ${text.slice(0, 300)}`);
    return data;
  }
  async function boot() {
    assert.deepEqual(listeners(), [], 'test ports already occupied; refusing to stop an unrelated listener');
    const label = `lifetime-${result.lifetimes.length + 1}`;
    const record = start(['dev', ...common, '--ip', '127.0.0.1', '--port', String(ports[0]),
      '--inspector-ip', '127.0.0.1', '--inspector-port', String(ports[1]),
      '--show-interactive-dev-session=false'], label);
    const lifetime = {label, root_pid: record.child.pid, log: record.logPath};
    result.lifetimes.push(lifetime);
    const until = Math.min(deadline, Date.now() + 45000);
    let lastError;
    while (Date.now() < until) {
      check();
      assert.equal(record.done, false, `${label} exited before ready; see ${record.logPath}`);
      collectTree(record, processTable());
      try {const response = await fetch(`${origin}/health`, {redirect: 'manual', signal: AbortSignal.timeout(1000)});
        const health = await response.json(); if (response.ok && health.ok === true) break;
      } catch (error) {lastError = error.message;}
      await sleep(200);
    }
    check();
    const table = processTable(); collectTree(record, table);
    const listening = listeners();
    assert.ok(listening.some(p => p.port === ports[0]), `startup failed: ${lastError}; ${record.logPath}`);
    assert.ok(listening.some(p => p.port === ports[1]), 'inspector listener missing');
    assert.ok(listening.every(p => record.owned.has(p.pid)), 'listener is not in owned Wrangler tree');
    const workerd = [...record.owned.values()].filter(p => p.Name.toLowerCase() === 'workerd.exe');
    assert.ok(workerd.length > 0, 'actual owned workerd process not observed');
    lifetime.workerd_pids = workerd.map(p => p.ProcessId);
    lifetime.listeners = listening;
    lifetime.owned_processes = [...record.owned.values()];
    assert.equal((await http('/health')).ok, true);
    return record;
  }
  async function restart(record) {
    await stop(record);
    assert.deepEqual(listeners(), [], 'ports remain listening between lifetimes');
    return boot();
  }
  const stateRoute = `/state/camera/${result.camera_id}`;
  async function checkpoint(label, alert, ts, hits, incident) {
    const state = await http(stateRoute);
    assert.equal(state.camera_id, result.camera_id);
    assert.equal(state.durability_status.coordinator, 'sqlite', 'real SQLite storage required');
    assert.equal(state.alert, alert, label);
    assert.equal(state.ts_ms, ts, `${label}: source watermark`);
    if (hits !== undefined) assert.equal(state.hits, hits, `${label}: strong hit count`);
    if (incident !== undefined) assert.equal(state.incident_id, incident, `${label}: incident identity`);
    result.checkpoints.push({label, alert: state.alert, hits: state.hits, watermark: state.ts_ms,
      incident_id: state.incident_id, durability_status: state.durability_status,
      analysis_status: state.analysis_status});
    save(`${label}.json`, state);
    return state;
  }
  const baseTs = Date.now();
  const detections = cls => [{cls, conf: 0.8, bbox_xyxy: [0, 0, 20, 20]}];
  const positive = detections('fire');
  async function feed(ts, dets = positive) {
    return http(`/ingest/camera/${result.camera_id}`, {camera_id: result.camera_id,
      ts_ms: ts, frame_wh: [100, 80], detections: dets});
  }
  async function readEvents(incident) {
    const all = await http('/events');
    assert.ok(Array.isArray(all));
    const rows = all.filter(row => row.camera_id === result.camera_id);
    assert.equal(rows.length, 2, 'exactly confirmation + one rules-only analysis');
    assert.equal(new Set(rows.map(row => row.event_key)).size, rows.length, 'unique event keys');
    assert.deepEqual(rows.map(row => row.event_kind).sort(), ['analysis', 'confirmation']);
    for (const row of rows) {
      assert.equal(row.incident_id, incident); assert.equal(row.ts_ms, baseTs + 4000);
      assert.equal(row.cause, 'unknown'); assert.equal(row.snapshot_key, null);
      const data = JSON.parse(row.analysis_json);
      assert.equal(data.event_kind, row.event_kind);
      assert.equal(row.operator_priority, data.response_priority);
      assert.equal(typeof row.operator_priority, 'string');
      assert.equal(data.cause.accepted_cause, 'unknown');
      assert.equal(data.cause.requires_human_review, true);
      assert.deepEqual(data.evidence_manifest, []);
      if (row.event_kind === 'analysis') {
        assert.equal(data.analysis_status, 'complete');
        assert.equal(data.cause.source, 'rules_only');
        assert.equal(row.event_key, `${incident}:analysis:${data.analysis_job_id}`);
      } else assert.equal(row.event_key, `${incident}:confirmation`);
    }
    return rows;
  }
  try {
    result.initial_listeners = listeners();
    assert.deepEqual(result.initial_listeners, [], 'ports occupied before test; no process will be killed');
    const cfgText = fs.readFileSync(config, 'utf8');
    const cfg = JSON.parse(cfgText.replace(/^\s*\/\/.*$/gm, ''));
    assert.equal(cfg.vars.APP_ENV, 'development');
    assert.equal(cfg.ai, undefined, 'AI binding prohibited in offline test');
    assert.equal(cfg.r2_buckets, undefined, 'R2 prohibited');
    assert.ok(!/"remote"\s*:\s*true/.test(cfgText), 'remote bindings prohibited');
    assert.ok(cfg.migrations.some(m => m.new_sqlite_classes?.includes('CameraDO')));
    const sourceFiles = ['src/index.js', 'src/camera-do.js', 'src/coordinator-state.js',
      'src/coordinator-journal.js', 'src/incident-store.js', 'wrangler.dev.jsonc'];
    const hashes = () => Object.fromEntries(sourceFiles.map(file => [file,
      createHash('sha256').update(fs.readFileSync(`${worker}/${file}`)).digest('hex')]));
    result.source_sha256 = hashes();
    result.wrangler_version = JSON.parse(fs.readFileSync(`${worker}/node_modules/wrangler/package.json`, 'utf8')).version;
    await command(['d1', 'migrations', 'apply', 'DB'], 'migrations');
    const ledgerCommand = await command(['d1', 'execute', 'DB', '--json', '--command',
      'SELECT name FROM d1_migrations ORDER BY id;'], 'migration-ledger');
    const ledger = JSON.parse(fs.readFileSync(ledgerCommand.logPath, 'utf8'));
    result.migrations = ledger[0].results.map(row => row.name);
    assert.deepEqual(result.migrations, ['0001_init.sql', '0002_analysis.sql', '0003_event_keys.sql']);
    // Register only the isolated test camera (also works if schema later gains FK).
    await command(['d1', 'execute', 'DB', '--command',
      `INSERT INTO cameras (camera_id, location, context_json, created_ms) VALUES ('${result.camera_id}', 'offline CONTRACT smoke', '{}', ${baseTs});`], 'register-camera');
    let runtime = await boot();
    const registry = await http('/cameras');
    assert.ok(registry.some(row => row.camera_id === result.camera_id), 'exact local D1 target camera missing');
    assert.equal((await feed(baseTs)).hits, 1);
    assert.equal((await feed(baseTs + 1000)).hits, 2);
    await checkpoint('watch-before-restart', 'watch', baseTs + 1000, 2, null);
    if (argv.includes('--fail-after-watch')) throw new Error('intentional_failure_after_watch');
    runtime = await restart(runtime);
    await checkpoint('watch-restored', 'watch', baseTs + 1000, 2, null);
    for (const ts of [baseTs + 1000, baseTs]) {
      const response = await feed(ts);
      assert.equal(response.hits, 2); assert.deepEqual(response.published, []);
    }
    await checkpoint('retries-did-not-count', 'watch', baseTs + 1000, 2, null);
    for (let i = 2; i <= 4; i++) {
      const response = await feed(baseTs + i * 1000);
      assert.equal(response.hits, i + 1);
      assert.equal(response.alert, i === 4 ? 'confirmed' : 'watch');
      if (i === 4) assert.ok(response.published.includes('fire_confirmed'));
    }
    const until = Math.min(deadline, Date.now() + 20000);
    let settled;
    do {
      settled = await http(stateRoute);
      const flags = settled.analysis_status;
      if (flags && ['active', 'queued', 'pending_followup', 'native_inference_pending'].every(k => flags[k] === false) &&
          settled.durability_status.pending_events === 0 && settled.cause?.source === 'rules_only') break;
      assert.ok(Date.now() < until, 'analysis/outbox did not settle within 20s');
      await sleep(200);
    } while (true);
    assert.equal(settled.durability_status.analysis_interrupted, false);
    const incident = settled.incident_id;
    assert.equal(typeof incident, 'string'); result.incident_id = incident;
    await checkpoint('confirmed-settled', 'confirmed', baseTs + 4000, 5, incident);
    const events = await readEvents(incident);
    save('events-before-restart.json', events);
    result.events = events.map(({event_key, event_kind, incident_id, cause, snapshot_key}) =>
      ({event_key, event_kind, incident_id, cause, snapshot_key}));
    runtime = await restart(runtime);
    await checkpoint('confirmed-restored', 'confirmed', baseTs + 4000, 5, incident);
    assert.deepEqual(await readEvents(incident), events, 'events unchanged after restart');
    assert.equal((await feed(baseTs + 5000, detections('smoke'))).alert, 'confirmed');
    for (let i = 6; i <= 12; i++) assert.equal((await feed(baseTs + i * 1000, [])).alert, 'confirmed');
    await checkpoint('smoke-seven-empty', 'confirmed', baseTs + 12000, undefined, incident);
    runtime = await restart(runtime);
    await checkpoint('seven-empty-restored', 'confirmed', baseTs + 12000, undefined, incident);
    const cleared = await feed(baseTs + 13000, []);
    assert.equal(cleared.alert, 'idle'); assert.ok(cleared.published.includes('fire_cleared'));
    await checkpoint('idle-before-restart', 'idle', baseTs + 13000, 0, null);
    runtime = await restart(runtime);
    await checkpoint('idle-restored', 'idle', baseTs + 13000, 0, null);
    for (const ts of [baseTs, baseTs + 4000, baseTs + 13000]) {
      const replay = await feed(ts);
      assert.equal(replay.alert, 'idle'); assert.equal(replay.hits, 0); assert.deepEqual(replay.published, []);
    }
    await checkpoint('old-positive-cannot-rearm', 'idle', baseTs + 13000, 0, null);
    const finalEvents = await readEvents(incident);
    assert.deepEqual(finalEvents, events, 'no duplicate records through all restarts/retries');
    save('events-final.json', finalEvents);
    result.source_sha256_after = hashes();
    assert.deepEqual(result.source_sha256_after, result.source_sha256, 'Worker source changed during smoke run');
    result.passed = true;
  } catch (error) {
    result.error = {name: error.name, message: error.message, stack: error.stack};
    process.exitCode = 1;
  } finally {
    const cleanupErrors = [];
    for (const record of [...children].reverse()) {
      try {await stop(record);} catch (error) {cleanupErrors.push(error.message);}
    }
    try {
      result.final_listeners = listeners();
      // If initial ports were occupied, preserve them and report refusal, not cleanup success.
      if (result.initial_listeners?.length === 0) assert.deepEqual(result.final_listeners, [], 'test ports still listening');
    } catch (error) {cleanupErrors.push(error.message);}
    result.cleanup_verified = cleanupErrors.length === 0 && result.initial_listeners?.length === 0 && result.final_listeners?.length === 0;
    result.cleanup_errors = cleanupErrors;
    if (!result.cleanup_verified) {result.passed = false; process.exitCode = 1;}
    result.finished_at = new Date().toISOString();
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
    save('audit.json', result);
    const summary = {passed: result.passed, test_layer: result.test_layer,
      camera_id: result.camera_id, incident_id: result.incident_id ?? null,
      detector_accuracy_verified: false, vlm_inference_verified: false,
      pi_archive_verified: false, remote_services_used: false,
      migrations: result.migrations ?? [],
      lifetimes: result.lifetimes.length, checkpoints: result.checkpoints.map(
        ({label, alert, hits, watermark}) => ({label, alert, hits, watermark})),
      events: result.events ?? [], cleanup_verified: result.cleanup_verified,
      final_listeners: result.final_listeners ?? null, cleanup_errors: cleanupErrors,
      ...(result.error ? {error: result.error.message} : {}),
      out, result_path: resultPath, audit_path: `${out}/audit.json`,
      started_at: result.started_at, finished_at: result.finished_at};
    save('result.json', summary);
    console.log('RESTART_SMOKE_RESULT', JSON.stringify(summary));
    console.log('RESULT_PATH', resultPath);
  }
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runRestartSmoke();
