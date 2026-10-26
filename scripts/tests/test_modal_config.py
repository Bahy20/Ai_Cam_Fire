import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from configure_modal import secret_values
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

    def test_remote_config_requires_https_origin(self):
        for url in ['http://example.com','https://user:pass@example.com','https://example.com/path','https://example.com?token=x']:
            with self.assertRaises(ValueError):remote_config(url,'service')
        self.assertEqual(remote_config('https://example.com/','service')['ANALYSIS_WS_URL'],'wss://example.com/v1/live')

if __name__=='__main__':unittest.main()
