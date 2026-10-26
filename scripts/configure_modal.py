"""Provision FireGuard's named secrets without placing credentials on command lines or in output."""
import argparse
import json
import secrets
from pathlib import Path
from run_two_server import load_environment, ROOT

CLIENT = ROOT/'analysis/.modal-client.json'

def credentials(saved,env):
    # Reuse saved values: a new service token breaks existing clients and a new cookie secret signs every tester out.
    return {'token':saved.get('token') or env.get('FIREGUARD_TOKEN') or secrets.token_urlsafe(32),
            'native_token':saved.get('native_token') or env.get('FIREGUARD_NATIVE_TOKEN') or secrets.token_urlsafe(32),
            'cookie_secret':saved.get('cookie_secret') or env.get('FIREGUARD_COOKIE_SECRET') or secrets.token_urlsafe(32)}

def native_secret_values(native_token):
    # The only key the native GPU service receives.
    return {'FIREGUARD_NATIVE_TOKEN':native_token}

def secret_values(env,token,infrastructure_only=False,cookie_secret=''):
    # update() merges keys: explicit empty values revoke old credentials/policy.
    return {'FIREGUARD_TOKEN':token,'FIREGUARD_COOKIE_SECRET':cookie_secret,'CLOUDFLARE_ACCOUNT_ID':'','CLOUDFLARE_API_TOKEN':'',
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
    creds=credentials(saved,env)
    values=secret_values(env,creds['token'],args.infrastructure_only,cookie_secret=creds['cookie_secret'])
    # Save first so a network error cannot orphan randomly generated credentials.
    CLIENT.write_text(json.dumps({**saved,**creds},indent=2),encoding='utf-8')
    for name,named in (('fireguard-analysis-config',values),('fireguard-native-config',native_secret_values(creds['native_token']))):
        modal.Secret.objects.create(name,named,allow_existing=True)
        modal.Secret.from_name(name).update(named)
    print('Modal secrets fireguard-analysis-config and fireguard-native-config saved. Visual provider: MiniCPM on Modal; Cloudflare credentials cleared from this service.')

if __name__=='__main__':main()
