#!/usr/bin/env python3
"""Run the hub and optional Cloudflare tunnel under an isolated, user-owned PM2."""
import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--state', default=str(Path.home() / '.local/share/gpu-observatory-hub'))
tunnel = parser.add_mutually_exclusive_group()
tunnel.add_argument('--quick-tunnel', action='store_true')
tunnel.add_argument('--tunnel-config', help='Absolute path to a dedicated named-tunnel YAML config')
args = parser.parse_args()
root = Path(args.state).expanduser().resolve()
if len(os.fsencode(str(root / 'pm2/interactor.sock'))) > 100:
    raise SystemExit('State directory path is too long for PM2 Unix sockets; choose a shorter --state path')
source = Path(__file__).resolve().parents[1]
config_path = root / 'config.json'
config = json.loads(config_path.read_text())
node, npm = shutil.which('node'), shutil.which('npm')
if not node or not npm:
    raise SystemExit('Node.js 20+ and npm must be on PATH')
cloudflared = shutil.which('cloudflared') if args.quick_tunnel or args.tunnel_config else None
if (args.quick_tunnel or args.tunnel_config) and not cloudflared:
    raise SystemExit('Install cloudflared on the user PATH first')
if args.tunnel_config and not Path(args.tunnel_config).expanduser().is_file():
    raise SystemExit('Named tunnel configuration does not exist')
for folder in (root, root / 'pm2', root / 'logs'):
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    folder.chmod(0o700)
config_path.chmod(0o600)
pm2 = root / 'runtime/node_modules/pm2/bin/pm2'
if not pm2.exists():
    subprocess.run([npm, 'install', '--prefix', str(root / 'runtime'), 'pm2@6', '--ignore-scripts', '--no-audit', '--no-fund'], check=True)
apps = [{'name': 'gpu-dashboard', 'script': str(source / 'server.mjs'), 'interpreter': node,
         'cwd': str(source), 'env': {'GPU_MONITOR_CONFIG': str(config_path)},
         'autorestart': True, 'restart_delay': 3000, 'max_memory_restart': '300M'}]
if cloudflared:
    if args.quick_tunnel:
        # Explicit isolated config; leave existing Cloudflare deployments untouched.
        empty_config = root / 'quick-tunnel.yml'
        empty_config.write_text('{}\n')
        empty_config.chmod(0o600)
        tunnel_args = ['tunnel', '--config', str(empty_config), '--no-autoupdate', '--url', 'http://127.0.0.1:' + str(config.get('port', 8787))]
    else:
        tunnel_args = ['tunnel', '--config', str(Path(args.tunnel_config).expanduser().resolve()), '--no-autoupdate', 'run']
    apps.append({'name': 'gpu-tunnel', 'script': cloudflared, 'interpreter': 'none',
                 'args': tunnel_args, 'autorestart': True, 'restart_delay': 10000})
for app in apps:
    app.update({'time': True, 'out_file': str(root / 'logs' / (app['name'] + '-out.log')),
                'error_file': str(root / 'logs' / (app['name'] + '-error.log'))})
ecosystem = root / 'ecosystem.json'
ecosystem.write_text(json.dumps({'apps': apps}, indent=2) + '\n')
ecosystem.chmod(0o600)
helper = root / 'pm2.sh'
helper.write_text('#!/bin/sh\nexport PATH=' + shlex.quote(str(Path(node).parent) + ':/usr/local/bin:/usr/bin:/bin') + '\nexport PM2_HOME=' + shlex.quote(str(root / 'pm2')) + '\nexec ' + shlex.quote(node) + ' ' + shlex.quote(str(pm2)) + ' "$@"\n')
helper.chmod(0o700)
env = dict(os.environ, PM2_HOME=str(root / 'pm2'))
subprocess.run([node, str(pm2), 'startOrRestart', str(ecosystem), '--update-env'], env=env, check=True)
subprocess.run([node, str(pm2), 'save'], env=env, check=True)
print('Hub started under user PM2. No boot hooks or system services were changed.')
if args.quick_tunnel:
    print('Read gpu-tunnel logs for its random HTTPS URL; run manage.mjs set-origin, then restart ONLY gpu-dashboard.')
