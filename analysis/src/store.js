import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,existsSync,writeFileSync,readdirSync,statSync } from 'node:fs';
import { dirname,join } from 'node:path';

export class Store {
  constructor(path) {
    if(path!==':memory:') mkdirSync(dirname(path),{recursive:true});
    this.evidenceDir=path===':memory:'?null:join(dirname(path),'evidence');
    this.evidenceBytes=0;
    if(this.evidenceDir && existsSync(this.evidenceDir)) {
      for(const entry of readdirSync(this.evidenceDir,{recursive:true,withFileTypes:true}))
        if(entry.isFile())this.evidenceBytes+=statSync(join(entry.parentPath,entry.name)).size;
    }
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,camera TEXT,mode TEXT,status TEXT,updated INTEGER,result TEXT);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT,ts INTEGER,body TEXT);
      CREATE INDEX IF NOT EXISTS event_session ON events(session,id);
      CREATE TABLE IF NOT EXISTS inferences(id INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT,ts INTEGER,body TEXT);
      CREATE TABLE IF NOT EXISTS alert_reviews(id INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT,ts INTEGER,body TEXT);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,status TEXT,body TEXT);`);
    this.db.prepare("UPDATE jobs SET status='interrupted' WHERE status IN ('queued','running')").run();
    this.db.prepare("UPDATE sessions SET status='interrupted' WHERE status='active'").run();
  }
  start(id,camera,mode) {this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(id,camera,mode,'active',Date.now(),null);}
  save(id,result,status='active') {
    const body=JSON.stringify(result);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE sessions SET result=?,updated=?,status=? WHERE id=?').run(body,Date.now(),status,id);
      this.db.prepare('INSERT INTO events(session,ts,body) VALUES(?,?,?)').run(id,Date.now(),body);
      this.db.exec('COMMIT');
    } catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  previous(camera) {
    const row=this.db.prepare("SELECT result FROM sessions WHERE camera=? AND mode='live' AND result IS NOT NULL ORDER BY updated DESC LIMIT 1").get(camera);
    return row?.result?JSON.parse(row.result):null;
  }
  inference(id,value) {this.db.prepare('INSERT INTO inferences(session,ts,body) VALUES(?,?,?)').run(id,Date.now(),JSON.stringify(value));}
  archive(id,frames) {
    if(!this.evidenceDir)return {retained:false,reason:'memory_store'};
    if(!/^[A-Za-z0-9_-]{1,80}$/.test(id))throw new Error('invalid_evidence_session');
    const folder=join(this.evidenceDir,id);mkdirSync(folder,{recursive:true});
    const retained=[];
    try {
      for(const frame of frames) {
        if(!Number.isSafeInteger(frame.ts_ms)||frame.ts_ms<0)throw new Error('invalid_evidence_timestamp');
        const path=join(folder,`frame-${frame.ts_ms}.jpg`);const bytes=Buffer.from(frame.image_b64,'base64');
        if(!existsSync(path)) {
          if(this.evidenceBytes+bytes.length>256*1024*1024)return {retained:false,reason:'evidence_storage_limit',frame_ids:retained};
          writeFileSync(path,bytes,{flag:'wx'});this.evidenceBytes+=bytes.length;
        }
        retained.push(frame.frame_id);
      }
      return {retained:true,frame_ids:retained};
    }catch{return {retained:false,reason:'evidence_storage_failed',frame_ids:retained};}
  }
  inferences(id) {return this.db.prepare('SELECT body FROM inferences WHERE session=? ORDER BY id').all(id).map(row=>JSON.parse(row.body));}
  review(id,value) {this.db.prepare('INSERT INTO alert_reviews(session,ts,body) VALUES(?,?,?)').run(id,Date.now(),JSON.stringify(value));}
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
