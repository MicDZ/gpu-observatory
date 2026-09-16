#!/usr/bin/env python3
"""User-local prebuilt runtime. No system configuration or boot hooks."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import subprocess
import urllib.request

root = Path.home() / '.local/share/slurm-monitor'
root.mkdir(parents=True, exist_ok=True)
root.chmod(0o700)
node = root / 'node/bin/node'
if not node.exists():
    arch = {'x86_64': 'x64', 'aarch64': 'arm64'}[platform.machine()]
    base = 'https://nodejs.org/dist/latest-v22.x/'
    sums = urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=30).read().decode()
    match = re.search(r'^([a-f0-9]{64})\s+(node-v22\.[0-9.]+-linux-' + arch + r'\.tar\.xz)$', sums, re.M)
    if not match:
        raise SystemExit('No matching official runtime checksum')
    expected, name = match.groups()
    archive = root / name
    with urllib.request.urlopen(base + name, timeout=60) as response, archive.open('wb') as f:
        while chunk := response.read(1024*1024):
            f.write(chunk)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
        raise SystemExit('Runtime checksum mismatch')
    (root / 'node').mkdir(exist_ok=True)
    subprocess.run(['tar','-xJf',str(archive),'--strip-components=1','-C',str(root/'node')],check=True)
env = dict(os.environ, PATH=str(root/'node/bin')+':'+os.environ.get('PATH',''), PM2_HOME=str(root/'pm2'))
pm2 = root / 'runtime/node_modules/pm2/bin/pm2'
if not pm2.exists():
    subprocess.run([str(root/'node/bin/npm'),'install','--prefix',str(root/'runtime'),'pm2@6',
                    '--ignore-scripts','--no-audit','--no-fund'],env=env,check=True)
for path in [root/'logs',root/'pm2']:
    path.mkdir(mode=0o700,exist_ok=True)
config = root/'config.json'
config.chmod(0o600)
ecosystem = {'apps':[{'name':'slurm-reporter','script':str(root/'collector.py'),'interpreter':'/usr/bin/python3',
 'args':['--config',str(config)],'cwd':str(root),'autorestart':True,'restart_delay':60000,
 'max_memory_restart':'150M','kill_timeout':5000,'time':True,
 'out_file':str(root/'logs/reporter-out.log'),'error_file':str(root/'logs/reporter-error.log'),
 'env':{'PYTHONUNBUFFERED':'1'}}]}
(root/'ecosystem.json').write_text(json.dumps(ecosystem,indent=2)+'\n')
helper = root/'pm2.sh'
helper.write_text('#!/bin/sh\nexport PATH='+shlex.quote(str(root/'node/bin')+':/usr/bin:/bin')+'\nexport PM2_HOME='+shlex.quote(str(root/'pm2'))+'\nexec '+shlex.quote(str(node))+' '+shlex.quote(str(pm2))+' "$@"\n')
helper.chmod(0o700)
print('User-local runtime and PM2 configuration prepared. No linger, cron, systemd, or shell-startup changes made.')
