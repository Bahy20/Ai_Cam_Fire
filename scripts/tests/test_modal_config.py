import ast
import contextlib
import io
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import configure_modal
from configure_modal import credentials,native_secret_values,secret_values
from run_camera_modal import remote_config

class ModalConfigTests(unittest.TestCase):
    def test_removed_camera_permission_explicitly_clears_remote_secret(self):
        values=secret_values({'CF_ACCOUNT_ID':'account','CF_API_TOKEN':'test'},'service')
        self.assertEqual(values['EXPECTED_LIGHTER_CAMERAS'],'')
        self.assertEqual(values['HAZARDOUS_CAMERAS'],'')
        self.assertEqual(values['CLOUDFLARE_API_TOKEN'],'')

    def test_minicpm_requires_no_cloudflare_credentials(self):
        values=secret_values({},'service')
        self.assertEqual(values['CLOUDFLARE_API_TOKEN'],'')
        values=secret_values({},'service',infrastructure_only=True)
        self.assertEqual(values['CLOUDFLARE_API_TOKEN'],'')

    def test_gateway_secret_carries_the_cookie_secret_and_not_the_native_token(self):
        values=secret_values({'FIREGUARD_NATIVE_TOKEN':'gpu'},'service',cookie_secret='jar')
        self.assertEqual((values['FIREGUARD_TOKEN'],values['FIREGUARD_COOKIE_SECRET']),('service','jar'))
        self.assertNotIn('FIREGUARD_NATIVE_TOKEN',values)
        self.assertEqual(native_secret_values('gpu'),{'FIREGUARD_NATIVE_TOKEN':'gpu'})

    def test_credentials_reuse_saved_values_and_generate_distinct_missing_ones(self):
        saved={'token':'svc','native_token':'gpu','cookie_secret':'jar'}
        self.assertEqual(credentials(saved,{'FIREGUARD_NATIVE_TOKEN':'other'}),saved)
        fresh=credentials({'token':'svc'},{})
        self.assertEqual(fresh['token'],'svc')
        self.assertEqual(len({fresh['token'],fresh['native_token'],fresh['cookie_secret']}),3)
        self.assertGreaterEqual(min(len(fresh['native_token']),len(fresh['cookie_secret'])),43)

    def test_main_provisions_both_secrets_saves_credentials_and_prints_none(self):
        calls=[]
        class Secret:
            objects=types.SimpleNamespace(create=lambda name,values,allow_existing:calls.append(('create',name,dict(values))))
            @staticmethod
            def from_name(name):return types.SimpleNamespace(update=lambda values:calls.append(('update',name,dict(values))))
        with tempfile.TemporaryDirectory() as folder:
            client=Path(folder)/'.modal-client.json';client.write_text(json.dumps({'url':'https://x.example','token':'svc','tester_code':'code'}))
            out=io.StringIO()
            with mock.patch.dict(sys.modules,{'modal':types.SimpleNamespace(Secret=Secret)}),mock.patch.object(configure_modal,'CLIENT',client),\
                 mock.patch.object(configure_modal,'load_environment',return_value={'TESTER_ACCESS_CODE':'code'}),\
                 mock.patch.object(sys,'argv',['configure_modal.py']),contextlib.redirect_stdout(out):
                configure_modal.main()
            saved=json.loads(client.read_text())
        self.assertEqual((saved['url'],saved['token'],saved['tester_code']),('https://x.example','svc','code'))
        native={'FIREGUARD_NATIVE_TOKEN':saved['native_token']}
        self.assertEqual([call[:2] for call in calls],[('create','fireguard-analysis-config'),('update','fireguard-analysis-config'),
                                                       ('create','fireguard-native-config'),('update','fireguard-native-config')])
        self.assertEqual(calls[3][2],native)
        self.assertEqual((calls[1][2]['FIREGUARD_TOKEN'],calls[1][2]['FIREGUARD_COOKIE_SECRET']),('svc',saved['cookie_secret']))
        for value in (saved['token'],saved['native_token'],saved['cookie_secret']):self.assertNotIn(value,out.getvalue())

    def test_native_gpu_class_receives_only_the_native_secret(self):
        tree=ast.parse((Path(__file__).resolve().parents[2]/'deploy/modal_app.py').read_text(encoding='utf-8'))
        def secrets_of(name):
            cls=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name==name)
            keyword=next(k for d in cls.decorator_list if isinstance(d,ast.Call) for k in d.keywords if k.arg=='secrets')
            return [element.id for element in keyword.value.elts],ast.unparse(cls)
        names,source=secrets_of('NativeLive')
        self.assertEqual(names,['native_secret'])
        self.assertIn("os.environ['FIREGUARD_NATIVE_TOKEN']",source)
        self.assertNotIn('FIREGUARD_TOKEN',source)
        self.assertEqual(secrets_of('Analysis')[0],['secret','native_secret'])

    def test_remote_config_requires_https_origin(self):
        for url in ['http://example.com','https://user:pass@example.com','https://example.com/path','https://example.com?token=x']:
            with self.assertRaises(ValueError):remote_config(url,'service')
        self.assertEqual(remote_config('https://example.com/','service')['ANALYSIS_WS_URL'],'wss://example.com/v1/live')

if __name__=='__main__':unittest.main()
