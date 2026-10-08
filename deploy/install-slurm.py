#!/usr/bin/env python3
"""Rendered by the hub for a short-lived Slurm enrollment link. Run as an ordinary user."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

SETTINGS = json.loads(__SETTINGS_JSON__)
FILES = {'collector.py', 'setup-runtime.py'}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def request_json(origin, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(origin + path, data=data, headers={'Content-Type': 'application/json', 'User-Agent': 'gpu-observatory-slurm-installer/1.0'})
    with urllib.request.build_opener(NoRedirect()).open(req, timeout=30) as response:
        content = response.read(2 * 1024 * 1024 + 1)
        if len(content) > 2 * 1024 * 1024:
            raise RuntimeError('Hub response exceeds size limit')
        return json.loads(content)

def validate_origin(origin):
    parsed = urllib.parse.urlsplit(origin)
    if parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise RuntimeError('A plain HTTPS hub origin is required')

def prepare_files(root, package):
    files = package.get('files', {})
    if set(files) != FILES:
        raise RuntimeError('Unexpected Slurm package manifest')
    for name, item in files.items():
        if hashlib.sha256(item['content'].encode()).hexdigest() != item['sha256']:
            raise RuntimeError('Slurm package checksum mismatch')
    for name, item in files.items():
        (root / name).write_text(item['content'])
        (root / name).chmod(0o600)

def main():
    os.umask(0o077)
    origin, source_id = SETTINGS['origin'], SETTINGS['sourceId']
    validate_origin(origin)
    if platform.system() != 'Linux' or sys.version_info < (3, 10):
        raise RuntimeError('Linux with Python 3.10+ is required')
    if os.geteuid() == 0:
        raise RuntimeError('Run as your normal user, without sudo or root')
    for tool in ['squeue', 'sinfo']:
        if not shutil.which(tool):
            raise RuntimeError('Run this on a Slurm login node: ' + tool + ' is not on PATH')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', source_id):
        raise RuntimeError('Invalid Slurm source identity')
    installation = hashlib.sha256((origin + '/' + source_id).encode()).hexdigest()[:16]
    root = Path.home() / '.local/share/slurm-agents' / installation
    if len(os.fsencode(str(root / 'pm2/interactor.sock'))) > 100:
        raise RuntimeError('Home path is too long for PM2 sockets; use a shorter home directory')
    if root.is_symlink():
        raise RuntimeError('Refusing a symlink installation directory')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root.chmod(0o700)
    config_path = root / 'config.json'
    existing = json.loads(config_path.read_text()) if config_path.exists() else None
    if existing and (existing.get('sourceId') != source_id or existing.get('url') != origin + '/api/slurm/ingest'):
        raise RuntimeError('Existing installation points elsewhere; refusing to replace it')
    prepare_files(root, request_json(origin, '/api/slurm-package'))
    enrollment = request_json(origin, '/api/slurm-enroll', {'token': SETTINGS['token']})
    if enrollment.get('sourceId') != source_id:
        raise RuntimeError('Enrollment returned an unexpected source identity')
    config = {'sourceId': source_id, 'url': enrollment['url'], 'token': enrollment['token'],
              'scope': enrollment.get('scope', 'mine'), 'visibility': enrollment.get('visibility', 'account-visible'),
              'intervalSeconds': enrollment.get('intervalSeconds', 60),
              'squeuePath': enrollment.get('squeuePath', '/usr/bin/squeue'),
              'sinfoPath': enrollment.get('sinfoPath', '/usr/bin/sinfo'),
              'ssharePath': enrollment.get('ssharePath', '/usr/bin/sshare')}
    config_path.write_text(json.dumps(config, indent=2) + '\n')
    config_path.chmod(0o600)
    env = dict(os.environ, SLURM_MONITOR_ROOT=str(root), SLURM_PYTHON=sys.executable)
    subprocess.run([sys.executable, str(root / 'setup-runtime.py')], check=True, env=env)
    print('Installed and started the Slurm reporter for ' + source_id + '. It will appear online within one collection interval.')

if __name__ == '__main__':
    main()
