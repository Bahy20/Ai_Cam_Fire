"""Bounded SQLite spool for ordered, metadata-only V2 camera observations."""
import json
import math
from contextlib import closing
from pathlib import Path
import sqlite3
import stat
import uuid


class ObservationSpoolError(RuntimeError):
    """Sanitized local spool failure."""


class ObservationSpoolFull(ObservationSpoolError):
    """The configured pending sample or byte limit was reached."""


class ObservationSpool:
    def __init__(self, path, *, camera_id=None, max_samples=10_000, max_bytes=16*1024*1024):
        if type(max_samples) is not int or max_samples < 1 or type(max_bytes) is not int or max_bytes < 1024:
            raise ValueError('invalid_observation_spool_limits')
        if camera_id is not None and (not isinstance(camera_id, str) or not camera_id):
            raise ValueError('invalid_observation_spool_camera')
        self.path=Path(path)
        self.camera_id=camera_id
        self.max_samples,self.max_bytes=max_samples,max_bytes
        self.path.parent.mkdir(parents=True,exist_ok=True)
        self._assert_safe()
        try:
            with closing(self._connect()) as db:
                db.executescript('''
                    CREATE TABLE IF NOT EXISTS spool_meta (
                        key TEXT PRIMARY KEY, value TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS spool_samples (
                        attempt_sequence INTEGER NOT NULL,
                        session_id TEXT NOT NULL,
                        source_ts_ms REAL NOT NULL,
                        sample_json TEXT NOT NULL,
                        status TEXT NOT NULL CHECK(status IN ('pending','batched','acked','historical')),
                        batch_sequence INTEGER,
                        disposition TEXT,
                        created_order INTEGER NOT NULL,
                        PRIMARY KEY(session_id,attempt_sequence)
                    );
                    CREATE INDEX IF NOT EXISTS spool_samples_live ON spool_samples(session_id,status,attempt_sequence);
                    CREATE TABLE IF NOT EXISTS spool_batches (
                        batch_sequence INTEGER NOT NULL,
                        session_id TEXT NOT NULL,
                        generation INTEGER NOT NULL,
                        payload_hash TEXT NOT NULL,
                        body_json TEXT NOT NULL,
                        status TEXT NOT NULL CHECK(status IN ('pending','acked','historical')),
                        acknowledgement_json TEXT,
                        PRIMARY KEY(session_id,batch_sequence)
                    );
                ''')
                db.execute('PRAGMA journal_mode=DELETE')
                db.execute('PRAGMA synchronous=FULL')
        except Exception:
            raise ObservationSpoolError('metadata_spool_unavailable') from None

    def _assert_safe(self):
        for part in (self.path.absolute(),*self.path.absolute().parents):
            try: mode=part.lstat().st_mode
            except FileNotFoundError: continue
            if stat.S_ISLNK(mode) or getattr(part.lstat(),'st_file_attributes',0) & 0x400:
                raise ObservationSpoolError('metadata_spool_unsafe_path')
        if self.path.exists() and not self.path.is_file():
            raise ObservationSpoolError('metadata_spool_unsafe_path')

    def _connect(self):
        self._assert_safe()
        db=sqlite3.connect(self.path,timeout=5.,isolation_level=None)
        db.row_factory=sqlite3.Row
        db.execute('PRAGMA busy_timeout=5000')
        db.execute('PRAGMA synchronous=FULL')
        return db

    @staticmethod
    def _read_meta(db,key,default=None):
        row=db.execute('SELECT value FROM spool_meta WHERE key=?',(key,)).fetchone()
        return default if row is None else row['value']

    @staticmethod
    def _write_meta(db,key,value):
        db.execute('INSERT INTO spool_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            (key,str(value)))

    def start_session(self,session_id,generation):
        try: canonical=str(uuid.UUID(session_id))
        except (ValueError,TypeError,AttributeError): raise ObservationSpoolError('metadata_spool_invalid_session') from None
        if canonical!=session_id.lower() or type(generation) is not int or generation<1:
            raise ObservationSpoolError('metadata_spool_invalid_session')
        try:
            with closing(self._connect()) as db:
                db.execute('BEGIN IMMEDIATE')
                previous_id=self._read_meta(db,'active_session_id')
                previous_generation=int(self._read_meta(db,'active_generation','0'))
                if previous_id==session_id:
                    if previous_generation!=generation: raise ObservationSpoolError('metadata_spool_session_conflict')
                    db.execute('COMMIT');return
                if generation<=previous_generation: raise ObservationSpoolError('metadata_spool_generation_reversed')
                db.execute("UPDATE spool_samples SET status='historical',batch_sequence=NULL WHERE status IN ('pending','batched')")
                db.execute("UPDATE spool_batches SET status='historical' WHERE status='pending'")
                self._write_meta(db,'active_session_id',session_id)
                self._write_meta(db,'active_generation',generation)
                self._write_meta(db,'next_attempt_sequence',0)
                self._write_meta(db,'next_batch_sequence',0)
                self._write_meta(db,'acknowledged_through',0)
                db.execute("DELETE FROM spool_meta WHERE key='queue_overflow_pending_ts'")
                self._trim_history(db)
                db.execute('COMMIT')
        except ObservationSpoolError: raise
        except Exception: raise ObservationSpoolError('metadata_spool_unavailable') from None

    def enqueue(self,sample):
        required={'ts_ms','status','frame_wh','detections','jpeg_sha256','local_image_available','visibility',
            'camera_motion','quality','reason'}
        if not isinstance(sample,dict) or not required.issubset(sample) or set(sample)-required not in (set(), {'handheld_candidate'}):
            raise ObservationSpoolError('metadata_spool_invalid_sample')
        candidate=sample.get('handheld_candidate')
        if candidate is not None and (sample.get('status')!='ok' or self.camera_id is None):
            raise ObservationSpoolError('metadata_spool_invalid_sample')
        try:
            source_ts=sample['ts_ms']
            if type(source_ts) not in (int,float) or not math.isfinite(source_ts) or source_ts<0:
                raise ValueError
            if 'handheld_candidate' in sample and candidate is not None and not isinstance(candidate,dict):
                raise ValueError
            encoded=json.dumps(sample,separators=(',',':'),ensure_ascii=False,allow_nan=False)
        except (TypeError,ValueError,OverflowError): raise ObservationSpoolError('metadata_spool_invalid_sample') from None
        size=len(encoded.encode('utf-8'))
        try:
            with closing(self._connect()) as db:
                db.execute('BEGIN IMMEDIATE')
                session_id=self._read_meta(db,'active_session_id')
                if session_id is None: raise ObservationSpoolError('metadata_spool_session_missing')
                if candidate is not None:
                    generation=int(self._read_meta(db,'active_generation','0'))
                    try:
                        from .handheld_scene import validate_candidate_wire
                    except ImportError:
                        from handheld_scene import validate_candidate_wire
                    if not validate_candidate_wire(candidate,camera_id=self.camera_id,session_id=session_id,
                            generation=generation,ts_ms=source_ts):
                        raise ObservationSpoolError('metadata_spool_invalid_sample')
                pending=db.execute("SELECT COUNT(*) AS n,COALESCE(SUM(length(CAST(sample_json AS BLOB))),0) AS bytes FROM spool_samples WHERE session_id=? AND status IN ('pending','batched')",(session_id,)).fetchone()
                if pending['n']>=self.max_samples or pending['bytes']+size>self.max_bytes:
                    if self._read_meta(db,'queue_overflow_pending_ts') is None:
                        self._write_meta(db,'queue_overflow_pending_ts',source_ts)
                    db.execute('COMMIT');raise ObservationSpoolFull('metadata_spool_full')
                seq=int(self._read_meta(db,'next_attempt_sequence','0'))+1
                sample_json=json.dumps({'attempt_sequence':seq,**sample},separators=(',',':'),ensure_ascii=False,allow_nan=False)
                encoded_size=len(sample_json.encode('utf-8'))
                if pending['n']>=self.max_samples or pending['bytes']+encoded_size>self.max_bytes:
                    if self._read_meta(db,'queue_overflow_pending_ts') is None:
                        self._write_meta(db,'queue_overflow_pending_ts',source_ts)
                    db.execute('COMMIT');raise ObservationSpoolFull('metadata_spool_full')
                db.execute("INSERT INTO spool_samples(attempt_sequence,session_id,source_ts_ms,sample_json,status,batch_sequence,disposition,created_order) VALUES(?,?,?,?, 'pending',NULL,NULL,?)",
                    (seq,session_id,source_ts,sample_json,seq))
                self._write_meta(db,'next_attempt_sequence',seq)
                db.execute('COMMIT')
                return seq
        except ObservationSpoolError: raise
        except Exception: raise ObservationSpoolError('metadata_spool_unavailable') from None

    def seal_batch(self,clock_mode,hash_function,*,max_samples=6,force=False):
        if clock_mode not in ('live','replay') or type(max_samples) is not int or not 1<=max_samples<=12:
            raise ObservationSpoolError('metadata_spool_invalid_batch')
        try:
            with closing(self._connect()) as db:
                db.execute('BEGIN IMMEDIATE')
                session_id=self._read_meta(db,'active_session_id')
                generation=int(self._read_meta(db,'active_generation','0'))
                if session_id is None: raise ObservationSpoolError('metadata_spool_session_missing')
                existing=db.execute("SELECT body_json FROM spool_batches WHERE session_id=? AND status='pending' ORDER BY batch_sequence LIMIT 1",(session_id,)).fetchone()
                if existing:
                    db.execute('COMMIT');return json.loads(existing['body_json'])
                rows=db.execute("SELECT attempt_sequence,sample_json FROM spool_samples WHERE session_id=? AND status='pending' ORDER BY attempt_sequence LIMIT ?",(session_id,max_samples)).fetchall()
                if not rows or (len(rows)<max_samples and not force):
                    db.execute('COMMIT');return None
                for index,row in enumerate(rows):
                    if index and row['attempt_sequence']!=rows[index-1]['attempt_sequence']+1:
                        raise ObservationSpoolError('metadata_spool_sequence_gap')
                batch_sequence=int(self._read_meta(db,'next_batch_sequence','0'))+1
                body={'protocol_version':2,'session_id':session_id,'generation':generation,
                    'batch_sequence':batch_sequence,'clock_mode':clock_mode,
                    'payload_hash':'0'*64,'samples':[json.loads(row['sample_json']) for row in rows]}
                body['payload_hash']=hash_function(body)
                body_json=json.dumps(body,separators=(',',':'),ensure_ascii=False,allow_nan=False)
                if len(body_json.encode('utf-8'))>512*1024:
                    raise ObservationSpoolError('metadata_batch_too_large')
                db.execute("INSERT INTO spool_batches(batch_sequence,session_id,generation,payload_hash,body_json,status) VALUES(?,?,?,?,?,'pending')",
                    (batch_sequence,session_id,generation,body['payload_hash'],body_json))
                db.executemany("UPDATE spool_samples SET status='batched',batch_sequence=? WHERE session_id=? AND attempt_sequence=?",
                    [(batch_sequence,session_id,row['attempt_sequence']) for row in rows])
                self._write_meta(db,'next_batch_sequence',batch_sequence)
                db.execute('COMMIT')
                return body
        except ObservationSpoolError: raise
        except Exception: raise ObservationSpoolError('metadata_spool_unavailable') from None

    def acknowledge(self,ack):
        if not isinstance(ack,dict): raise ObservationSpoolError('metadata_spool_invalid_ack')
        try:
            with closing(self._connect()) as db:
                db.execute('BEGIN IMMEDIATE')
                batch=db.execute("SELECT * FROM spool_batches WHERE session_id=? AND batch_sequence=? AND status='pending'",
                    (ack.get('session_id'),ack.get('batch_sequence'))).fetchone()
                if batch is None:
                    previous=db.execute("SELECT acknowledgement_json FROM spool_batches WHERE session_id=? AND batch_sequence=? AND status='acked'",
                        (ack.get('session_id'),ack.get('batch_sequence'))).fetchone()
                    if previous and json.loads(previous['acknowledgement_json'])['payload_hash']==ack.get('payload_hash'):
                        db.execute('COMMIT');return False
                    raise ObservationSpoolError('metadata_spool_ack_unknown')
                body=json.loads(batch['body_json'])
                attempts=[sample['attempt_sequence'] for sample in body['samples']]
                if (ack.get('session_id')!=batch['session_id'] or ack.get('generation')!=batch['generation'] or
                        ack.get('payload_hash')!=batch['payload_hash'] or ack.get('accepted_through')!=attempts[-1] or
                        not isinstance(ack.get('dispositions'),list) or len(ack['dispositions'])!=len(attempts) or
                        [item.get('attempt_sequence') for item in ack['dispositions']]!=attempts or
                        any(item.get('status') not in ('accepted','gap','skipped_stale') for item in ack['dispositions'])):
                    raise ObservationSpoolError('metadata_spool_ack_mismatch')
                for item in ack['dispositions']:
                    db.execute("UPDATE spool_samples SET status='acked',disposition=? WHERE session_id=? AND attempt_sequence=? AND batch_sequence=?",
                        (item['status'],batch['session_id'],item['attempt_sequence'],batch['batch_sequence']))
                db.execute("UPDATE spool_batches SET status='acked',acknowledgement_json=? WHERE session_id=? AND batch_sequence=?",
                    (json.dumps(ack,separators=(',',':'),ensure_ascii=False,allow_nan=False),batch['session_id'],batch['batch_sequence']))
                self._write_meta(db,'acknowledged_through',attempts[-1])
                self._materialize_overflow_gap(db,batch['session_id'])
                self._trim_acked(db)
                db.execute('COMMIT')
                return True
        except ObservationSpoolError: raise
        except Exception: raise ObservationSpoolError('metadata_spool_unavailable') from None

    def _trim_acked(self,db):
        db.execute("DELETE FROM spool_samples WHERE status='acked' AND rowid NOT IN (SELECT rowid FROM spool_samples WHERE status='acked' ORDER BY rowid DESC LIMIT 64)")
        db.execute("DELETE FROM spool_batches WHERE status='acked' AND rowid NOT IN (SELECT rowid FROM spool_batches WHERE status='acked' ORDER BY rowid DESC LIMIT 64)")

    def _materialize_overflow_gap(self,db,session_id):
        pending_ts=self._read_meta(db,'queue_overflow_pending_ts')
        if pending_ts is None or self._read_meta(db,'active_session_id')!=session_id:
            return False
        pending=db.execute("SELECT COUNT(*) AS n,COALESCE(SUM(length(CAST(sample_json AS BLOB))),0) AS bytes FROM spool_samples WHERE session_id=? AND status IN ('pending','batched')",(session_id,)).fetchone()
        if pending['n']>=self.max_samples:
            return False
        seq=int(self._read_meta(db,'next_attempt_sequence','0'))+1
        sample={'attempt_sequence':seq,'ts_ms':float(pending_ts),'status':'gap','frame_wh':None,
            'detections':None,'jpeg_sha256':None,'local_image_available':False,'visibility':'unknown',
            'camera_motion':None,'quality':{'stability':'unknown','blur_score':None,'occlusion':'unknown'},
            'reason':'queue_overflow'}
        encoded=json.dumps(sample,separators=(',',':'),ensure_ascii=False,allow_nan=False)
        if pending['bytes']+len(encoded.encode('utf-8'))>self.max_bytes:
            return False
        db.execute("INSERT INTO spool_samples(attempt_sequence,session_id,source_ts_ms,sample_json,status,batch_sequence,disposition,created_order) VALUES(?,?,?,?, 'pending',NULL,NULL,?)",
            (seq,session_id,float(pending_ts),encoded,seq))
        self._write_meta(db,'next_attempt_sequence',seq)
        db.execute("DELETE FROM spool_meta WHERE key='queue_overflow_pending_ts'")
        return True

    def _trim_history(self,db):
        keep=max(1,min(256,self.max_samples//4))
        db.execute('DELETE FROM spool_samples WHERE status=\'historical\' AND attempt_sequence NOT IN (SELECT attempt_sequence FROM spool_samples WHERE status=\'historical\' ORDER BY created_order DESC LIMIT ?)',(keep,))
        db.execute('DELETE FROM spool_batches WHERE status=\'historical\' AND batch_sequence NOT IN (SELECT batch_sequence FROM spool_batches WHERE status=\'historical\' ORDER BY batch_sequence DESC LIMIT ?)',(keep,))

    def snapshot(self):
        try:
            with closing(self._connect()) as db:
                counts={row['status']:row['n'] for row in db.execute('SELECT status,COUNT(*) AS n FROM spool_samples GROUP BY status')}
                pending=db.execute("SELECT COUNT(*) AS n,COALESCE(SUM(length(CAST(sample_json AS BLOB))),0) AS bytes FROM spool_samples WHERE status IN ('pending','batched')").fetchone()
                return {'active_session_id':self._read_meta(db,'active_session_id'),
                    'active_generation':int(self._read_meta(db,'active_generation','0')),
                    'pending_samples':pending['n'],'pending_bytes':pending['bytes'],
                    'historical_samples':counts.get('historical',0),'acknowledged_samples':counts.get('acked',0),
                    'acknowledged_through':int(self._read_meta(db,'acknowledged_through','0')),
                    'pending_batches':db.execute("SELECT COUNT(*) AS n FROM spool_batches WHERE status='pending'").fetchone()['n'],
                    'overflow_gap_pending':self._read_meta(db,'queue_overflow_pending_ts') is not None}
        except Exception: raise ObservationSpoolError('metadata_spool_unavailable') from None

    def close(self):
        return None

