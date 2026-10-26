"""Offline tests of the webcam-set labels, scoring and operator false-alarm export."""
import contextlib
import csv
import io
import json
import re
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import evaluate_webcam_set as ws
import export_false_alarms as fa

ROOT=Path(__file__).resolve().parents[2]
TEMPLATE=ROOT/'scripts/evaluation/webcam-set.template.json'
POLICY='minicpm-only-v4'

def label(cid,category='negative_dark_object',smoke=False,flame=False,material=False,lighter=False,expected=('monitor','unknown'),split='development',**extra):
    return {'id':cid,'file':f'clips/{cid}.mp4','sha256':None,'status':'available','category':category,'split':split,
        'recording_session':'desk-a' if split=='development' else 'desk-b','smoke_present':smoke,'flame_present':flame,
        'burning_material_present':material,'lighter_present':lighter,'expected_priority':list(expected) if isinstance(expected,tuple) else expected,
        'recorded_at':None,'labelled_by':None,'notes':None,'source':'webcam',**extra}

def obs(ts,kind='unknown',description='Desk and mousepad, nothing burning'):
    return {'frame_ids':[f'frame-{ts}'],'kind':kind,'description':description}

def event(ts,level,reason='x',observations=None,latched=False,smoke=False,fire=False,hazard=None):
    return {'source_ts_ms':ts,'priority':{'policy_version':POLICY,'scope':'observed_interval','level':level,'reason':reason},
        'incident_history':{'model_hazard':latched,'smoke_confirmed':smoke,'fire_confirmed':fire,'latest_hazard':hazard},
        'scene_assessment':{'status':'current' if observations is not None else 'not_assessed','observations':observations or []}}

def job(events,status='complete',checks=None,error=None):
    inferences=[{'mode':'fresh','source':'modal','frame_ids':[f'frame-{t}' for t in (1000,3000,5000)],'validation_errors':[],
        **({'description_check':checks} if checks is not None else {})},{'mode':'failed','error':'minicpm_timeout'}]
    return {'id':'job','status':status,'error':error,'sampled_frames':90,'metadata':{'duration_s':30.0},
        'timeline':[{'event_id':n+1,**e} for n,e in enumerate(events)],'result':events[-1] if events else None,'inferences':inferences}

CLEAR=[obs(1000),obs(3000),obs(5000)];CLEAR2=[obs(5000),obs(8000),obs(10000)]
def hazard_row(ts):
    return {'ts_ms':ts,'frame_id':f'frame-{ts}','smoke':'present','flame':'not_observed','burning_material':'not_observed',
        'description':'Grey haze rising from the mousepad edge'}

def clean_negative():
    return job([event(0,'unknown','assessment_required'),event(5000,'monitor','no_visual_hazard_observed',CLEAR),
        event(10000,'monitor','no_visual_hazard_observed',CLEAR2)])

def negative_one_smoke_row():
    return job([event(0,'unknown','assessment_required'),
        event(5000,'unknown','hazard_unconfirmed',[obs(1000),obs(3000),obs(5000,'smoke_visible','Grey haze near the mousepad')]),
        event(10000,'monitor','no_visual_hazard_observed',CLEAR2)],
        # frame-3000 claimed smoke but said "no smoke": the gateway applied it as uncertain, so it is not a smoke row.
        checks=[{'frame_id':'frame-1000','contradicted':[],'unsupported':[],'low_detail':False},
                {'frame_id':'frame-3000','contradicted':['smoke'],'unsupported':[],'low_detail':True},
                {'frame_id':'frame-5000','contradicted':[],'unsupported':[],'low_detail':False}])

def negative_latched():
    rows=[obs(1000,'smoke_visible','Smoke over the desk'),obs(3000,'smoke_visible','Smoke over the desk'),obs(5000)]
    return job([event(0,'unknown','assessment_required'),
        event(5000,'inspect_urgently','verified_hazard_unresolved',rows,True,True,False,hazard_row(3000)),
        event(10000,'inspect_urgently','verified_hazard_unresolved',[obs(5000),obs(8000),obs(10000)],True,True,False,hazard_row(3000))])

def positive_detected():
    rows=[obs(1000,'smoke_visible'),obs(3000,'smoke_visible'),obs(5000,'smoke_visible')]
    return job([event(0,'unknown','assessment_required'),
        event(5000,'inspect_urgently','verified_hazard_unresolved',rows,True,True,False,hazard_row(5000))])

def positive_missed():
    return job([event(0,'unknown','assessment_required'),event(5000,'monitor','no_visual_hazard_observed',CLEAR)])

class LabelValidationTests(unittest.TestCase):
    def test_template_is_valid_and_lists_missing_clips(self):
        data=json.loads(TEMPLATE.read_text(encoding='utf-8'))
        self.assertEqual(ws.validate_labels(data),[])
        self.assertTrue(data['clips'] and all(c['status']=='missing' for c in data['clips']))
        self.assertEqual({c['split'] for c in data['clips']},{'development','held_out'})

    def test_rejects_structural_and_contradictory_labels(self):
        good=label('neg-a');cases={
            'duplicate id':[good,{**label('neg-a'),'file':'clips/other.mp4'}],
            'split must be one of':[{**good,'split':'test'}],
            'smoke_present must be true, false or null':[{**good,'smoke_present':'yes'}],
            'contradicts category negative_steam':[{**good,'category':'negative_steam','smoke_present':True}],
            'contradicts category smoke_real':[{**good,'category':'smoke_real'}],
            "recording_session 'desk-a' is also in development":[good,{**label('neg-b'),'split':'held_out','recording_session':'desk-a'}],
            'same sha256 as clip neg-a':[{**good,'sha256':'a'*64},{**label('neg-b'),'sha256':'a'*64}],
            'unknown field smoke_presnt':[{**good,'smoke_presnt':False}],
            'missing lighter_present':[{k:v for k,v in good.items() if k!='lighter_present'}],
            'file must be a path relative':[{**good,'file':'C:/videos/a.mp4'}],
            'file must be .mp4, .mov or .avi':[{**good,'file':'clips/a.mkv'}],
            'expected_priority must be null':[{**good,'expected_priority':'alarm'}],
            'need review.review_id':[{**good,'source':'operator_false_alarm'}],
            'review is only for source operator_false_alarm':[{**good,'review':{'review_id':1,'session_id':'s'}}],
            'recorded_at must be an ISO':[{**good,'recorded_at':'yesterday'}]}
        for message,clips in cases.items():
            with self.subTest(message):
                errors=ws.validate_labels({'version':1,'clips':clips})
                self.assertTrue(any(message in e for e in errors),errors)
        self.assertEqual(ws.validate_labels({'version':1,'clips':[good,label('neg-b',split='held_out'),
            label('smoke-a','smoke_real',smoke=True,expected='inspect_urgently'),label('neg-c',smoke=None,flame=None)]}),[])
        self.assertTrue(ws.validate_labels({'version':2,'clips':[]}))
        self.assertTrue(ws.validate_labels({'version':1,'clips':[{**good,'category':['negative_steam']}]}))

    def test_check_file_requires_matching_sha256(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);(base/'clips').mkdir();clip=label('neg-a');(base/clip['file']).write_bytes(b'video bytes')
            self.assertIn('not recorded',ws.check_file(clip,base)[2])
            digest=ws.check_file(clip,base)[1]
            self.assertIsNone(ws.check_file({**clip,'sha256':digest},base)[2])
            self.assertIn('mismatch',ws.check_file({**clip,'sha256':'0'*64},base)[2])
            self.assertEqual(ws.check_file({**clip,'file':'clips/none.mp4'},base)[2],'file not found')

class ScoringTests(unittest.TestCase):
    def test_clean_negative_passes(self):
        r=ws.score_clip(label('neg-clean'),clean_negative())
        self.assertEqual((r['verdict'],r['smoke_false_positive'],r['smoke_rows'],r['valid_rows']),('pass',False,0,5))
        self.assertEqual((r['highest_priority'],r['final_priority'],r['latched'],r['policy_version']),('unknown','monitor',False,POLICY))
        self.assertEqual((r['model_batches'],r['failed_batches'],r['model_rows'],r['sampled_frames']),(1,1,3,90))
        self.assertIsNone(r['description_checked_rows']);self.assertIsNone(r['smoke_rows_contradicted'])

    def test_negative_with_one_unlatched_smoke_row_is_a_row_not_a_clip_false_positive(self):
        r=ws.score_clip(label('neg-one-row'),negative_one_smoke_row())
        self.assertEqual((r['verdict'],r['smoke_false_positive'],r['smoke_rows'],r['valid_rows']),('pass',False,1,5))
        self.assertEqual((r['description_checked_rows'],r['description_flagged_rows'],r['smoke_rows_contradicted'],r['low_detail_rows']),(3,1,1,1))
        self.assertEqual(r['smoke_row_examples'],[{'frame_id':'frame-5000','description':'Grey haze near the mousepad'}])

    def test_negative_that_latched_is_a_false_positive(self):
        r=ws.score_clip(label('neg-latched'),negative_latched())
        self.assertEqual((r['verdict'],r['smoke_false_positive'],r['smoke_latched'],r['final_priority']),('fail',True,True,'inspect_urgently'))
        self.assertEqual(r['failed_checks'],['smoke','priority']);self.assertEqual((r['smoke_rows'],r['valid_rows']),(2,5))
        self.assertEqual(r['first_urgent_ts_ms'],5000)

    def test_positive_detected_and_missed(self):
        smoke=label('smoke-a','smoke_real',smoke=True,expected='inspect_urgently',split='held_out')
        hit=ws.score_clip(smoke,positive_detected());miss=ws.score_clip({**smoke,'id':'smoke-b'},positive_missed())
        self.assertEqual((hit['verdict'],hit['smoke_missed'],hit['smoke_false_positive']),('pass',False,None))
        self.assertEqual((miss['verdict'],miss['smoke_missed'],miss['failed_checks']),('fail',True,['smoke','priority']))

    def test_urgency_explained_by_a_labelled_flame_is_not_a_smoke_false_positive(self):
        lighter=label('lighter-a','lighter_contained',flame=True,lighter=True,expected=None)
        flame=job([event(0,'unknown','assessment_required'),event(5000,'inspect_urgently','uncontained_flame',
            [obs(1000,'flame_at_tool'),obs(3000,'flame_at_tool'),obs(5000,'flame_at_tool')])])
        r=ws.score_clip(lighter,flame)
        self.assertEqual((r['verdict'],r['smoke_false_positive'],r['flame_rows']),('pass',False,3))
        self.assertTrue(ws.score_clip(lighter,negative_latched())['smoke_false_positive'])  # a smoke latch is never explained

    def test_failed_job_is_an_error_outside_every_rate(self):
        r=ws.score_clip(label('neg-err'),job([],status='failed',error='invalid_video_metadata_or_limits'),POLICY)
        self.assertEqual((r['verdict'],r['error'],r['policy_version'],r['smoke_false_positive']),('error','invalid_video_metadata_or_limits',POLICY,None))

    def test_aggregate_per_policy_and_split(self):
        results=[ws.score_clip(label('neg-clean'),clean_negative()),ws.score_clip(label('neg-one-row'),negative_one_smoke_row()),
            ws.score_clip(label('neg-latched'),negative_latched()),
            ws.score_clip(label('smoke-a','smoke_real',smoke=True,expected='inspect_urgently',split='held_out'),positive_detected()),
            ws.score_clip(label('smoke-b','smoke_real',smoke=True,expected='inspect_urgently',split='held_out'),positive_missed()),
            ws.score_clip(label('neg-err'),job([],status='failed',error='boom'),POLICY)]
        totals=ws.aggregate(results)[POLICY]
        a=totals['all']
        self.assertEqual((a['clips'],a['errors'],a['passed'],a['failed']),(6,1,3,2))
        self.assertEqual((a['smoke_negative_clips'],a['smoke_fp_clips'],a['smoke_fp_clip_rate']),(3,1,0.3333))
        self.assertEqual((a['smoke_negative_rows'],a['smoke_fp_rows'],a['smoke_fp_row_rate']),(15,3,0.2))
        self.assertEqual((a['smoke_positive_clips'],a['smoke_missed_clips'],a['smoke_miss_rate']),(2,1,0.5))
        self.assertEqual((a['fp_clip_ids'],a['missed_clip_ids'],a['error_clip_ids']),(['neg-latched'],['smoke-b'],['neg-err']))
        self.assertEqual((a['smoke_fp_rows_contradicted'],a['smoke_positive_rows_contradicted']),(1,None))
        self.assertEqual((totals['development']['smoke_negative_clips'],totals['held_out']['smoke_negative_clips']),(3,0))
        self.assertIsNone(totals['held_out']['smoke_fp_clip_rate'])
        lost=positive_missed();lost['inferences'][0]['description_check']=[{'frame_id':'frame-3000','contradicted':['smoke'],'unsupported':[],'low_detail':None}]
        lost=ws.aggregate([ws.score_clip(label('smoke-c','smoke_real',smoke=True,expected=None),lost)])[POLICY]['all']
        self.assertEqual((lost['smoke_missed_clips'],lost['smoke_positive_rows_contradicted'],lost['smoke_fp_rows_contradicted']),(1,1,None))
        lines=ws.summary_lines(ws.aggregate(results),{'build_id':'abc'},'hosted')
        self.assertIn('smoke FP clips 1/3 (33.3%)',lines[-5]);self.assertIn('neg-latched',lines[-4])

class EvaluateCommandTests(unittest.TestCase):
    def run_main(self,*args):
        with contextlib.redirect_stdout(io.StringIO()) as out:code=ws.main([str(a) for a in args])
        return code,out.getvalue()

    def test_dry_run_hashing_and_rescore_write_reports(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);(base/'clips').mkdir();labels=base/'labels.json'
            clips=[label('neg-latched'),label('neg-clean'),{**label('neg-later'),'status':'missing'}]
            for c in clips[:2]:(base/c['file']).write_bytes(c['id'].encode())
            ws.save_labels(labels,{'version':1,'clips':clips})
            self.assertEqual(self.run_main('--labels',labels,'--dry-run')[0],1)  # sha256 not recorded yet
            self.assertEqual(self.run_main('--labels',labels,'--write-sha256')[0],0)
            saved=json.loads(labels.read_text())['clips'];self.assertTrue(all(c['sha256'] for c in saved[:2]));self.assertIsNone(saved[2]['sha256'])
            code,out=self.run_main('--labels',labels,'--dry-run');self.assertEqual(code,0);self.assertIn('ok  neg-clean',out)
            jobs=base/'jobs';jobs.mkdir()
            (jobs/'health.json').write_text(json.dumps({'policy_version':POLICY,'build_id':'abc123'}))
            for c,j in zip(saved,(negative_latched(),clean_negative())):
                (jobs/f'{c["id"]}.json').write_text(json.dumps({'clip_id':c['id'],'sha256':c['sha256'],'job':j}))
            code,out=self.run_main('--labels',labels,'--from-jobs',jobs,'--out',base/'reports')
            self.assertEqual(code,0,out);self.assertIn('smoke FP clips 1/2 (50.0%)',out)
            report=json.loads(next((base/'reports').glob(f'{POLICY}-*.json')).read_text())
            self.assertEqual(report['aggregate'][POLICY]['all']['smoke_fp_clip_rate'],0.5)
            self.assertEqual(report['skipped']['missing'],['neg-later']);self.assertEqual(report['target']['kind'],'rescore')
            rows=list(csv.DictReader(next((base/'reports').glob(f'{POLICY}-*.csv')).read_text(encoding='utf-8').splitlines()))
            self.assertEqual([(r['id'],r['verdict'],r['smoke_false_positive']) for r in rows],[('neg-latched','fail','True'),('neg-clean','pass','False')])
            history=list(csv.DictReader((base/'reports/history.csv').read_text(encoding='utf-8').splitlines()))
            self.assertEqual({(h['policy_version'],h['split'],h['smoke_fp_clip_rate']) for h in history},
                {(POLICY,'development','0.5'),(POLICY,'all','0.5')})
            # A clip changed after its saved upload must not be rescored against the old job.
            changed=json.loads(labels.read_text());changed['clips'][1]['sha256']='f'*64;ws.save_labels(labels,changed)
            code,out=self.run_main('--labels',labels,'--from-jobs',jobs,'--out',base/'reports2')
            self.assertEqual(code,1);self.assertIn('neg-clean',out.split('errors:')[-1])

def store_schema():
    # The exact statements the gateway's Store runs (analysis/src/store.js).
    source=(ROOT/'analysis/src/store.js').read_text(encoding='utf-8')
    statements=re.findall(r'CREATE (?:TABLE|INDEX) IF NOT EXISTS [^;]+;',source)
    assert {'sessions','events','alert_reviews'}<={re.match(r'CREATE TABLE IF NOT EXISTS (\w+)',s).group(1) for s in statements if 'TABLE' in s[:13]}
    return 'PRAGMA journal_mode=WAL;\n'+'\n'.join(statements)

class ExportTests(unittest.TestCase):
    T0=1_761_500_000_000
    def build(self,tmp):
        import cv2
        import numpy as np
        folder=Path(tmp)/'hosted-db';evidence=folder/'evidence';db_path=folder/'fireguard.sqlite';folder.mkdir()
        db=sqlite3.connect(db_path);db.executescript(store_schema())
        live,other,bare='0f1e2d3c-live-session','resolved-session','no-evidence-session';incident='a1b2c3d4-e5f6-4711-8899-aabbccddeeff'
        db.execute('INSERT INTO sessions VALUES(?,?,?,?,?,?)',(live,'tester-x','live','disconnected',self.T0,json.dumps({'mode':'live'})))
        db.execute('INSERT INTO events(session,ts,body) VALUES(?,?,?)',(live,self.T0,json.dumps({'source_ts_ms':self.T0,'incident_id':incident})))
        hazard={'ts_ms':self.T0+12000,'frame_id':f'frame-{self.T0+12000}','smoke':'present','flame':'not_observed',
            'burning_material':'not_observed','description':'Grey haze near the mousepad edge'}
        for session,action,inc in ((live,'false_alarm',incident),(other,'incident_resolved','b'*36),(bare,'false_alarm','c'*36)):
            db.execute('INSERT INTO alert_reviews(session,ts,body) VALUES(?,?,?)',(session,self.T0+20000,json.dumps({'incident_id':inc,
                'action':action,'actor':'tester','reviewed_at_ms':self.T0+20000,'last_hazard':hazard})))
        db.commit();db.close()
        for session,offsets in ((live,(-60000,0,3000,12000,18000,25000)),(other,(0,1000))):
            (evidence/session).mkdir(parents=True)
            for n,offset in enumerate(offsets):
                ok,jpeg=cv2.imencode('.jpg',np.full((24,32,3),40*n,np.uint8));self.assertTrue(ok)
                (evidence/session/f'frame-{self.T0+offset}.jpg').write_bytes(jpeg.tobytes())
        return db_path

    def test_exports_false_alarm_reviews_once_as_replayable_negatives(self):
        import cv2
        with tempfile.TemporaryDirectory() as tmp:
            db_path=self.build(tmp);labels=Path(tmp)/'webcam-set/labels.json';before=db_path.read_bytes()
            ws.save_labels(labels,{'version':1,'clips':[label('neg-a')]})
            added,skipped=fa.export(db_path,labels,log=lambda *a:None)
            self.assertEqual(len(added),1);self.assertEqual([r for _,r in skipped],['no evidence frames in the review window'])
            data=json.loads(labels.read_text());self.assertEqual(ws.validate_labels(data),[]);self.assertEqual(len(data['clips']),2)
            entry=data['clips'][1]
            self.assertEqual(entry['id'],'fa-1-a1b2c3d4');self.assertEqual(entry['file'],'false-alarms/fa-1-a1b2c3d4.avi')
            self.assertEqual((entry['source'],entry['smoke_present'],entry['flame_present'],entry['split'],entry['status']),
                ('operator_false_alarm',False,None,'development','available'))
            self.assertEqual((entry['review']['review_id'],entry['review']['frames'],entry['recording_session']),(1,4,'live-0f1e2d3c-live-session'))
            video=labels.parent/entry['file'];self.assertEqual(entry['sha256'],ws.sha256_file(video))
            self.assertEqual(video.read_bytes()[:4]+video.read_bytes()[8:12],b'RIFFAVI ')  # the gateway's .avi signature check
            capture=cv2.VideoCapture(str(video))
            try:self.assertEqual((capture.get(cv2.CAP_PROP_FRAME_COUNT),capture.get(cv2.CAP_PROP_FPS)),(4,3))
            finally:capture.release()
            self.assertIsNone(ws.check_file(entry,labels.parent)[2])
            self.assertEqual(db_path.read_bytes(),before)
            added,skipped=fa.export(db_path,labels,log=lambda *a:None)
            self.assertEqual(added,[]);self.assertIn(('fa-1-a1b2c3d4','already in labels'),skipped)
            self.assertEqual(len(json.loads(labels.read_text())['clips']),2)

    def test_dry_run_writes_nothing_and_window_keeps_newest_frames(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path=self.build(tmp);labels=Path(tmp)/'webcam-set/labels.json';lines=[]
            added,_=fa.export(db_path,labels,dry_run=True,log=lines.append)
            self.assertEqual(added,[]);self.assertFalse(labels.exists());self.assertFalse((labels.parent/'false-alarms').exists())
            self.assertTrue(any('would write 4 frames' in line for line in lines))
        frames=[(t,f'f{t}') for t in range(0,10000,1000)]
        self.assertEqual(fa.select_frames(frames,9000,2000,8000,3),[(6000,'f6000'),(7000,'f7000'),(8000,'f8000')])
        review={'reviewed_at_ms':20000,'ts':20500,'last_hazard':{'ts_ms':12000}}
        self.assertEqual(fa.review_window(review,4000,30,10),(12000,-26000,20000))
        self.assertEqual(fa.review_window({'ts':5000,'last_hazard':None},None,1,1),(5000,4000,5000))
        self.assertEqual(fa.evidence_frames(Path(tmp),'../escape'),[])

if __name__=='__main__':unittest.main()
