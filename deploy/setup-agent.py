#!/usr/bin/env python3
"""Install isolated PM2; optionally add a user crontab boot entry, without sudo."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--boot', action='store_true', help='Add a user crontab @reboot hook (Linux, where permitted)')
args = parser.parse_args()

root = Path.home() / '.local/share/gpu-monitor'
root.mkdir(parents=True, exist_ok=True)
root.chmod(0o700)
config_path = root / 'agent-config.json'
config_path.chmod(0o600)
if (root / 'node/bin/node').exists():
    os.environ['PATH'] = str(root / 'node/bin') + ':' + os.environ.get('PATH', '')
node = shutil.which('node')
npm = shutil.which('npm')
if not node or not npm:
    raise SystemExit('Node.js and npm must be available on the user PATH')
system_python = shutil.which('python3')
python = str(root / 'venv/bin/python')
pm2 = root / 'runtime/node_modules/pm2/bin/pm2'
if not (root / 'venv/bin/pip').exists():
    subprocess.run([system_python, '-m', 'pip', 'install', '--target', str(root / 'bootstrap'), 'virtualenv'], check=True)
    subprocess.run([system_python, '-m', 'virtualenv', str(root / 'venv')], check=True,
                   env=dict(os.environ, PYTHONPATH=str(root / 'bootstrap')))
# Reconcile all pinned dependencies on upgrades.
subprocess.run([python, '-m', 'pip', 'install', '-r', str(root / 'requirements.txt')], check=True)
if not pm2.exists():
    subprocess.run([npm, 'install', '--prefix', str(root / 'runtime'), 'pm2@6', '--no-audit', '--no-fund'], check=True)
pm2_home = root / 'pm2'
pm2_home.mkdir(mode=0o700, exist_ok=True)
logs = root / 'logs'
logs.mkdir(mode=0o700, exist_ok=True)
eco = {'apps': [{'name': 'gpu-reporter', 'script': str(root / 'agent.py'), 'interpreter': python,
                'cwd': str(root), 'args': ['--config', str(config_path)],
                'autorestart': True, 'restart_delay': 5000, 'max_memory_restart': '200M',
                'out_file': str(logs / 'reporter-out.log'), 'error_file': str(logs / 'reporter-error.log'),
                'time': True, 'kill_timeout': 5000, 'env': {'PYTHONUNBUFFERED': '1'}}]}
eco_path = root / 'ecosystem.json'
eco_path.write_text(json.dumps(eco, indent=2) + '\n')
env = dict(os.environ, PM2_HOME=str(pm2_home))
subprocess.run([node, str(pm2), 'startOrRestart', str(eco_path)], check=True, env=env)
subprocess.run([node, str(pm2), 'save'], check=True, env=env)
if not args.boot:
    print('Installed user PM2 reporter. Boot hook not requested; existing hooks are unchanged.')
    raise SystemExit(0)
import shlex
startup = root / 'start-on-boot.sh'
startup.write_text('#!/bin/sh\n' +
                   'export PATH=' + shlex.quote(str(Path(node).parent) + ':/usr/local/bin:/usr/bin:/bin') + '\n' +
                   'export PM2_HOME=' + shlex.quote(str(pm2_home)) + '\n' +
                   'exec ' + shlex.quote(node) + ' ' + shlex.quote(str(pm2)) + ' resurrect\n')
startup.chmod(0o700)
previous = subprocess.run(['crontab', '-l'], capture_output=True, text=True)
if previous.returncode and 'no crontab' not in previous.stderr.lower():
    raise SystemExit('Cannot inspect user crontab: ' + previous.stderr)
lines = previous.stdout.splitlines()
marker = '# gpu-monitor-managed-boot'
lines = [line for line in lines if marker not in line]
lines.append('@reboot ' + shlex.quote(str(startup)) + ' >> ' + shlex.quote(str(logs / 'boot.log')) + ' 2>&1 ' + marker)
subprocess.run(['crontab', '-'], input='\n'.join(lines) + '\n', text=True, check=True)
print('Installed user PM2 reporter and @reboot recovery; no system files changed.')
