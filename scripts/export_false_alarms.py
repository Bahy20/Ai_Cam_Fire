"""Turn operator 'false_alarm' reviews in a copy of the gateway SQLite database into replayable clips and labels.

Each review's live-session evidence frames become an MJPEG .avi (3 fps), so the normal upload path can replay them,
and the clip is appended to the webcam-set labels as a development smoke negative. The database is opened read-only."""
import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import datetime,timezone
from pathlib import Path
from evaluate_webcam_set import SET_DIR,save_labels,sha256_file,validate_labels

SESSION=re.compile(r'^[A-Za-z0-9_-]{1,80}$')  # the store's own evidence folder rule; never trust a path from the database
FRAME=re.compile(r'^frame-(\d+)\.jpg$')

def open_db(path):
    path=Path(path)
    if not path.is_file():raise SystemExit(f'Database not found: {path}')
    return sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True)

def false_alarm_reviews(db):
    reviews=[]
    for review_id,session,ts,body in db.execute('SELECT id,session,ts,body FROM alert_reviews ORDER BY id'):
        try:value=json.loads(body)
        except (TypeError,ValueError):continue
        # reviewAlert() in vlm-coordinator.js accepts exactly 'false_alarm' and 'incident_resolved'.
        if isinstance(value,dict) and value.get('action')=='false_alarm':
            reviews.append({**value,'review_id':review_id,'session_id':session,'ts':ts})
    return reviews

def incident_start(db,session,incident_id):
    if not incident_id:return None
    try:row=db.execute("SELECT min(json_extract(body,'$.source_ts_ms')) FROM events WHERE session=? AND json_extract(body,'$.incident_id')=?",
        (session,incident_id)).fetchone()
    except sqlite3.OperationalError:return None  # a malformed event body; fall back to the last hazard
    return row[0] if row and isinstance(row[0],int) else None

def evidence_frames(evidence_dir,session):
    if not isinstance(session,str) or not SESSION.match(session):return []
    folder=Path(evidence_dir)/session
    if not folder.is_dir():return []
    return sorted((int(m.group(1)),p) for p in folder.iterdir() if p.is_file() and (m:=FRAME.match(p.name)))

def select_frames(frames,anchor_ms,start_ms,end_ms,max_frames):
    """Frames inside [start, end]; when there are too many, the newest ones, which end at the reviewed hazard."""
    chosen=[f for f in frames if start_ms<=f[0]<=end_ms]
    return chosen[-max_frames:] if max_frames>0 else chosen

def review_window(review,start,before_s,after_s):
    hazard=review.get('last_hazard') if isinstance(review.get('last_hazard'),dict) else {}
    reviewed=review.get('reviewed_at_ms') if isinstance(review.get('reviewed_at_ms'),int) else review.get('ts')
    anchor=hazard.get('ts_ms') if isinstance(hazard.get('ts_ms'),int) else reviewed
    first=start if isinstance(start,int) and start<anchor else anchor
    end=anchor+int(after_s*1000)
    # Frames after the review belong to the reset, post-review state.
    if isinstance(reviewed,int):end=max(anchor,min(end,reviewed))
    return anchor,first-int(before_s*1000),end

def write_clip(paths,target,fps=3):
    import cv2
    target=Path(target);target.parent.mkdir(parents=True,exist_ok=True);temporary=target.with_name(target.stem+'.tmp.avi')
    writer=None;size=None;written=0
    try:
        for path in paths:
            image=cv2.imread(str(path),cv2.IMREAD_COLOR)
            if image is None:continue
            if writer is None:
                size=(image.shape[1],image.shape[0])
                writer=cv2.VideoWriter(str(temporary),cv2.VideoWriter_fourcc(*'MJPG'),fps,size)
                if not writer.isOpened():raise RuntimeError('OpenCV could not open an MJPG writer')
            # A live camera can change resolution mid-session; one clip needs one frame size.
            if (image.shape[1],image.shape[0])!=size:image=cv2.resize(image,size)
            writer.write(image);written+=1
    finally:
        if writer is not None:writer.release()
    if not written:temporary.unlink(missing_ok=True);return 0
    os.replace(temporary,target);return written

def iso(ms):return datetime.fromtimestamp(ms/1000,timezone.utc).isoformat(timespec='seconds').replace('+00:00','Z') if isinstance(ms,int) else None

def label_entry(review,clip_id,file,sha,frames,fps):
    hazard=review.get('last_hazard') if isinstance(review.get('last_hazard'),dict) else {}
    found=', '.join(f'{k}={hazard.get(k)}' for k in ('smoke','flame','burning_material') if hazard.get(k))
    notes=f'Operator false_alarm review {review["review_id"]} at {iso(review.get("reviewed_at_ms")) or "unknown time"}; '\
        f'{len(frames)} evidence frames replayed at {fps:g} fps (time-compressed).'
    if found:notes+=f' Last hazard report: {found}.'
    if hazard.get('description'):notes+=f' Model description: {str(hazard["description"])[:300]}'
    return {'id':clip_id,'file':file,'sha256':sha,'status':'available','category':'negative_false_alarm','split':'development',
        'recording_session':f'live-{review["session_id"]}','smoke_present':False,'flame_present':None,
        'burning_material_present':None,'lighter_present':None,'expected_priority':None,'recorded_at':iso(frames[0][0]),
        'labelled_by':'operator_review','notes':notes,'source':'operator_false_alarm',
        'review':{'review_id':review['review_id'],'session_id':review['session_id'],'incident_id':review.get('incident_id'),
            'reviewed_at_ms':review.get('reviewed_at_ms'),'last_hazard_ts_ms':hazard.get('ts_ms'),'frames':len(frames),
            'first_frame_ts_ms':frames[0][0],'last_frame_ts_ms':frames[-1][0]}}

def export(db_path,labels_path,evidence_dir=None,out_dir=None,fps=3,before_s=30,after_s=10,max_frames=900,dry_run=False,log=print):
    labels_path=Path(labels_path);evidence_dir=Path(evidence_dir) if evidence_dir else Path(db_path).parent/'evidence'
    out_dir=Path(out_dir) if out_dir else labels_path.parent/'false-alarms'
    data=json.loads(labels_path.read_text(encoding='utf-8')) if labels_path.exists() else \
        {'version':1,'description':'FireGuard labelled webcam set; see docs/webcam-test-set.md.','clips':[]}
    errors=validate_labels(data)
    if errors:raise SystemExit('Fix the labels file first:\n  '+'\n  '.join(errors))
    clips=data['clips'];ids={c['id'] for c in clips};hashes={c.get('sha256') for c in clips}-{None}
    reviewed={(c['review'].get('review_id'),c['review'].get('incident_id')) for c in clips
        if c.get('source')=='operator_false_alarm' and isinstance(c.get('review'),dict)}
    added=[];skipped=[]
    db=open_db(db_path)
    try:
        for review in false_alarm_reviews(db):
            incident=review.get('incident_id') if isinstance(review.get('incident_id'),str) else ''
            # alert_reviews ids are per database; the incident id keeps exports from two databases apart.
            clip_id=f'fa-{review["review_id"]}-{re.sub(r"[^A-Za-z0-9]","",incident)[:8] or "noincident"}'
            if clip_id in ids or (review['review_id'],review.get('incident_id')) in reviewed:
                skipped.append((clip_id,'already in labels'));continue
            anchor,start,end=review_window(review,incident_start(db,review['session_id'],review.get('incident_id')),before_s,after_s)
            frames=select_frames(evidence_frames(evidence_dir,review['session_id']),anchor,start,end,max_frames)
            if not frames:skipped.append((clip_id,'no evidence frames in the review window'));continue
            target=out_dir/f'{clip_id}.avi'
            if dry_run:log(f'{clip_id}: would write {len(frames)} frames to {target}');continue
            if not write_clip([p for _,p in frames],target,fps):skipped.append((clip_id,'no readable evidence frames'));continue
            sha=sha256_file(target)
            if sha in hashes:target.unlink();skipped.append((clip_id,'same video already in labels'));continue
            file=Path(os.path.relpath(target.resolve(),labels_path.resolve().parent)).as_posix()
            clips.append(label_entry(review,clip_id,file,sha,frames,fps));ids.add(clip_id);hashes.add(sha);added.append(clip_id)
            log(f'{clip_id}: {len(frames)} frames -> {target}')
    finally:db.close()
    if added:
        errors=validate_labels(data)
        if errors:raise SystemExit('Exported labels failed validation:\n  '+'\n  '.join(errors))
        save_labels(labels_path,data)
    for clip_id,reason in skipped:log(f'{clip_id}: skipped, {reason}')
    return added,skipped

def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument('--db',type=Path,required=True,help='Local copy of fireguard.sqlite (its evidence/ folder beside it)')
    p.add_argument('--evidence',type=Path,help='Evidence folder (default: evidence/ next to --db)')
    p.add_argument('--labels',type=Path,default=SET_DIR/'labels.json')
    p.add_argument('--out-dir',type=Path,help='Where clips go (default: false-alarms/ next to the labels file)')
    p.add_argument('--fps',type=float,default=3)
    p.add_argument('--before-s',type=float,default=30,help='Seconds of evidence before the incident start (or the last hazard)')
    p.add_argument('--after-s',type=float,default=10,help='Seconds after the last hazard report, never past the review')
    p.add_argument('--max-frames',type=int,default=900,help='Keep at most this many frames, newest first (900 = 5 min at 3 fps)')
    p.add_argument('--dry-run',action='store_true')
    args=p.parse_args(argv)
    added,skipped=export(args.db,args.labels,args.evidence,args.out_dir,args.fps,args.before_s,args.after_s,args.max_frames,args.dry_run)
    print(f'{len(added)} clip(s) added to {args.labels}, {len(skipped)} skipped.'+(' Dry run: nothing written.' if args.dry_run else ''))
    return 0

if __name__=='__main__':sys.exit(main())
