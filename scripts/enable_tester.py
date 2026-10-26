"""Enable a separate, revocable tester credential. Never prints the backend token."""
import json
import secrets
from run_two_server import ROOT

def main():
    config_path=ROOT/'analysis/.modal-client.json'
    config=json.loads(config_path.read_text())
    code=config.get('tester_code') or secrets.token_urlsafe(12)
    config['tester_code']=code
    config_path.write_text(json.dumps(config,indent=2),encoding='utf-8')
    env_path=ROOT/'analysis/.env.local'
    lines=env_path.read_text(encoding='utf-8-sig').splitlines()
    values={'TESTER_ACCESS_CODE':code,'TESTER_PUBLIC_ORIGIN':config['url'].rstrip('/')}
    lines=[line for line in lines if line.partition('=')[0].strip() not in values]
    lines.extend(key+'='+value for key,value in values.items())
    env_path.write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print('Tester configuration saved. Run configure_modal.py, then redeploy.')

if __name__=='__main__':main()
