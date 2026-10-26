"""Run the local camera bridge against the deployed Modal HTTPS/WSS service."""
import argparse
import json
import os
import subprocess
import sys
from urllib.parse import urlparse
from run_two_server import load_environment, ROOT

def remote_config(url,token):
    parsed=urlparse(url)
    if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('','/'):
        raise ValueError('Provide the HTTPS origin of the Modal service')
    if not token:raise ValueError('Missing FireGuard service token')
    return {'ANALYSIS_WS_URL':'wss://'+parsed.netloc+'/v1/live','FIREGUARD_TOKEN':token}

def main():
    import requests
    parser=argparse.ArgumentParser();parser.add_argument('--url');parser.add_argument('--port',type=int,default=8001)
    args=parser.parse_args();env=load_environment()
    path=ROOT/'analysis/.modal-client.json'
    saved=json.loads(path.read_text()) if path.exists() else {}
    url=(args.url or saved.get('url') or '').rstrip('/')
    env.update(remote_config(url,saved.get('token') or env.get('FIREGUARD_TOKEN')))
    env['CAMERA_PORT']=str(args.port)
    print('Warming Modal analysis service...',flush=True)
    health=requests.get(url+'/health',timeout=180);health.raise_for_status()
    if not health.json().get('vlm_configured'):raise SystemExit('MiniCPM is not configured on Modal')
    auth=requests.get(url+'/v1/videos/auth-check',headers={'Authorization':'Bearer '+env['FIREGUARD_TOKEN']},timeout=30)
    if auth.status_code!=404:raise SystemExit('Remote service authentication failed')
    print(f'Camera controls: http://127.0.0.1:{args.port} (analysis on Modal)',flush=True)
    subprocess.run([sys.executable,'-m','camera.server'],cwd=ROOT,env=env,check=True)

if __name__=='__main__':main()
