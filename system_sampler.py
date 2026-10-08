"""Unprivileged Linux CPU/RAM/local-disk telemetry; reads no argv, environment or job files."""
import glob
import math
import os
from pathlib import Path
import pwd
import subprocess
import threading
import time


def process_cpu_percent(previous, current, elapsed):
    if previous is None or current is None or not all(math.isfinite(n) for n in [previous,current,elapsed]) or elapsed <= 0 or current < previous:
        return None
    return round((current - previous) / elapsed * 100, 1)


def memory_snapshot(vm, swap):
    # Available includes reclaimable memory; free alone exaggerates memory pressure.
    available = min(vm.total, max(0, vm.available))
    used = vm.total - available
    return {'total': vm.total, 'available': available, 'used': used,
            'percent': round(used / vm.total * 100, 1) if vm.total else None,
            'free': vm.free, 'cached': getattr(vm, 'cached', None),
            'buffers': getattr(vm, 'buffers', None), 'shared': getattr(vm, 'shared', None),
            'swapTotal': swap.total, 'swapUsed': swap.used, 'swapPercent': swap.percent}


DISK_SKIP_FSTYPES = frozenset({
    'autofs', 'binfmt_misc', 'bpf', 'cgroup', 'cgroup2', 'configfs', 'debugfs',
    'devpts', 'devtmpfs', 'efivarfs', 'fusectl', 'hugetlbfs', 'mqueue', 'nsfs',
    'overlay', 'proc', 'pstore', 'ramfs', 'securityfs', 'squashfs', 'sysfs',
    'tmpfs', 'tracefs',
})
DISK_NETWORK_FSTYPES = frozenset({
    '9p', 'afs', 'ceph', 'cifs', 'fuse.sshfs', 'glusterfs', 'gpfs', 'lustre',
    'nfs', 'nfs4', 'smb3', 'sshfs',
})
DISK_LOCAL_FSTYPES = frozenset({
    'btrfs', 'ext2', 'ext3', 'ext4', 'exfat', 'f2fs', 'jfs', 'ntfs', 'ntfs3',
    'reiserfs', 'ufs', 'vfat', 'xfs', 'zfs',
})


def disk_snapshot(psutil):
    """Read local filesystem capacity without touching network or pseudo mounts."""
    rows, seen = [], set()
    try:
        partitions = psutil.disk_partitions(all=False)
    except (OSError, AttributeError):
        return rows
    for part in partitions:
        if len(rows) >= 64:
            break
        fstype = (part.fstype or '').lower()
        device, mountpoint = part.device or '', part.mountpoint or ''
        if not device or not mountpoint or fstype in DISK_SKIP_FSTYPES or fstype in DISK_NETWORK_FSTYPES:
            continue
        if not (device.startswith('/dev/') or fstype in DISK_LOCAL_FSTYPES):
            continue
        key = (device, mountpoint)
        if key in seen:
            continue
        try:
            usage = psutil.disk_usage(mountpoint)
        except OSError:
            continue
        total, free = int(usage.total), int(usage.free)
        if total <= 0 or free < 0:
            continue
        free = min(total, free)
        used = max(0, total - free)
        seen.add(key)
        rows.append({
            'device': device, 'mountpoint': mountpoint, 'fstype': fstype,
            'total': total, 'used': used, 'free': free,
            'percent': round(used / total * 100, 1),
            'readonly': 'ro' in (part.opts or '').split(','),
        })
    rows.sort(key=lambda row: (row['mountpoint'] != '/', row['mountpoint']))
    return rows


DEFAULT_DISK_USAGE_ROOTS = ('/mnt/ssd', '/mnt/data_*', '/mnt/nas/*')
DEFAULT_DISK_USAGE_INTERVAL = 21600
DEFAULT_DISK_USAGE_TIMEOUT = 300
DEFAULT_DISK_USAGE_BUDGET = 1800


def expand_disk_roots(patterns):
    roots = []
    for pattern in patterns or ():
        matches = glob.glob(pattern) if any(char in pattern for char in '*?[') else [pattern]
        for path in matches:
            if os.path.islink(path) or not os.path.isdir(path):
                continue
            real = os.path.realpath(path)
            if real not in roots:
                roots.append(real)
    return roots


def owner_name(path):
    try:
        return pwd.getpwuid(os.lstat(path).st_uid).pw_name
    except KeyError:
        return str(os.lstat(path).st_uid)
    except OSError:
        return None


def du_bytes(path, timeout):
    try:
        result = subprocess.run(['du', '-s', '-x', '-B1', '--', path], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, True, 'timeout'
    except OSError as error:
        return None, True, type(error).__name__
    size = None
    if result.stdout.strip():
        try:
            size = int(result.stdout.strip().split()[0])
        except (IndexError, ValueError):
            pass
    return size, result.returncode != 0, None if size is not None else 'du failed'


def scan_disk_users(patterns, timeout=DEFAULT_DISK_USAGE_TIMEOUT, budget=DEFAULT_DISK_USAGE_BUDGET,
                    max_users=500, du_runner=None, progress=None):
    """Best-effort per-owner usage for readable shared-data directories."""
    du_runner = du_runner or du_bytes
    started = time.monotonic()
    roots = expand_disk_roots(patterns)
    usage, partial, errors = {}, False, 0
    def publish():
        if progress:
            progress(sorted(usage.values(), key=lambda item: (-item['bytes'], item['username']))[:max_users], partial)
    for root in roots:
        if time.monotonic() - started >= budget:
            partial = True
            break
        try:
            entries = list(os.scandir(root))
        except OSError:
            errors += 1
            partial = True
            continue
        for entry in entries:
            if time.monotonic() - started >= budget:
                partial = True
                break
            if entry.name == 'lost+found' or entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
                continue
            username = owner_name(entry.path)
            if not username:
                errors += 1
                partial = True
                continue
            size, item_partial, _ = du_runner(entry.path, timeout)
            if size is None:
                errors += 1
                partial = True
                continue
            record = usage.setdefault(username, {'username': username, 'bytes': 0, 'paths': 0, 'partial': False})
            record['bytes'] += size
            record['paths'] += 1
            record['partial'] = record['partial'] or item_partial
            partial = partial or item_partial
            publish()
    users = sorted(usage.values(), key=lambda item: (-item['bytes'], item['username']))[:max_users]
    return {'users': users, 'partial': partial, 'roots_configured': list(patterns or ()), 'roots_scanned': len(roots), 'errors': errors}


class DiskUsageSampler:
    def __init__(self, roots=None, interval_seconds=DEFAULT_DISK_USAGE_INTERVAL,
                 timeout_seconds=DEFAULT_DISK_USAGE_TIMEOUT, budget_seconds=DEFAULT_DISK_USAGE_BUDGET,
                 max_users=500):
        self.patterns = tuple(roots or DEFAULT_DISK_USAGE_ROOTS)
        self.interval_seconds = max(300, int(interval_seconds))
        self.timeout_seconds = max(1, int(timeout_seconds))
        self.budget_seconds = max(1, int(budget_seconds))
        self.max_users = max(1, int(max_users))
        self._lock = threading.Lock()
        self._state = {'diskUsers': [], 'diskUsersAt': None, 'diskUsersPartial': False,
                       'diskUsersScanning': False, 'diskUsersError': None,
                       'diskUsersRoots': list(self.patterns), 'diskUsersDurationMs': None}
        self._thread = threading.Thread(target=self._run, name='disk-user-sampler', daemon=True)

    def start(self):
        self._thread.start()

    def snapshot(self):
        with self._lock:
            state = dict(self._state)
            state['diskUsers'] = [dict(item) for item in self._state['diskUsers']]
            state['diskUsersRoots'] = list(self._state['diskUsersRoots'])
            return state

    def _run(self):
        while True:
            self._scan_once()
            time.sleep(self.interval_seconds)

    def _scan_once(self):
        with self._lock:
            self._state.update(diskUsersScanning=True, diskUsersError=None)
        started = time.monotonic()
        try:
            def progress(users, partial):
                with self._lock:
                    self._state.update(diskUsers=[dict(item) for item in users], diskUsersPartial=partial, diskUsersScanning=True)
            result = scan_disk_users(self.patterns, self.timeout_seconds, self.budget_seconds, self.max_users, progress=progress)
            update = {'diskUsers': result['users'], 'diskUsersAt': int(time.time()*1000),
                      'diskUsersPartial': result['partial'], 'diskUsersScanning': False,
                      'diskUsersError': None if result['roots_scanned'] else 'No configured shared-data roots found', 'diskUsersRoots': result['roots_configured'],
                      'diskUsersDurationMs': round((time.monotonic()-started)*1000)}
        except Exception as error:
            update = {'diskUsers': [], 'diskUsersAt': int(time.time()*1000),
                      'diskUsersPartial': True, 'diskUsersScanning': False,
                      'diskUsersError': 'Disk usage scan failed (' + type(error).__name__ + ')',
                      'diskUsersRoots': list(self.patterns),
                      'diskUsersDurationMs': round((time.monotonic()-started)*1000)}
        with self._lock:
            self._state.update(update)


class SystemSampler:
    def __init__(self):
        import psutil
        self.psutil = psutil
        self.logical = psutil.cpu_count() or 1
        self.physical = psutil.cpu_count(logical=False)
        self.model = None
        try:
            with Path('/proc/cpuinfo').open() as f:
                for line in f:
                    if line.startswith('model name'):
                        self.model = line.split(':', 1)[1].strip()
                        break
        except OSError:
            pass
        psutil.cpu_percent(interval=None)
        psutil.cpu_percent(interval=None, percpu=True)
        initial, _, _ = self._processes()
        self.previous = {p['key']: p['cpuTime'] for p in initial}
        self.previous_at = time.monotonic()

    def _processes(self):
        records, count, restricted = [], 0, 0
        self.psutil.process_iter.cache_clear()
        attrs = ['pid', 'name', 'username', 'memory_info', 'cpu_times', 'create_time']
        for proc in self.psutil.process_iter(attrs=attrs, ad_value=None):
            count += 1
            try:
                p = proc.info
                times, memory = p['cpu_times'], p['memory_info']
                if any(p.get(k) is None for k in ['username', 'memory_info', 'cpu_times', 'create_time']):
                    restricted += 1
                # PID + creation time prevents reuse from being interpreted as CPU consumption.
                records.append({'key': (p['pid'], p['create_time']), 'pid': p['pid'],
                                'username': p['username'], 'name': p['name'],
                                'cpuTime': times.user + times.system if times else None,
                                'rss': memory.rss if memory else None})
            except (self.psutil.NoSuchProcess, self.psutil.AccessDenied, self.psutil.ZombieProcess):
                restricted += 1
        return records, count, restricted

    def sample(self):
        elapsed = time.monotonic() - self.previous_at
        if elapsed < 1:
            time.sleep(1 - elapsed)
        now = time.monotonic()
        elapsed = now - self.previous_at
        percent = self.psutil.cpu_percent(interval=None)
        per_core = self.psutil.cpu_percent(interval=None, percpu=True)
        records, count, restricted = self._processes()
        processes = []
        for p in records:
            cpu = process_cpu_percent(self.previous.get(p['key']), p['cpuTime'], elapsed) if p['key'][1] is not None else None
            processes.append({'pid': p['pid'], 'username': p['username'], 'name': p['name'],
                              'cpuPercent': cpu, 'rss': p['rss']})
        self.previous = {p['key']: p['cpuTime'] for p in records}
        self.previous_at = now
        cpu_top = sorted((p for p in processes if p['cpuPercent'] is not None), key=lambda p: (-p['cpuPercent'], p['pid']))[:20]
        memory_top = sorted((p for p in processes if p['rss'] is not None), key=lambda p: (-p['rss'], p['pid']))[:20]
        try:
            load = list(os.getloadavg())
        except OSError:
            load = None
        try:
            disks, disk_error = disk_snapshot(self.psutil), None
        except Exception as error:
            disks, disk_error = [], 'Disk collection failed (' + type(error).__name__ + ')'
        return {'collectedAt': int(time.time()*1000), 'sampleSeconds': round(elapsed, 2),
                'cpu': {'model': self.model, 'logicalCores': self.logical, 'physicalCores': self.physical,
                        'percent': percent, 'perCore': per_core, 'loadAverage': load},
                'memory': memory_snapshot(self.psutil.virtual_memory(), self.psutil.swap_memory()),
                'disks': disks, 'diskError': disk_error,
                'processCount': count, 'restrictedProcesses': restricted,
                'topCpuProcesses': cpu_top, 'topMemoryProcesses': memory_top, 'error': None}
