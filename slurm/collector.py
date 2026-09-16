#!/usr/bin/env python3
"""Approved, read-only Slurm telemetry. No job submission or GPU access."""
import argparse
import getpass
import json
import os
import re
from pathlib import Path
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent
FIELDS = [('JobID', 128), ('UserName', 128), ('Partition', 96), ('State', 64),
          ('NumNodes', 16), ('NumCPUs', 16), ('MinMemory', 32), ('TimeUsed', 32),
          ('TimeLimit', 32), ('PriorityLong', 32), ('Reason', 256),
          ('tres-alloc', 512), ('tres-per-job', 256), ('PendingTime', 32)]
FORMAT = ','.join(f'{name}:{width}' + ('|' if i < len(FIELDS)-1 else '')
                  for i, (name, width) in enumerate(FIELDS))


def integer(value):
    try:
        n = int(value)
        return n if n >= 0 else None
    except (ValueError, TypeError):
        return None


def duration_seconds(value):
    match = re.fullmatch(r'(?:(\d+)-)?(\d+):(\d{1,2})(?::(\d{1,2}))?', value.strip())
    if not match or (match[1] is not None and match[4] is None):
        return None
    days, first, middle = int(match[1] or 0), int(match[2]), int(match[3])
    seconds = middle if match[4] is None else int(match[4])
    minutes = first if match[4] is None else middle
    hours = 0 if match[4] is None else first
    if seconds >= 60 or (match[4] is not None and minutes >= 60) or (match[1] is not None and hours >= 24):
        return None
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


def parse_jobs(output):
    jobs = []
    for line in output.splitlines():
        if not line.strip():
            continue
        p = [part.strip() for part in line.split('|')]
        if len(p) != len(FIELDS) or not p[0] or not p[3]:
            raise ValueError('Unexpected squeue output format')
        jobs.append(dict(zip(['jobId', 'username', 'partition', 'state', 'nodes', 'cpus',
                              'memory', 'elapsed', 'timeLimit', 'priority', 'reason',
                              'tres', 'tresPerJob', 'pendingSeconds'], p)))
        for field in ['nodes', 'cpus', 'priority', 'pendingSeconds']:
            jobs[-1][field] = integer(jobs[-1][field])
        jobs[-1]['elapsedSeconds'] = duration_seconds(jobs[-1]['elapsed'])
    return jobs


def parse_partitions(output):
    parts = []
    for line in output.splitlines():
        if not line.strip():
            continue
        p = [part.strip() for part in line.split('|')]
        if len(p) != 4 or integer(p[2]) is None:
            raise ValueError('Unexpected sinfo output format')
        parts.append({'name': p[0].rstrip('*'), 'availability': p[1], 'nodes': int(p[2]), 'state': p[3]})
    return parts


def query(args):
    # Ignore inherited display filters so the documented scope is reproducible.
    env = {k: v for k, v in os.environ.items() if not k.startswith('SQUEUE_')}
    env['LC_ALL'] = 'C'
    result = subprocess.run(args, capture_output=True, text=True, timeout=20, env=env)
    if result.returncode:
        raise RuntimeError(f'{Path(args[0]).name} exited {result.returncode}')
    if len(result.stdout) > 16 * 1024 * 1024:
        raise RuntimeError('Scheduler response exceeds collector limit')
    return result.stdout


def collect(config):
    started = time.monotonic()
    args = [config.get('squeuePath', '/usr/bin/squeue'), '--local', '--states=all', '--array',
            '--noheader', '--sort=-p,i', '--Format=' + FORMAT]
    if config.get('scope') == 'mine':
        args.append('--me')
    jobs = parse_jobs(query(args))
    queue_sampled_at = time.monotonic()
    counts = {'running': 0, 'pending': 0, 'other': 0, 'visible': len(jobs)}
    for j in jobs:
        counts['running' if j['state'] == 'RUNNING' else 'pending' if j['state'] == 'PENDING' else 'other'] += 1
    parts, warning = [], None
    try:
        parts = parse_partitions(query([config.get('sinfoPath', '/usr/bin/sinfo'), '--local',
                                       '--noheader', '--format=%P|%a|%D|%t']))
    except (subprocess.SubprocessError, RuntimeError, ValueError, OSError):
        warning = 'Partition status unavailable'
    return {'version': 1, 'sourceId': config['sourceId'], 'reportId': str(uuid.uuid4()),
            'collectedAt': int(time.time()*1000), 'hostname': socket.gethostname(),
            'collectorUser': getpass.getuser(), 'scope': config.get('scope', 'visible'),
            'visibility': config.get('visibility', 'account-visible'),
            'durationMs': round((time.monotonic()-started)*1000),
            'queueAgeMs': round((time.monotonic()-queue_sampled_at)*1000), 'jobs': jobs[:5000],
            'counts': counts, 'truncated': len(jobs) > 5000, 'partitions': parts,
            'error': None, 'warning': warning}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default=str(ROOT / 'config.json'))
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    if not config['url'].startswith('https://'):
        raise SystemExit('HTTPS is required')
    # Keep scheduler polling gentle; persistence is configured by the operator.
    interval = max(60, int(config.get('intervalSeconds', 60)))
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    opener = urllib.request.build_opener(NoRedirect())
    def stop(*_):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop)
    failures = 0
    reports = 0
    print(f'Slurm reporter started; interval={interval}s; scope={config.get("scope", "visible")}', flush=True)
    while True:
        started = time.monotonic()
        try:
            body = collect(config)
        except (subprocess.SubprocessError, RuntimeError, ValueError, OSError) as error:
            body = {'version': 1, 'sourceId': config['sourceId'], 'reportId': str(uuid.uuid4()),
                    'collectedAt': int(time.time()*1000), 'hostname': socket.gethostname(),
                    'collectorUser': getpass.getuser(), 'scope': config.get('scope', 'visible'),
                    'jobs': [], 'partitions': [], 'counts': {'running': 0, 'pending': 0, 'other': 0, 'visible': 0},
                    'error': f'Queue query failed ({type(error).__name__})'}
        request = urllib.request.Request(config['url'], data=json.dumps(body).encode(), method='POST', headers={
            'Content-Type': 'application/json', 'User-Agent': 'GPUObservatory-Slurm/1.0',
            'Authorization': 'Bearer ' + config['token'], 'X-Source-Id': config['sourceId']})
        try:
            with opener.open(request, timeout=20) as response:
                if response.status != 200:
                    raise RuntimeError('Unexpected response')
            reports += 1
            if reports == 1 or failures or body['error'] or reports % 60 == 0:
                print(f'report accepted; visible={body["counts"]["visible"]}; collection={"error" if body["error"] else "ok"}', flush=True)
            failures = 0
            if args.once:
                raise SystemExit(1 if body['error'] else 0)
        except (urllib.error.URLError, RuntimeError, OSError) as error:
            failures += 1
            print(f'report failed; status={getattr(error, "code", type(error).__name__)}; attempt={failures}', flush=True)
            if args.once:
                raise SystemExit(1)
        wait = min(600, interval * (2 ** min(failures, 3))) if failures else interval
        time.sleep(max(1, wait-(time.monotonic()-started)))


if __name__ == '__main__':
    main()
