"""Unprivileged Linux CPU/RAM telemetry; reads no argv, environment or files of jobs."""
import math
import os
from pathlib import Path
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
        return {'collectedAt': int(time.time()*1000), 'sampleSeconds': round(elapsed, 2),
                'cpu': {'model': self.model, 'logicalCores': self.logical, 'physicalCores': self.physical,
                        'percent': percent, 'perCore': per_core, 'loadAverage': load},
                'memory': memory_snapshot(self.psutil.virtual_memory(), self.psutil.swap_memory()),
                'processCount': count, 'restrictedProcesses': restricted,
                'topCpuProcesses': cpu_top, 'topMemoryProcesses': memory_top, 'error': None}
