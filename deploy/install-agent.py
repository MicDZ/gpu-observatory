#!/usr/bin/env python3
"""Rendered by the hub for a short-lived enrollment link. Run as an ordinary user."""
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
FILES = {'agent.py', 'system_sampler.py', 'requirements.txt', 'setup-agent.py', 'setup-node.py'}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def request_json(origin, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(origin + path, data=data, headers={'Content-Type': 'application/json'})
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
        raise RuntimeError('Unexpected agent package manifest')
    # Verify every file before writing any of them; never extract arbitrary archive paths.
    for name, item in files.items():
        if hashlib.sha256(item['content'].encode()).hexdigest() != item['sha256']:
            raise RuntimeError('Agent package checksum mismatch')
    for name, item in files.items():
        (root / name).write_text(item['content'])
        (root / name).chmod(0o600)

def main():
    os.umask(0o077)
    origin, host_id = SETTINGS['origin'], SETTINGS['hostId']
    validate_origin(origin)
    if platform.system() != 'Linux' or sys.version_info < (3, 10):
        raise RuntimeError('Linux with Python 3.10+ is required')
    if os.geteuid() == 0:
        raise RuntimeError('Run as your normal user, without sudo or root')
    if not shutil.which('nvidia-smi'):
        raise RuntimeError('Install/enable the NVIDIA driver first; nvidia-smi is not on PATH')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', host_id):
        raise RuntimeError('Invalid device identity')
    # Separate every hub/device installation from any existing legacy reporter.
    installation = hashlib.sha256((origin + '/' + host_id).encode()).hexdigest()[:16]
    root = Path.home() / '.local/share/gpu-agents' / installation
    if len(os.fsencode(str(root / 'pm2/interactor.sock'))) > 100:
        raise RuntimeError('Home path is too long for PM2 sockets; use the documented manual deployment with a short directory')
    if root.is_symlink():
        raise RuntimeError('Refusing a symlink installation directory')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root.chmod(0o700)
    config_path = root / 'agent-config.json'
    if config_path.exists():
        previous = json.loads(config_path.read_text())
        if previous.get('hostId') != host_id or previous.get('url') != origin + '/api/ingest':
            raise RuntimeError('Existing installation points elsewhere; refusing to replace it')
    prepare_files(root, request_json(origin, '/api/agent-package'))
    env = dict(os.environ, GPU_MONITOR_ROOT=str(root))
    node = shutil.which('node')
    compatible = False
    if node and shutil.which('npm'):
        version = subprocess.run([node, '--version'], capture_output=True, text=True, check=True).stdout.strip()
        compatible = int(version.lstrip('v').split('.')[0]) >= 20
    if not compatible and not (root / 'node/bin/node').exists():
        subprocess.run([sys.executable, str(root / 'setup-node.py')], env=env, check=True)
    # Complete slow dependency installation before consuming the one-time ticket.
    subprocess.run([sys.executable, str(root / 'setup-agent.py'), '--prepare'], env=env, check=True)
    config = request_json(origin, '/api/enroll', {'token': SETTINGS['token']})
    if config.get('hostId') != host_id or config.get('url') != origin + '/api/ingest' or not isinstance(config.get('token'), str):
        raise RuntimeError('Unexpected enrollment response')
    temp = root / 'agent-config.json.tmp'
    temp.write_text(json.dumps(config, indent=2) + '\n')
    temp.chmod(0o600)
    temp.replace(config_path)
    print('Enrollment saved privately. If startup fails, rerun setup-agent.py with GPU_MONITOR_ROOT set to this directory: ' + str(root), flush=True)
    command = [sys.executable, str(root / 'setup-agent.py')]
    if SETTINGS.get('boot'):
        command.append('--boot')
    subprocess.run(command, env=env, check=True)
    print('Installed. Return to My devices and wait for the first report. No credential values were printed.')

if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as error:
        print('Installation failed: hub HTTP status ' + str(error.code) + '. Generate a new link if it expired or was already used.', file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        # Request URLs and payloads can carry credentials; keep generic network errors private.
        print('Installation failed: ' + (str(error) if isinstance(error, RuntimeError) else type(error).__name__) + '. Check prerequisites or generate a new link in My devices.', file=sys.stderr)
        sys.exit(1)
