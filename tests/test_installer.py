import hashlib
import contextlib
import io
import os
import json
from pathlib import Path
import runpy
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

INSTALLER = Path(__file__).resolve().parents[1] / 'deploy/install-agent.py'

class InstallerTests(unittest.TestCase):
    def load(self, settings=None):
        scope = runpy.run_path(str(INSTALLER), init_globals={'__SETTINGS_JSON__': json.dumps(settings or {})})
        return scope, scope['main'].__globals__

    def test_rejects_unsafe_origins_and_package_paths(self):
        scope, _ = self.load()
        for origin in ['http://example.com', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com#token']:
            with self.assertRaises(RuntimeError): scope['validate_origin'](origin)
        scope['validate_origin']('https://monitor.example.com')
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(RuntimeError): scope['prepare_files'](Path(tmp), {'files': {'../escape': {}}})
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_dependencies_precede_one_time_claim_and_credentials_are_private(self):
        settings={'origin':'https://monitor.example.com','hostId':'gpu-'+'a'*24,'token':'fictional-install-ticket','boot':False}
        scope, g = self.load(settings)
        files={name:{'content':'# fixture\n','sha256':hashlib.sha256(b'# fixture\n').hexdigest()} for name in scope['FILES']}
        events=[]
        def request(origin,path,body=None):
            events.append(path)
            if path=='/api/agent-package':return {'files':files}
            self.assertIn('prepare',events)
            self.assertEqual(body,{'token':settings['token']})
            return {'hostId':settings['hostId'],'url':settings['origin']+'/api/ingest','token':'fictional-reporter-credential','interval':5}
        def run(command,**kwargs):
            if '--version' in command:return SimpleNamespace(stdout='v22.0.0\n')
            events.append('prepare' if '--prepare' in command else 'start')
            self.assertNotIn(settings['token'],command)
            self.assertNotIn('--boot',command)
            return SimpleNamespace(returncode=0)
        g['request_json']=request
        with tempfile.TemporaryDirectory(dir='/tmp',prefix='go-') as tmp, patch('pathlib.Path.home',return_value=Path(tmp)), patch('platform.system',return_value='Linux'), patch('os.geteuid',return_value=1000), patch('shutil.which',side_effect=lambda name:'/usr/bin/'+name), patch('subprocess.run',side_effect=run), patch('sys.version_info',(3,11)):
            scope['main']()
            config=list(Path(tmp).rglob('agent-config.json'))[0]
            self.assertEqual(config.stat().st_mode & 0o777,0o600)
            self.assertEqual(json.loads(config.read_text())['token'],'fictional-reporter-credential')
            self.assertEqual(events,['/api/agent-package','prepare','/api/enroll','start'])

    def test_legacy_boot_update_preserves_other_device_hooks(self):
        with tempfile.TemporaryDirectory(dir='/tmp',prefix='go-') as tmp:
            root=Path(tmp)/'.local/share/gpu-monitor'
            root.mkdir(parents=True)
            (root/'agent-config.json').write_text('{}')
            previous='@reboot old # gpu-monitor-managed-boot\n@reboot other # gpu-monitor-managed-boot-abcdef\n0 * * * * unrelated\n'
            installed=[]
            def run(command,**kwargs):
                if command==['crontab','-l']:return SimpleNamespace(returncode=0,stdout=previous,stderr='')
                if command==['crontab','-']:installed.append(kwargs['input'])
                return SimpleNamespace(returncode=0)
            with patch.dict(os.environ,{'GPU_MONITOR_ROOT':str(root)}), patch('pathlib.Path.home',return_value=Path(tmp)), patch('shutil.which',side_effect=lambda name:'/usr/bin/'+name), patch('subprocess.run',side_effect=run), patch('sys.argv',['setup-agent.py','--boot']), contextlib.redirect_stdout(io.StringIO()):
                runpy.run_path(str(INSTALLER.with_name('setup-agent.py')),run_name='__main__')
            self.assertIn('@reboot other # gpu-monitor-managed-boot-abcdef',installed[0])
            self.assertIn('0 * * * * unrelated',installed[0])
            self.assertNotIn('@reboot old ',installed[0])
            self.assertEqual(sum(line.endswith(' # gpu-monitor-managed-boot') for line in installed[0].splitlines()),1)

    def test_corrupt_package_is_rejected_before_writing(self):
        scope,_=self.load()
        files={name:{'content':'valid','sha256':hashlib.sha256(b'valid').hexdigest()} for name in scope['FILES']}
        files['agent.py']['content']='modified'
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(RuntimeError):scope['prepare_files'](Path(tmp),{'files':files})
            self.assertEqual(list(Path(tmp).iterdir()),[])

if __name__=='__main__': unittest.main()
