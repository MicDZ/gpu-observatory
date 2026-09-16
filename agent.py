#!/usr/bin/env python3
"""Read-only GPU, CPU and RAM snapshots; one HTTPS report every five seconds."""
import argparse
import json
import math
import os
from pathlib import Path
import random
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'vendor'))


def number(value):
    return value if isinstance(value, (int, float)) and math.isfinite(value) and 0 <= value < 1e10 else None


def collect():
    import gpustat
    stats = gpustat.new_query().jsonify()
    gpus = []
    for gpu in stats['gpus']:
        processes = gpu.get('processes')
        gpus.append({
            'uuid': gpu['uuid'], 'index': gpu['index'], 'name': gpu['name'],
            'utilization': number(gpu.get('utilization.gpu')),
            'memoryUsed': number(gpu.get('memory.used')), 'memoryTotal': number(gpu.get('memory.total')),
            'temperature': number(gpu.get('temperature.gpu')),
            'powerDraw': number(gpu.get('power.draw')), 'powerLimit': number(gpu.get('enforced.power.limit')),
            'processesAvailable': isinstance(processes, list),
            'processes': [{
                'pid': p['pid'], 'username': p.get('username'),
                # Deliberately do not upload complete argv, which can contain secrets.
                'command': p.get('command'), 'gpuMemory': number(p.get('gpu_memory_usage'))
            } for p in processes] if isinstance(processes, list) else [],
        })
    return {'version': 1, 'agentVersion': '1.1.0', 'collectedAt': int(time.time() * 1000),
            'hostname': socket.gethostname(), 'driverVersion': stats.get('driver_version'), 'gpus': gpus, 'error': None}


def sample():
    # Bound NVML collection time; a stuck driver must not hide agent health forever.
    try:
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--collect'],
                                capture_output=True, timeout=12, text=True, check=True)
        return json.loads(result.stdout)
    except (subprocess.SubprocessError, ValueError, OSError):
        return {'version': 1, 'agentVersion': '1.1.0', 'collectedAt': int(time.time() * 1000),
                'hostname': socket.gethostname(), 'gpus': [], 'error': 'GPU collection failed; check agent or driver'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default=str(ROOT / 'agent-config.json'))
    parser.add_argument('--collect', action='store_true')
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    if args.collect:
        print(json.dumps(collect(), allow_nan=False))
        return
    with open(args.config) as f:
        config = json.load(f)
    url = config['url']
    if not url.startswith('https://'):
        raise SystemExit('An HTTPS endpoint is required')
    # Do not forward bearer credentials across HTTP redirects.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    opener = urllib.request.build_opener(NoRedirect())
    from system_sampler import SystemSampler
    system_sampler = None
    interval = max(5, int(config.get('interval', 5)))
    failures = 0
    reports = 0
    def stop(*_):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop)
    print('GPU agent started; host=' + config['hostId'], flush=True)
    while True:
        started = time.monotonic()
        payload = sample()
        try:
            if system_sampler is None:
                system_sampler = SystemSampler()
            payload['system'] = system_sampler.sample()
        except Exception as error:
            # CPU/RAM failure must not suppress valid GPU metrics, or vice versa.
            payload['system'] = {'error': 'System collection failed (' + type(error).__name__ + ')'}
            system_sampler = None
        payload['hostId'] = config['hostId']
        payload['reportId'] = str(uuid.uuid4())
        request = urllib.request.Request(url, data=json.dumps(payload, allow_nan=False).encode(), method='POST', headers={
            'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config['token'],
            'X-Host-Id': config['hostId'], 'User-Agent': 'gpu-monitor-agent/1.1.0',
        })
        try:
            with opener.open(request, timeout=15) as response:
                if response.status != 200:
                    raise RuntimeError('Unexpected status')
            reports += 1
            if reports == 1 or failures or reports % 720 == 0:
                print(f'report accepted; GPUs={len(payload["gpus"])}; processes={sum(len(g["processes"]) for g in payload["gpus"])}; collection={"error" if payload["error"] else "ok"}; system={"error" if payload["system"].get("error") else "ok"}', flush=True)
            failures = 0
            if args.once:
                raise SystemExit(1 if payload['error'] else 0)
        except (urllib.error.URLError, OSError, RuntimeError) as error:
            failures += 1
            status = getattr(error, 'code', type(error).__name__)
            print(f'report failed; status={status}; attempt={failures}; retrying with backoff', flush=True)
            if args.once:
                raise SystemExit(1)
        delay = min(60, interval * (2 ** min(failures, 4))) if failures else interval
        time.sleep(max(0.1, delay - (time.monotonic() - started)) + (random.random() if failures else 0))


if __name__ == '__main__':
    main()
