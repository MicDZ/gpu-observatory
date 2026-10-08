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
FIELDS = [('JobID', 128), ('ArrayTaskID', 16), ('UserName', 128), ('Partition', 96), ('State', 64),
          ('NumNodes', 16), ('NumCPUs', 16), ('MinMemory', 32), ('TimeUsed', 32),
          ('TimeLimit', 32), ('PriorityLong', 32), ('Reason', 256),
          ('tres-alloc', 512), ('tres-per-job', 256), ('PendingTime', 32)]
FORMAT = ','.join(f'{name}:{width}' + ('|' if i < len(FIELDS)-1 else '')
                  for i, (name, width) in enumerate(FIELDS))
# Per-user association data straight from slurmctld, so it works without slurmdbd.
SSHARE_FIELDS = ['Account', 'User', 'RawShares', 'NormShares', 'RawUsage', 'EffectvUsage',
                 'FairShare', 'LevelFS', 'TRESRunMins']
SSHARE_FORMAT = ','.join(SSHARE_FIELDS)
TRES = re.compile(r'([A-Za-z0-9_./-]+)=([^,]+)')
MAX_USERS = 2000


def integer(value):
    try:
        n = int(value)
        return n if n >= 0 else None
    except (ValueError, TypeError):
        return None


def real(value):
    try:
        n = float(value)
    except (ValueError, TypeError):
        return None
    return n if n == n and n not in (float('inf'), float('-inf')) and n >= 0 else None


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
        if len(p) != len(FIELDS) or not p[0] or not p[2] or not p[3] or not p[4]:
            raise ValueError('Unexpected squeue output format')
        job = dict(zip(['jobId', 'arrayTaskId', 'username', 'partition', 'state', 'nodes', 'cpus',
                        'memory', 'elapsed', 'timeLimit', 'priority', 'reason',
                        'tres', 'tresPerJob', 'pendingSeconds'], p))
        task_id = job.pop('arrayTaskId')
        # Slurm reports one row per array task with the same base JobID. Keep each
        # task distinct so the hub's duplicate-ID guard does not reject the queue.
        if task_id and task_id.upper() != 'N/A' and not job['jobId'].endswith(('_' + task_id, '[' + task_id + ']')):
            job['jobId'] = job['jobId'] + '_' + task_id
        for field in ['nodes', 'cpus', 'priority', 'pendingSeconds']:
            job[field] = integer(job[field])
        job['elapsedSeconds'] = duration_seconds(job['elapsed'])
        jobs.append(job)
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


def parse_tres(value):
    """Parse a Slurm TRES string such as 'cpu=8,gres/gpu=2,mem=32G'."""
    return {name: text for name, text in TRES.findall(value or '')}


def parse_sshare(output):
    """Per-user FairShare rows from `sshare -a -U -P -n --format=...`."""
    users = {}
    for line in output.splitlines():
        if not line.strip():
            continue
        p = [part.strip() for part in line.split('|')]
        if len(p) != len(SSHARE_FIELDS):
            raise ValueError('Unexpected sshare output format')
        account, username = p[0], p[1]
        if not username:
            continue
        tres = parse_tres(p[8])
        record = {'username': username, 'account': account, 'shares': integer(p[2]),
                  'normShares': real(p[3]), 'rawUsage': real(p[4]), 'effectvUsage': real(p[5]),
                  'fairshare': real(p[6]), 'levelFs': real(p[7]),
                  'runGpuMinutes': real(tres.get('gres/gpu')), 'runCpuMinutes': real(tres.get('cpu'))}
        # A user may own associations in several accounts; keep the busiest so the
        # displayed account is the one actually driving the FairShare usage.
        previous = users.get(username)
        if previous is None or (record['rawUsage'] or 0) > (previous['rawUsage'] or 0):
            users[username] = record
    return list(users.values())


def running_usage(jobs):
    """Current allocation per user, derived from the existing queue snapshot."""
    running = {}
    for job in jobs:
        if job.get('state') != 'RUNNING':
            continue
        entry = running.setdefault(job.get('username') or '', {'runningJobs': 0, 'runningCpus': 0, 'runningGpus': 0})
        entry['runningJobs'] += 1
        entry['runningCpus'] += integer(job.get('cpus')) or 0
        entry['runningGpus'] += integer(parse_tres(job.get('tres')).get('gres/gpu')) or 0
    return running


def build_users(config, jobs):
    args = [config.get('ssharePath', '/usr/bin/sshare'), '-a', '-U', '--noheader', '--parsable2',
            '--format=' + SSHARE_FORMAT]
    users = parse_sshare(query(args))
    running = running_usage(jobs)
    scope = config.get('scope', 'visible')
    self_user = getpass.getuser()
    merged = []
    for user in users:
        if scope == 'mine' and user['username'] != self_user:
            continue
        allocation = running.get(user['username'], {})
        user['runningJobs'] = int(allocation.get('runningJobs', 0))
        user['runningCpus'] = int(allocation.get('runningCpus', 0))
        user['runningGpus'] = int(allocation.get('runningGpus', 0))
        merged.append(user)
    merged.sort(key=lambda u: (-(u.get('rawUsage') or 0), u['username']))
    return merged[:MAX_USERS]


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
    users, users_warning = [], None
    if config.get('fairshare', True):
        try:
            users = build_users(config, jobs)
        except (subprocess.SubprocessError, RuntimeError, ValueError, OSError):
            users_warning = 'User FairShare data unavailable'
    return {'version': 1, 'sourceId': config['sourceId'], 'reportId': str(uuid.uuid4()),
            'collectedAt': int(time.time()*1000), 'hostname': socket.gethostname(),
            'collectorUser': getpass.getuser(), 'scope': config.get('scope', 'visible'),
            'visibility': config.get('visibility', 'account-visible'),
            'durationMs': round((time.monotonic()-started)*1000),
            'queueAgeMs': round((time.monotonic()-queue_sampled_at)*1000), 'jobs': jobs[:5000],
            'counts': counts, 'truncated': len(jobs) > 5000, 'partitions': parts,
            'users': users, 'usersWarning': users_warning,
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
                    'users': [], 'usersWarning': None,
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
