import importlib.util
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('system_sampler',Path(__file__).resolve().parents[1]/'system_sampler.py')
sampler=importlib.util.module_from_spec(spec)
spec.loader.exec_module(sampler)

class SystemTests(unittest.TestCase):
    def test_cpu_supports_multicore_processes(self):
        self.assertEqual(sampler.process_cpu_percent(10,20,5),200)
        self.assertEqual(sampler.process_cpu_percent(10,10,5),0)

    def test_unknown_baseline_and_counter_reset_are_not_idle(self):
        self.assertIsNone(sampler.process_cpu_percent(None,10,5))
        self.assertIsNone(sampler.process_cpu_percent(20,10,5))
        self.assertIsNone(sampler.process_cpu_percent(10,20,0))
        self.assertIsNone(sampler.process_cpu_percent(10,float('inf'),5))

    def test_disk_snapshot_keeps_local_filesystems_and_skips_network_mounts(self):
        class FakePsutil:
            def disk_partitions(self, all=False):
                return [
                    SimpleNamespace(device='server:/data', mountpoint='/mnt/nfs', fstype='nfs', opts='rw'),
                    SimpleNamespace(device='/dev/nvme0n1p2', mountpoint='/', fstype='ext4', opts='rw,relatime'),
                    SimpleNamespace(device='tmpfs', mountpoint='/tmp', fstype='tmpfs', opts='rw'),
                    SimpleNamespace(device='/dev/sdb1', mountpoint='/data', fstype='xfs', opts='ro'),
                ]
            def disk_usage(self, mountpoint):
                return {'/': SimpleNamespace(total=1000, free=250), '/data': SimpleNamespace(total=4000, free=1000)}[mountpoint]
        rows = sampler.disk_snapshot(FakePsutil())
        self.assertEqual([row['mountpoint'] for row in rows], ['/', '/data'])
        self.assertEqual(rows[0]['used'], 750)
        self.assertEqual(rows[0]['percent'], 75.0)
        self.assertTrue(rows[1]['readonly'])

    def test_du_bytes_parses_partial_permission_output_and_timeout(self):
        completed=SimpleNamespace(returncode=1,stdout='123\t/path\n',stderr='Permission denied')
        with patch.object(sampler.subprocess,'run',return_value=completed):
            self.assertEqual(sampler.du_bytes('/path',10),(123,True,None))
        with patch.object(sampler.subprocess,'run',side_effect=sampler.subprocess.TimeoutExpired('du',10)):
            self.assertEqual(sampler.du_bytes('/path',10),(None,True,'timeout'))

    def test_scan_disk_users_aggregates_by_owner_and_marks_partial(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root,'alice').mkdir()
            Path(root,'bob').mkdir()
            Path(root,'note.txt').write_text('skip')
            def fake_du(path, timeout):
                return {'alice':(1000,False,None),'bob':(500,True,None)}[Path(path).name]
            with patch.object(sampler,'owner_name',side_effect=lambda path:Path(path).name), patch.object(sampler,'du_bytes',side_effect=fake_du):
                result=sampler.scan_disk_users([root],timeout=1,budget=10)
        self.assertEqual([u['username'] for u in result['users']],['alice','bob'])
        self.assertEqual(result['users'][0]['bytes'],1000)
        self.assertEqual(result['users'][1]['bytes'],500)
        self.assertTrue(result['users'][1]['partial'])
        self.assertTrue(result['partial'])
        self.assertEqual(result['roots_scanned'],1)

    def test_available_not_free_determines_memory_pressure(self):
        vm=SimpleNamespace(total=1000,available=700,free=100,cached=500,buffers=100,shared=10)
        swap=SimpleNamespace(total=0,used=0,percent=0)
        result=sampler.memory_snapshot(vm,swap)
        self.assertEqual(result['used'],300)
        self.assertEqual(result['percent'],30)
        self.assertEqual(result['cached'],500)
        self.assertEqual(result['swapTotal'],0)

if __name__=='__main__':unittest.main()
