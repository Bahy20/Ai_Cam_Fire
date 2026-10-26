"""Launch both PC services. No camera opens until Start camera is clicked."""
import argparse
import os
import secrets
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

def load_environment():
    env=os.environ.copy()
    path=ROOT/'analysis/.env.local'
    if path.exists():
        for line in path.read_text(encoding='utf-8-sig').splitlines():
            line=line.strip()
            if not line or line.startswith('#'):continue
            key,sep,value=line.partition('=')
            if not sep or not key.replace('_','').isalnum():raise ValueError('invalid .env.local line')
            env.setdefault(key,value.strip().strip('"').strip("'"))
    return env

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--allow-expected-lighter',action='store_true')
    args=parser.parse_args();env=load_environment()
    env.setdefault('FIREGUARD_TOKEN',secrets.token_urlsafe(32));env.setdefault('FIREGUARD_PYTHON',sys.executable)
    if args.allow_expected_lighter:env['EXPECTED_LIGHTER_CAMERAS']=env.get('CAMERA_ID','test-camera')
    children=[];logs=[];stopping=False
    def stop(*unused):
        nonlocal stopping
        stopping=True
    signal.signal(signal.SIGINT,stop);signal.signal(signal.SIGTERM,stop)
    folder=ROOT/'analysis-data';folder.mkdir(exist_ok=True)
    try:
        for name,command in [('analysis',['node','analysis/src/server.js']),('camera',[sys.executable,'-m','camera.server'])]:
            log=(folder/f'{name}.log').open('a',encoding='utf-8');logs.append(log)
            children.append(subprocess.Popen(command,cwd=ROOT,env=env,stdout=log,stderr=log,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0))
        print('Camera controls: http://127.0.0.1:'+env.get('CAMERA_PORT','8001'),flush=True)
        print('Analysis health: http://127.0.0.1:'+env.get('ANALYSIS_PORT','8002')+'/health',flush=True)
        print('Visual provider: MiniCPM on Modal (requires an authenticated Modal SDK login).',flush=True)
        print('Expected lighter use: '+(env.get('EXPECTED_LIGHTER_CAMERAS') or 'disabled'),flush=True)
        while not stopping:
            for process in children:
                if process.poll() is not None:raise RuntimeError('Service exited; see analysis-data logs')
            time.sleep(.5)
    finally:
        for child in children:
            if child.poll() is None:child.terminate()
        for child in children:
            try:child.wait(5)
            except subprocess.TimeoutExpired:child.kill();child.wait()
        for log in logs:log.close()
if __name__=='__main__':main()
