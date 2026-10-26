"""Provision FireGuard's named secret without placing credentials on command lines."""
import argparse
import json
import secrets
from pathlib import Path
from run_two_server import load_environment, ROOT

CLIENT = ROOT/'analysis/.modal-client.json'

def secret_values(env,token,infrastructure_only=False):
    # update() merges keys: explicit empty values revoke old credentials/policy.
    return {'FIREGUARD_TOKEN':token,'CLOUDFLARE_ACCOUNT_ID':'','CLOUDFLARE_API_TOKEN':'',
            'EXPECTED_LIGHTER_CAMERAS':env.get('EXPECTED_LIGHTER_CAMERAS',''),
            'TESTER_ACCESS_CODE':env.get('TESTER_ACCESS_CODE',''),
            'TESTER_PUBLIC_ORIGIN':env.get('TESTER_PUBLIC_ORIGIN',''),
            'HAZARDOUS_CAMERAS':env.get('HAZARDOUS_CAMERAS','')}

def main():
    import modal
    parser=argparse.ArgumentParser()
    parser.add_argument('--infrastructure-only',action='store_true',help='Deprecated compatibility option; MiniCPM needs no Cloudflare credentials')
    args=parser.parse_args()
    env=load_environment()
    saved=json.loads(CLIENT.read_text()) if CLIENT.exists() else {}
    token=saved.get('token') or env.get('FIREGUARD_TOKEN') or secrets.token_urlsafe(32)
    values=secret_values(env,token,args.infrastructure_only)
    # Save first so a network error cannot orphan the randomly generated client token.
    CLIENT.write_text(json.dumps({**saved,'token':token},indent=2),encoding='utf-8')
    modal.Secret.objects.create('fireguard-analysis-config',values,allow_existing=True)
    modal.Secret.from_name('fireguard-analysis-config').update(values)
    print('Modal configuration saved. Visual provider: MiniCPM on Modal; Cloudflare credentials cleared from this service.')

if __name__=='__main__':main()
