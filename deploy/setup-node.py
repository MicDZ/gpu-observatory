#!/usr/bin/env python3
"""Install a checksum-verified Node 22 binary in the user's monitor directory."""
import hashlib
from pathlib import Path
import platform
import re
import subprocess
import urllib.request

root = Path.home() / '.local/share/gpu-monitor'
root.mkdir(parents=True, exist_ok=True)
arch = {'x86_64': 'x64', 'aarch64': 'arm64'}[platform.machine()]
base = 'https://nodejs.org/dist/latest-v22.x/'
checksums = urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=30).read().decode()
match = re.search(r'^([a-f0-9]{64})\s+(node-v22\.[0-9.]+-linux-' + arch + r'\.tar\.xz)$', checksums, re.M)
if not match:
    raise SystemExit('Cannot find official Node 22 checksum')
expected, filename = match.groups()
archive = root / filename
with urllib.request.urlopen(base + filename, timeout=60) as response, archive.open('wb') as f:
    while True:
        chunk = response.read(1024 * 1024)
        if not chunk:
            break
        f.write(chunk)
if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
    raise SystemExit('Node archive checksum mismatch')
(root / 'node').mkdir(exist_ok=True)
subprocess.run(['tar', '-xJf', str(archive), '--strip-components=1', '-C', str(root / 'node')], check=True)
archive.unlink()
subprocess.run([str(root / 'node/bin/node'), '--version'], check=True)
