import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,existsSync,writeFileSync,readdirSync,statSync,renameSync,rmSync,rmdirSync } from 'node:fs';
import { dirname,join,relative } from 'node:path';

export const EVENT_HEARTBEAT_MS=30000,EVENT_RETENTION_MS=7*24*60*60*1000,EVIDENCE_LIMIT_BYTES=256*1024*1024,VACUUM_FREELIST_BYTES=64*1024*1024;
// Live sessions publish on every frame, native result and 1 Hz tick; only changes and heartbeats become events.
// 'gap' is included because a degraded (dark or moving) view re-publishes a gap on every frame.
const FREQUENT=new Set(['frame','tick','native_result','native_state','gap']);
const signatureOf=r=>JSON.stringify([r?.priority?.level,r?.priority?.reason,r?.detection?.state,r?.detection?.fire,r?.detection?.smoke,
  r?.incident_id,r?.incident_history?.model_hazard,r?.incident_history?.clear_evidence_current,r?.view?.status,r?.view?.reason,r?.native_stream?.state]);
// Evidence of a session that latched a hazard or was reviewed by an operator. A review clears model_hazard but leaves an
// alert_reviews row, so reviewed evidence stays protected. last_review is not used: new sessions copy it forward.
const PROTECTED=`SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND (json_extract(result,'$.incident_history.model_hazard')
  OR json_extract(result,'$.incident_history.latest_hazard') IS NOT NULL))
  OR EXISTS(SELECT 1 FROM alert_reviews WHERE session=?1) AS protected`;
const RENAME_RETRY=new Int32Array(new SharedArrayBuffer(4));
// Windows briefly refuses a rename while a virus scanner or indexer holds the new file; retry three times, 20 ms apart.
function renameRetry(from,to) {
  for(let attempt=0;;attempt++) try{return renameSync(from,to);}catch(e){
    if(process.platform!=='win32'||attempt>=3||!['EPERM','EBUSY','EACCES'].includes(e.code))throw e;
    Atomics.wait(RENAME_RETRY,0,0,20);
  }
}

export class Store {
  constructor(path,{now=Date.now,evidenceLimit=EVIDENCE_LIMIT_BYTES,vacuumThreshold=VACUUM_FREELIST_BYTES}={}) {
    if(path!==':memory:') mkdirSync(dirname(path),{recursive:true});
    this.now=now;this.evidenceLimit=evidenceLimit;this.lastEvents=new Map();
    this.evidenceDir=path===':memory:'?null:join(dirname(path),'evidence');
    // Oldest-written first (Map insertion order) so eviction never rescans the disk.
    this.evidence=new Map();this.evidenceBytes=0;
    if(this.evidenceDir && existsSync(this.evidenceDir)) {
      const files=[];
      for(const entry of readdirSync(this.evidenceDir,{recursive:true,withFileTypes:true})) if(entry.isFile()) {
        const file=join(entry.parentPath,entry.name);
        if(entry.name.endsWith('.tmp')){rmSync(file,{force:true});continue;} // interrupted atomic write
        const stat=statSync(file);
        files.push({file,folder:relative(this.evidenceDir,entry.parentPath),size:stat.size,mtime:stat.mtimeMs,
          ts:Number(/^frame-(\d+)\.jpg$/.exec(entry.name)?.[1]??0)});
      }
      for(const {file,folder,size} of files.sort((a,b)=>a.mtime-b.mtime||a.ts-b.ts)){this.evidence.set(file,{folder,size});this.evidenceBytes+=size;}
    }
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,camera TEXT,mode TEXT,status TEXT,updated INTEGER,result TEXT);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT,ts INTEGER,body TEXT);
      CREATE INDEX IF NOT EXISTS event_session ON events(session,id);
      CREATE INDEX IF NOT EXISTS event_ts ON events(ts);
      CREATE TABLE IF NOT EXISTS inferences(id INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT,ts INTEGER,body TEXT);
      CREATE INDEX IF NOT EXISTS inference_ts ON inferences(ts);
      CREATE TABLE IF NOT EXISTS alert_reviews(id INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT,ts INTEGER,body TEXT);
      CREATE INDEX IF NOT EXISTS review_session ON alert_reviews(session);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,status TEXT,body TEXT);`);
    this.db.prepare("UPDATE jobs SET status='interrupted' WHERE status IN ('queued','running')").run();
    this.db.prepare("UPDATE sessions SET status='interrupted' WHERE status='active'").run();
    const pragma=name=>Object.values(this.db.prepare(`PRAGMA ${name}`).get())[0];
    this.incremental=pragma('auto_vacuum')===2;this.prune();
    // Free pages are never returned to the OS without auto-vacuum, and every snapshot copies them. Once a backlog prune
    // leaves more than the threshold free, rewrite the file once (cost ~ live data, startup only) with incremental
    // auto-vacuum; prune() then returns pages as it frees them. A failed rewrite is retried on the next start.
    if(!this.incremental&&pragma('freelist_count')*pragma('page_size')>vacuumThreshold) {
      try{this.db.exec('PRAGMA auto_vacuum=INCREMENTAL;VACUUM;PRAGMA wal_checkpoint(TRUNCATE);');}
      catch(e){console.error('Store vacuum skipped:',e.message);}
      this.incremental=pragma('auto_vacuum')===2;
    }
  }
  start(id,camera,mode) {this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(id,camera,mode,'active',this.now(),null);}
  // The sessions row always holds the latest result. Recorded timelines stay complete; live history keeps
  // terminal states, non-periodic triggers, significant changes and a heartbeat.
  save(id,result,status='active',trigger) {
    const body=JSON.stringify(result),now=this.now(),signature=signatureOf(result),last=this.lastEvents.get(id);
    const insert=result?.mode==='recorded'||status!=='active'||!FREQUENT.has(trigger)||last?.signature!==signature||now-last.at>EVENT_HEARTBEAT_MS;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE sessions SET result=?,updated=?,status=? WHERE id=?').run(body,now,status,id);
      if(insert)this.db.prepare('INSERT INTO events(session,ts,body) VALUES(?,?,?)').run(id,now,body);
      this.db.exec('COMMIT');
    } catch(e){this.db.exec('ROLLBACK');throw e;}
    if(insert&&status==='active')this.lastEvents.set(id,{signature,at:now});else if(insert)this.lastEvents.delete(id);
  }
  // Live history is diagnostic; recorded timelines, sessions, alert reviews and jobs are kept. INDEXED BY: left to itself
  // the planner walks event_session through every live row (an 834 ms stall at 1M events) to find the old ones.
  prune({now=this.now(),maxAgeMs=EVENT_RETENTION_MS}={}) {
    const live="ts<? AND session IN (SELECT id FROM sessions WHERE mode='live')",before=now-maxAgeMs;
    const removed={events:Number(this.db.prepare(`DELETE FROM events INDEXED BY event_ts WHERE ${live}`).run(before).changes),
      inferences:Number(this.db.prepare(`DELETE FROM inferences INDEXED BY inference_ts WHERE ${live}`).run(before).changes)};
    if(this.incremental)this.db.exec('PRAGMA incremental_vacuum');
    return removed;
  }
  previous(camera) {
    const row=this.db.prepare("SELECT result FROM sessions WHERE camera=? AND mode='live' AND result IS NOT NULL ORDER BY updated DESC LIMIT 1").get(camera);
    return row?.result?JSON.parse(row.result):null;
  }
  inference(id,value) {this.db.prepare('INSERT INTO inferences(session,ts,body) VALUES(?,?,?)').run(id,this.now(),JSON.stringify(value));}
  // Frees space oldest-first: first frames of unprotected sessions (the writer's own included), then, only when the writer
  // is itself protected, other sessions' protected frames. A routine writer never evicts hazard or reviewed evidence, and
  // files named in the current archive call are never evicted. Deleting starts only under a plan that frees enough; a file
  // that cannot be deleted is skipped and the plan remade without it, so a failure can leave earlier deletions in place
  // when no other plan suffices. Returns whether the new bytes now fit.
  reclaim(id,needed,keep,protect=false) {
    if(this.evidenceBytes+needed<=this.evidenceLimit)return true;
    if(needed>this.evidenceLimit)return false;
    const status=new Map(),skip=new Set(keep),folders=new Set(),lookup=this.db.prepare(PROTECTED);
    const guarded=folder=>{if(!status.has(folder))status.set(folder,Boolean(lookup.get(folder).protected));return status.get(folder);};
    const passes=[folder=>!guarded(folder),...(protect||guarded(id)?[folder=>folder!==id]:[])];
    for(let over;(over=this.evidenceBytes+needed-this.evidenceLimit)>0;) {
      const victims=new Map();let freed=0;
      for(const evictable of passes)
        for(const [file,entry] of this.evidence) {
          if(freed>=over)break;
          if(!skip.has(file)&&!victims.has(file)&&evictable(entry.folder)){victims.set(file,entry);freed+=entry.size;}
        }
      if(freed<over)break;
      for(const [file,entry] of victims) {
        try{rmSync(file,{force:true});}catch{skip.add(file);break;}
        this.evidence.delete(file);this.evidenceBytes-=entry.size;folders.add(entry.folder);
      }
    }
    for(const folder of folders) if(folder!==id&&folder)try{rmdirSync(join(this.evidenceDir,folder));}catch{} // only when empty
    return this.evidenceBytes+needed<=this.evidenceLimit;
  }
  // protect: the writer has just latched a hazard that its stored result does not show yet.
  archive(id,frames,{protect=false}={}) {
    if(!this.evidenceDir)return {retained:false,reason:'memory_store'};
    if(!/^[A-Za-z0-9_-]{1,80}$/.test(id))throw new Error('invalid_evidence_session');
    const folder=join(this.evidenceDir,id);mkdirSync(folder,{recursive:true});
    const retained=[],keep=new Set();
    try {
      for(const frame of frames) {
        if(!Number.isSafeInteger(frame.ts_ms)||frame.ts_ms<0)throw new Error('invalid_evidence_timestamp');
        const path=join(folder,`frame-${frame.ts_ms}.jpg`);const bytes=Buffer.from(frame.image_b64,'base64');keep.add(path);
        if(!existsSync(path)) {
          if(!this.reclaim(id,bytes.length,keep,protect))return {retained:false,reason:'evidence_storage_limit',frame_ids:retained};
          // Write-then-rename so a concurrent snapshot copies either nothing or the complete JPEG.
          const temporary=`${path}.tmp`;
          try{writeFileSync(temporary,bytes);renameRetry(temporary,path);}catch(e){rmSync(temporary,{force:true});throw e;}
          this.evidence.set(path,{folder:id,size:bytes.length});this.evidenceBytes+=bytes.length;
        }
        retained.push(frame.frame_id);
      }
      return {retained:true,frame_ids:retained};
    }catch{return {retained:false,reason:'evidence_storage_failed',frame_ids:retained};}
  }
  inferences(id) {return this.db.prepare('SELECT body FROM inferences WHERE session=? ORDER BY id').all(id).map(row=>JSON.parse(row.body));}
  review(id,value) {this.db.prepare('INSERT INTO alert_reviews(session,ts,body) VALUES(?,?,?)').run(id,this.now(),JSON.stringify(value));}
  reviews(id) {return this.db.prepare('SELECT body FROM alert_reviews WHERE session=? ORDER BY id').all(id).map(row=>JSON.parse(row.body));}
  timeline(id,{after=0,limit=500}={}) {return this.db.prepare('SELECT id,body FROM events WHERE session=? AND id>? ORDER BY id LIMIT ?')
    .all(id,after,limit).map(row=>({event_id:row.id,...JSON.parse(row.body)}));}
  job(id,patch) {
    if(patch) {
      const value={...this.job(id),...patch,id};
      this.db.prepare('INSERT INTO jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body')
        .run(id,value.status,JSON.stringify(value));return value;
    }
    const row=this.db.prepare('SELECT status,body FROM jobs WHERE id=?').get(id);
    return row?{...JSON.parse(row.body),status:row.status}:null;
  }
  close(){this.db.close();}
}
