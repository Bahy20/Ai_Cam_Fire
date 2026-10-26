"""Replay the labelled webcam set through the gateway and track smoke false positives per policy version.

Protocol and label schema: docs/webcam-test-set.md. Template: scripts/evaluation/webcam-set.template.json.
Neither the output nor the saved reports contain the service token."""
import argparse
import csv
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime,timezone
from pathlib import Path,PurePosixPath,PureWindowsPath

ROOT=Path(__file__).resolve().parents[1]
SET_DIR=ROOT/'webcam-set'
CATEGORIES=('negative_dark_object','negative_dim_room','negative_steam','negative_reflection','negative_clear_scene',
    'negative_false_alarm','lighter_unlit','lighter_contained','smoke_real','material_burning','other')
SPLITS=('development','held_out');STATUSES=('missing','available','excluded');SOURCES=('webcam','operator_false_alarm')
# Ascending urgency. Unknown asks for review, so it ranks above monitor.
LEVELS=('monitor','unknown','inspect_urgently','escalate');URGENT={'inspect_urgently','escalate'}
FLAGS=('smoke_present','flame_present','burning_material_present','lighter_present')
REQUIRED=('id','file','status','category','split',*FLAGS,'expected_priority','source')
OPTIONAL=('sha256','recording_session','recorded_at','labelled_by','notes','review')
VIDEO_TYPES={'.mp4':'video/mp4','.mov':'video/quicktime','.avi':'video/x-msvideo'}
MAX_BYTES=250*1024*1024;TERMINAL={'complete','failed','interrupted'}
CLIP_ID=re.compile(r'^[A-Za-z0-9_-]{1,80}$');SHA=re.compile(r'^[0-9a-f]{64}$')
# A label may not contradict its category; null (unmeasured) never does.
CONTRADICTIONS={'negative':{'smoke_present':True,'flame_present':True,'burning_material_present':True},
    'lighter_unlit':{'flame_present':True,'lighter_present':False},
    'lighter_contained':{'lighter_present':False,'burning_material_present':True},
    'smoke_real':{'smoke_present':False},'material_burning':{'burning_material_present':False}}
HEALTH_FIELDS=('policy_version','build_id','vlm_provider','vlm_model','live_vlm_mode','detection_source','vlm_configured')
DEFINITIONS={
    'rows':'Model rows the gateway applied, after its description check, rebuilt from the job timeline (scene observations '
           'plus the latest hazard row). The job API does not return raw rows; a kind keeps material > smoke > flame precedence, '
           'so a finding hidden under a higher one counts as unknown.',
    'smoke_false_positive':'Smoke-negative clip (smoke_present false) whose run latched smoke, or, when the labels also say no '
           'flame and no burning material, latched any hazard or reached inspect_urgently/escalate.',
    'smoke_fp_row_rate':'Rows reporting smoke present / all applied rows, pooled over smoke-negative clips.',
    'smoke_missed':'Smoke-positive clip that neither latched a hazard nor reached inspect_urgently/escalate.',
    'priority_check':'Final priority level is one of expected_priority.',
    'description_check':'Per model row; flagged when its contradicted list is non-empty. The gateway turns a contradicted '
           'field into uncertain before the policy sees it, so smoke_rows_contradicted counts smoke claims the check removed '
           '(caught false rows on negatives, lost true rows on positives). null: the gateway reported no check.'}

class ClipError(Exception):pass

def rate(n,d):return round(n/d,4) if d else None

def sha256_file(path):
    digest=hashlib.sha256()
    with Path(path).open('rb') as data:
        for chunk in iter(lambda:data.read(1<<20),b''):digest.update(chunk)
    return digest.hexdigest()

def save_labels(path,data):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True);temporary=path.with_name(path.name+'.tmp')
    temporary.write_text(json.dumps(data,indent=2,ensure_ascii=False)+'\n',encoding='utf-8');os.replace(temporary,path)

def relative_file(value):
    return isinstance(value,str) and bool(value.strip()) and not (PurePosixPath(value).is_absolute() or
        PureWindowsPath(value).is_absolute() or PureWindowsPath(value).drive or value.startswith('\\'))

def validate_labels(data):
    """Structural and consistency errors as readable strings; an empty list means the labels are usable."""
    if not isinstance(data,dict) or data.get('version')!=1 or not isinstance(data.get('clips'),list):
        return ['labels must be an object with "version": 1 and a "clips" list']
    errors=[];ids=set();files={};hashes={};sessions={}
    for n,clip in enumerate(data['clips']):
        if not isinstance(clip,dict):errors.append(f'clips[{n}]: not an object');continue
        cid=clip.get('id');where=f'clip {cid}' if isinstance(cid,str) else f'clips[{n}]'
        bad=lambda message:errors.append(f'{where}: {message}')
        missing=[k for k in REQUIRED if k not in clip];unknown=sorted(set(clip)-set(REQUIRED)-set(OPTIONAL))
        if missing:bad('missing '+', '.join(missing))
        if unknown:bad('unknown field '+', '.join(unknown))
        if not isinstance(cid,str) or not CLIP_ID.match(cid):bad('id must be 1-80 letters, digits, _ or -')
        elif cid in ids:bad('duplicate id')
        else:ids.add(cid)
        file=clip.get('file')
        if not relative_file(file):bad('file must be a path relative to the labels file')
        elif PurePosixPath(file.replace('\\','/')).suffix.lower() not in VIDEO_TYPES:bad('file must be .mp4, .mov or .avi')
        else:
            key=file.replace('\\','/').lower()
            if key in files:bad(f'same file as clip {files[key]}')
            files[key]=cid
        for key,allowed in (('status',STATUSES),('category',CATEGORIES),('split',SPLITS),('source',SOURCES)):
            if key in clip and clip[key] not in allowed:bad(f'{key} must be one of {", ".join(allowed)}')
        for key in FLAGS:
            if key in clip and clip[key] is not None and not isinstance(clip[key],bool):bad(f'{key} must be true, false or null')
        expected=clip.get('expected_priority')
        if not (expected is None or expected in LEVELS or isinstance(expected,list) and expected and
                len(set(map(str,expected)))==len(expected) and all(v in LEVELS for v in expected)):
            bad('expected_priority must be null, a priority level or a list of levels')
        sha=clip.get('sha256')
        if sha is not None:
            if not isinstance(sha,str) or not SHA.match(sha):bad('sha256 must be 64 lowercase hex characters or null')
            elif sha in hashes:bad(f'same sha256 as clip {hashes[sha]}')
            else:hashes[sha]=cid
        session=clip.get('recording_session')
        if session is not None:
            if not isinstance(session,str) or not session.strip():bad('recording_session must be a non-empty string or null')
            elif clip.get('split') in SPLITS:
                # A recording session supplies either development or held-out clips, never both.
                first=sessions.setdefault(session,(clip['split'],cid))
                if first[0]!=clip['split']:bad(f'recording_session {session!r} is also in {first[0]} (clip {first[1]})')
        recorded=clip.get('recorded_at')
        if recorded is not None:
            try:datetime.fromisoformat(recorded)
            except (TypeError,ValueError):bad('recorded_at must be an ISO date/time or null')
        for key in ('labelled_by','notes'):
            if clip.get(key) is not None and not isinstance(clip[key],str):bad(f'{key} must be a string or null')
        review=clip.get('review')
        if clip.get('source')=='operator_false_alarm':
            if not isinstance(review,dict) or review.get('review_id') is None or not isinstance(review.get('session_id'),str):
                bad('operator_false_alarm clips need review.review_id and review.session_id')
        elif review is not None:bad('review is only for source operator_false_alarm')
        category=clip.get('category') if isinstance(clip.get('category'),str) else ''
        for key,value in CONTRADICTIONS.get('negative' if category.startswith('negative_') else category,{}).items():
            if clip.get(key) is value:bad(f'{key}={json.dumps(value)} contradicts category {category}')
    return errors

def clip_path(base,clip):return Path(base)/clip['file'].replace('\\','/')

def check_file(clip,base):
    """(path, sha256, problem) for an available clip; problem is None when the file is ready to upload."""
    path=clip_path(base,clip)
    if not path.is_file():return path,None,'file not found'
    size=path.stat().st_size
    if not size:return path,None,'file is empty'
    if size>MAX_BYTES:return path,None,'larger than the 250 MiB upload limit'
    digest=sha256_file(path)
    if clip.get('sha256') is None:return path,digest,'sha256 not recorded (run once with --write-sha256)'
    if digest!=clip['sha256']:return path,digest,'sha256 mismatch: the file changed after it was labelled'
    return path,digest,None

PRESENCE={'present':True,'not_observed':False}
# Observation kind -> (smoke, flame, burning_material); None where the kind's precedence hides the field.
KIND_ROWS={'material_burning':(None,None,True),'smoke_visible':(True,None,False),'flame_at_tool':(False,True,False),
    'flame_visible':(False,True,False),'unknown':(False,False,False)}

def frame_ts(frame_id):
    match=re.fullmatch(r'frame-(\d+)',str(frame_id));return int(match.group(1)) if match else None

def job_events(job):
    return [e for e in [*(job.get('timeline') or []),job.get('result')] if isinstance(e,dict)]

def applied_rows(job):
    rows={}
    for event in job_events(job):
        scene=event.get('scene_assessment') or {}
        if scene.get('status')=='current':
            for item in scene.get('observations') or []:
                smoke,flame,material=KIND_ROWS.get(item.get('kind'),(None,None,None))
                for fid in item.get('frame_ids') or []:
                    rows.setdefault(fid,{'frame_id':fid,'ts_ms':frame_ts(fid),'smoke':smoke,'flame':flame,
                        'burning_material':material,'description':item.get('description')})
        hazard=(event.get('incident_history') or {}).get('latest_hazard')
        if isinstance(hazard,dict) and hazard.get('frame_id'):  # exact enums for a latched hazard row
            rows[hazard['frame_id']]={'frame_id':hazard['frame_id'],'ts_ms':hazard.get('ts_ms',frame_ts(hazard['frame_id'])),
                **{k:PRESENCE.get(hazard.get(k)) for k in ('smoke','flame','burning_material')},'description':hazard.get('description')}
    return sorted(rows.values(),key=lambda r:(r['ts_ms'] is None,r['ts_ms'] or 0,r['frame_id']))

def description_checks(job):
    """frame_id -> check entry, or None when no inference reported a description check."""
    inferences=[i for i in job.get('inferences') or [] if isinstance(i,dict)]
    if not any('description_check' in i for i in inferences):return None
    return {e['frame_id']:e for i in inferences for e in i.get('description_check') or [] if isinstance(e,dict) and e.get('frame_id')}

def contradicted(entry,field=None):
    values=entry.get('contradicted') if isinstance(entry,dict) else None
    return bool(values) if field is None else isinstance(values,list) and field in values

def score_clip(label,job,policy_version=None):
    """Pure per-clip score of one finished (or failed) job against its labels."""
    events=job_events(job);final=job.get('result') or (events[-1] if events else {})
    out={k:label.get(k) for k in ('id','category','split','source','recording_session',*FLAGS,'expected_priority')}
    out.update(job_status=job.get('status'),error=job.get('error'),
        policy_version=(final.get('priority') or {}).get('policy_version') or policy_version)
    if job.get('status')!='complete':
        return {**out,'verdict':'error','checks':{},'failed_checks':[],'smoke_false_positive':None,'smoke_missed':None}
    level=lambda e:(e.get('priority') or {}).get('level')
    ranked=[level(e) for e in events if level(e) in LEVELS];history=[e.get('incident_history') or {} for e in events]
    latched=any(h.get('model_hazard') for h in history);smoke_latched=any(h.get('smoke_confirmed') for h in history)
    highest=max(ranked,key=LEVELS.index) if ranked else None;final_priority=final.get('priority') or {}
    rows=applied_rows(job);checks_by_frame=description_checks(job)
    smoke_rows=[r for r in rows if r['smoke'] is True]
    inferences=[i for i in job.get('inferences') or [] if isinstance(i,dict)];fresh=[i for i in inferences if i.get('mode')=='fresh']
    entries=list(checks_by_frame.values()) if checks_by_frame is not None else None
    alarmed=latched or highest in URGENT
    other_hazard=label.get('flame_present') is True or label.get('burning_material_present') is True
    checks={}
    if label.get('smoke_present') is False:checks['smoke']=not (smoke_latched or not other_hazard and alarmed)
    elif label.get('smoke_present') is True:checks['smoke']=alarmed
    expected=label.get('expected_priority')
    if expected is not None:checks['priority']=final_priority.get('level') in ([expected] if isinstance(expected,str) else expected)
    failed=[k for k,ok in checks.items() if not ok]
    return {**out,'sampled_frames':job.get('sampled_frames'),'duration_s':(job.get('metadata') or {}).get('duration_s'),
        'model_batches':len(fresh),'failed_batches':sum(i.get('mode')=='failed' for i in inferences),
        'model_rows':sum(len(i.get('frame_ids') or []) for i in fresh),'valid_rows':len(rows),'smoke_rows':len(smoke_rows),
        'flame_rows':sum(r['flame'] is True for r in rows),'material_rows':sum(r['burning_material'] is True for r in rows),
        'description_checked_rows':None if entries is None else len(entries),
        'description_flagged_rows':None if entries is None else sum(contradicted(e) for e in entries),
        'low_detail_rows':None if entries is None else sum(e.get('low_detail') is True for e in entries),
        'smoke_rows_contradicted':None if entries is None else sum(contradicted(e,'smoke') for e in entries),
        'latched':latched,'smoke_latched':smoke_latched,'fire_latched':any(h.get('fire_confirmed') for h in history),
        'highest_priority':highest,'final_priority':final_priority.get('level'),'final_reason':final_priority.get('reason'),
        'first_urgent_ts_ms':next((e.get('source_ts_ms') for e in events if level(e) in URGENT),None),
        'smoke_false_positive':not checks['smoke'] if label.get('smoke_present') is False else None,
        'smoke_missed':not checks['smoke'] if label.get('smoke_present') is True else None,
        'checks':checks,'failed_checks':failed,'verdict':'unscored' if not checks else 'fail' if failed else 'pass',
        'smoke_row_examples':[{'frame_id':r['frame_id'],'description':r['description']} for r in smoke_rows[:5]]}

def blank_totals():
    return {'clips':0,'errors':0,'passed':0,'failed':0,'unscored':0,'smoke_negative_clips':0,'smoke_fp_clips':0,
        'smoke_negative_rows':0,'smoke_fp_rows':0,'smoke_fp_rows_contradicted':None,'smoke_positive_clips':0,'smoke_missed_clips':0,
        'smoke_positive_rows_contradicted':None,
        'priority_checked':0,'priority_mismatches':0,'fp_clip_ids':[],'missed_clip_ids':[],'failed_clip_ids':[],'error_clip_ids':[]}

def aggregate(results):
    """policy_version -> split ('development', 'held_out', 'all') -> totals and rates. Errors stay out of every rate."""
    out={}
    for r in results:
        for split in (r.get('split') or 'unknown','all'):
            a=out.setdefault(r.get('policy_version') or 'unknown',{}).setdefault(split,blank_totals());a['clips']+=1
            if r['verdict']=='error':a['errors']+=1;a['error_clip_ids'].append(r['id']);continue
            a[{'pass':'passed','fail':'failed','unscored':'unscored'}[r['verdict']]]+=1
            if r['verdict']=='fail':a['failed_clip_ids'].append(r['id'])
            if r['smoke_false_positive'] is not None:
                a['smoke_negative_clips']+=1;a['smoke_negative_rows']+=r['valid_rows'];a['smoke_fp_rows']+=r['smoke_rows']
                if r['smoke_rows_contradicted'] is not None:a['smoke_fp_rows_contradicted']=(a['smoke_fp_rows_contradicted'] or 0)+r['smoke_rows_contradicted']
                if r['smoke_false_positive']:a['smoke_fp_clips']+=1;a['fp_clip_ids'].append(r['id'])
            if r['smoke_missed'] is not None:
                a['smoke_positive_clips']+=1
                if r['smoke_rows_contradicted'] is not None:
                    a['smoke_positive_rows_contradicted']=(a['smoke_positive_rows_contradicted'] or 0)+r['smoke_rows_contradicted']
                if r['smoke_missed']:a['smoke_missed_clips']+=1;a['missed_clip_ids'].append(r['id'])
            if 'priority' in r['checks']:a['priority_checked']+=1;a['priority_mismatches']+=not r['checks']['priority']
    for splits in out.values():
        for a in splits.values():
            a.update(smoke_fp_clip_rate=rate(a['smoke_fp_clips'],a['smoke_negative_clips']),
                smoke_fp_row_rate=rate(a['smoke_fp_rows'],a['smoke_negative_rows']),
                smoke_miss_rate=rate(a['smoke_missed_clips'],a['smoke_positive_clips']))
    return out

def fraction(n,d):return f'{n}/{d} ({n/d:.1%})' if d else f'{n}/0 (n/a)'

def summary_lines(aggregates,health=None,target=None):
    lines=[]
    for policy,splits in aggregates.items():
        lines.append(f'Policy {policy} (build {(health or {}).get("build_id") or "unknown"}, {target or "unknown target"})')
        for split in ('development','held_out','unknown','all'):
            a=splits.get(split)
            if not a:continue
            lines.append(f'  {split+":":<13}{a["clips"]} clips, {a["errors"]} errors | smoke FP clips {fraction(a["smoke_fp_clips"],a["smoke_negative_clips"])}'
                f' | smoke FP rows {fraction(a["smoke_fp_rows"],a["smoke_negative_rows"])} | smoke misses {fraction(a["smoke_missed_clips"],a["smoke_positive_clips"])}'
                f' | priority mismatches {a["priority_mismatches"]}/{a["priority_checked"]}')
        a=splits['all']
        for name,key in (('smoke false positives','fp_clip_ids'),('missed smoke','missed_clip_ids'),('failed checks','failed_clip_ids'),('errors','error_clip_ids')):
            if a[key]:lines.append(f'  {name}: {", ".join(a[key])}')
    return lines

CSV_FIELDS=('id','category','split','source','recording_session',*FLAGS,'expected_priority','job_status','policy_version',
    'sampled_frames','model_batches','failed_batches','valid_rows','smoke_rows','flame_rows','material_rows',
    'description_checked_rows','description_flagged_rows','smoke_rows_contradicted','latched','smoke_latched',
    'highest_priority','final_priority','final_reason','smoke_false_positive','smoke_missed','verdict','failed_checks','error')
HISTORY_FIELDS=('generated_at','policy_version','build_id','target','camera_id','split','clips','errors','smoke_negative_clips',
    'smoke_fp_clips','smoke_fp_clip_rate','smoke_negative_rows','smoke_fp_rows','smoke_fp_row_rate','smoke_positive_clips',
    'smoke_missed_clips','subset','rescored','labels_sha256','report')

def csv_value(value):
    if isinstance(value,list):return '|'.join(map(str,value))
    return '' if value is None else value

def write_outputs(report,out_dir,name):
    out_dir.mkdir(parents=True,exist_ok=True)
    json_path=out_dir/f'{name}.json';csv_path=out_dir/f'{name}.csv'
    json_path.write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    with csv_path.open('w',newline='',encoding='utf-8') as data:
        writer=csv.DictWriter(data,fieldnames=CSV_FIELDS,extrasaction='ignore');writer.writeheader()
        for clip in report['clips']:writer.writerow({k:csv_value(clip.get(k)) for k in CSV_FIELDS})
    history=out_dir/'history.csv';new=not history.exists()
    with history.open('a',newline='',encoding='utf-8') as data:
        writer=csv.DictWriter(data,fieldnames=HISTORY_FIELDS)
        if new:writer.writeheader()
        for policy,splits in report['aggregate'].items():
            for split,a in splits.items():
                writer.writerow({**{k:csv_value(a.get(k)) for k in HISTORY_FIELDS if k in a},'generated_at':report['generated_at'],
                    'policy_version':policy,'build_id':csv_value(report['health'].get('build_id')),'target':report['target']['kind'],
                    'camera_id':report['target']['camera_id'],'split':split,'subset':csv_value(report['subset']),
                    'rescored':bool(report['rescored_from']),'labels_sha256':report['labels']['sha256'],'report':json_path.name})
    return json_path,csv_path

def resolve_target(args):
    """(base_url, token, kind) found the way the existing scripts do; the token is never printed."""
    from run_two_server import load_environment
    env=load_environment()
    if args.local:
        token=env.get('FIREGUARD_TOKEN')
        if not token:raise SystemExit('--local needs FIREGUARD_TOKEN in the environment or analysis/.env.local, the same value the local gateway uses')
        return f'http://127.0.0.1:{args.port or env.get("ANALYSIS_PORT","8002")}',token,'local'
    from run_camera_modal import remote_config
    path=ROOT/'analysis/.modal-client.json';saved=json.loads(path.read_text()) if path.exists() else {}
    base=(args.base_url or saved.get('url') or '').rstrip('/')
    if not base:raise SystemExit('No hosted URL: pass --base-url, or run scripts/configure_modal.py first')
    token=saved.get('token') or env.get('FIREGUARD_TOKEN')
    try:remote_config(base,token)  # rejects plaintext, credential-bearing or path URLs and a missing token
    except ValueError as error:raise SystemExit(str(error)) from None
    return base,token,'hosted'

def error_code(response):
    try:return response.json().get('error') or ''
    except ValueError:return ''

def fetch_health(http,base):
    response=http.get(base+'/health',timeout=180);response.raise_for_status();health=response.json()
    if not health.get('vlm_configured'):raise SystemExit('The gateway reports vlm_configured=false; nothing would be analysed')
    return {k:health.get(k) for k in HEALTH_FIELDS}

def upload(http,base,headers,path,camera_id,busy_wait=600):
    import requests
    deadline=time.monotonic()+busy_wait
    while True:
        try:
            with path.open('rb') as video:
                response=http.post(base+'/v1/videos',params={'camera_id':camera_id},headers=headers,
                    files={'video':(path.name,video,VIDEO_TYPES[path.suffix.lower()])},timeout=(30,600))
        except requests.RequestException as error:raise ClipError(f'upload_failed {type(error).__name__}') from None
        if response.status_code==202:return response.json()['id']
        if response.status_code==401:raise SystemExit('The gateway rejected the service token (401)')
        # One video job runs at a time; another upload (or a timed-out earlier clip) may still hold it.
        if response.status_code==409 and time.monotonic()<deadline:time.sleep(10);continue
        raise ClipError(f'upload_http_{response.status_code} {error_code(response)}'.strip())

def wait_job(http,base,headers,job_id,timeout=900,poll=2.0):
    import requests
    started=time.monotonic();deadline=started+timeout;events=[];after=0;failures=0;status=None
    while True:
        try:
            response=http.get(f'{base}/v1/videos/{job_id}',params={'after':after,'limit':1000},headers=headers,timeout=60)
            if response.status_code==404:raise ClipError('job_not_found')
            response.raise_for_status();job=response.json();failures=0
        except (requests.RequestException,ValueError) as error:
            failures+=1
            if failures>5:raise ClipError(f'poll_failed {type(error).__name__}') from None
            time.sleep(poll*failures);continue
        page=job.get('timeline') or [];events+=page;after=job.get('next_after',after);status=job.get('status')
        duration=(job.get('metadata') or {}).get('duration_s')
        # Uploads are replayed in real time, so a long clip extends the deadline.
        if isinstance(duration,(int,float)):deadline=max(deadline,started+2*duration+300)
        if status in TERMINAL and len(page)<1000:return {**job,'timeline':events}
        if len(page)>=1000:continue
        if time.monotonic()>deadline:raise ClipError(f'job_timeout (last status {status})')
        time.sleep(poll)

def parse_args(argv=None):
    p=argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument('--labels',type=Path,default=SET_DIR/'labels.json')
    where=p.add_mutually_exclusive_group()
    where.add_argument('--base-url',help='HTTPS origin of a deployed gateway (default: url in analysis/.modal-client.json)')
    where.add_argument('--local',action='store_true',help='Local gateway on 127.0.0.1 (token: FIREGUARD_TOKEN from the environment or analysis/.env.local)')
    where.add_argument('--from-jobs',type=Path,metavar='DIR',help='Rescore the jobs an earlier run saved in DIR instead of uploading')
    p.add_argument('--port',type=int,help='Local gateway port (default ANALYSIS_PORT or 8002)')
    p.add_argument('--only',action='append',metavar='ID',help='Evaluate only this clip id (repeatable)')
    p.add_argument('--dry-run',action='store_true',help='Validate labels, files and sha256 without uploading')
    p.add_argument('--write-sha256',action='store_true',help='Record the sha256 of available clips that have none (implies --dry-run)')
    p.add_argument('--out',type=Path,default=SET_DIR/'reports')
    p.add_argument('--camera-id',default='test-camera',help='Camera id whose gateway policy settings apply (EXPECTED_LIGHTER_CAMERAS, HAZARDOUS_CAMERAS)')
    p.add_argument('--job-timeout',type=float,default=900,help='Seconds to wait for one job (longer clips extend it)')
    return p.parse_args(argv)

def main(argv=None):
    args=parse_args(argv);labels_path=args.labels.resolve()
    try:data=json.loads(labels_path.read_text(encoding='utf-8'))
    except FileNotFoundError:raise SystemExit(f'Labels file not found: {args.labels} (start from scripts/evaluation/webcam-set.template.json)') from None
    errors=validate_labels(data)
    if errors:print('Label errors:',*errors,sep='\n  ');return 2
    clips=data['clips'];unknown=sorted(set(args.only or [])-{c['id'] for c in clips})
    if unknown:raise SystemExit('Unknown clip id: '+', '.join(unknown))
    selected=[c for c in clips if not args.only or c['id'] in args.only];base=labels_path.parent
    available=[c for c in selected if c['status']=='available']
    skipped={s:[c['id'] for c in selected if c['status']==s] for s in ('missing','excluded')}
    if args.write_sha256:
        filled=[]
        for clip in available:
            path=clip_path(base,clip)
            if clip.get('sha256') is None and path.is_file():clip['sha256']=sha256_file(path);filled.append(clip['id'])
        errors=validate_labels(data)
        if errors:print('Label errors after hashing:',*errors,sep='\n  ');return 2
        if filled:save_labels(labels_path,data)
        print(f'Recorded sha256 for {len(filled)} clip(s): {", ".join(filled) or "-"}');args.dry_run=True
    print(f'{len(available)} available, {len(skipped["missing"])} missing, {len(skipped["excluded"])} excluded clip(s) in {args.labels}')
    if not args.from_jobs:
        problems=[]
        for clip in available:
            path,digest,problem=check_file(clip,base)
            if problem:problems.append(f'{clip["id"]}: {problem} ({path})')
            elif args.dry_run:print(f'  ok  {clip["id"]}  {clip["category"]}  {clip["split"]}')
        if problems:print('File problems (nothing was uploaded):',*problems,sep='\n  ');return 1
    if args.dry_run:print('Dry run: no uploads.');return 0
    if not available:print('No available clips to evaluate.');return 0
    stamp=datetime.now(timezone.utc);results=[]
    if args.from_jobs:
        health_path=args.from_jobs/'health.json';health=json.loads(health_path.read_text()) if health_path.exists() else {}
        base_url=None;kind='rescore';cameras=set()
        for clip in available:
            path=args.from_jobs/f'{clip["id"]}.json'
            saved=json.loads(path.read_text(encoding='utf-8')) if path.exists() else None
            job=({'status':'not_run','error':'saved_job_missing'} if saved is None else
                 {'status':'not_run','error':'sha256_changed_since_upload'} if saved.get('sha256')!=clip.get('sha256') else saved['job'])
            if job.get('camera_id'):cameras.add(job['camera_id'])
            results.append(score_clip(clip,job,health.get('policy_version')))
        # The saved jobs, not this invocation's default, say which camera id's policy settings applied.
        if cameras:args.camera_id=','.join(sorted(cameras))
    else:
        import requests
        base_url,token,kind=resolve_target(args);http=requests.Session();headers={'Authorization':'Bearer '+token}
        print(f'Gateway: {base_url} ({kind}), camera id {args.camera_id}',flush=True)
        try:health=fetch_health(http,base_url)
        except requests.RequestException as error:raise SystemExit(f'Gateway health check failed: {type(error).__name__}') from None
        print(f'Policy {health["policy_version"]}, build {health.get("build_id")}',flush=True)
        jobs_dir=args.out/f'{safe_name(health.get("policy_version"))}-{stamp:%Y%m%dT%H%M%SZ}-jobs';jobs_dir.mkdir(parents=True,exist_ok=True)
        (jobs_dir/'health.json').write_text(json.dumps(health,indent=2)+'\n',encoding='utf-8')
        for n,clip in enumerate(available,1):
            path=clip_path(base,clip);print(f'[{n}/{len(available)}] {clip["id"]}: uploading {clip["file"]}',flush=True)
            try:job=wait_job(http,base_url,headers,upload(http,base_url,headers,path,args.camera_id),args.job_timeout)
            except ClipError as error:job={'status':'not_run','error':str(error)}
            (jobs_dir/f'{clip["id"]}.json').write_text(json.dumps({'clip_id':clip['id'],'file':clip['file'],'sha256':clip['sha256'],
                'job':job},indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
            result=score_clip(clip,job,health.get('policy_version'));results.append(result)
            print(f'    {result["verdict"]:<8}'+(f'error {result["error"]}' if result['verdict']=='error' else
                f'final {result["final_priority"]}, highest {result["highest_priority"]}, latched {result["latched"]}, '
                f'smoke rows {result["smoke_rows"]}/{result["valid_rows"]}'),flush=True)
    versions=[r['policy_version'] for r in results if r.get('policy_version')]
    policy=health.get('policy_version') or (max(set(versions),key=versions.count) if versions else 'unknown')
    if health.get('policy_version') and any(v!=health['policy_version'] for v in versions):
        print('Warning: some jobs report a different policy_version than /health (redeployed during the run?)')
    report={'version':1,'generated_at':stamp.isoformat(timespec='seconds').replace('+00:00','Z'),
        'target':{'kind':kind,'base_url':base_url,'camera_id':args.camera_id},'health':health,
        'labels':{'file':str(args.labels),'sha256':sha256_file(labels_path)},'subset':args.only or None,
        'rescored_from':str(args.from_jobs) if args.from_jobs else None,'skipped':skipped,'definitions':DEFINITIONS,
        'aggregate':aggregate(results),'clips':results}
    json_path,csv_path=write_outputs(report,args.out,f'{safe_name(policy)}-{stamp:%Y%m%dT%H%M%SZ}')
    print(*summary_lines(report['aggregate'],health,kind),sep='\n');print(f'Report: {json_path}\nCSV:    {csv_path}')
    return 1 if any(r['verdict']=='error' for r in results) else 0

def safe_name(value):return re.sub(r'[^A-Za-z0-9._-]+','_',str(value or 'unknown'))[:80]

if __name__=='__main__':sys.exit(main())
