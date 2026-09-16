import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

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

    def test_available_not_free_determines_memory_pressure(self):
        vm=SimpleNamespace(total=1000,available=700,free=100,cached=500,buffers=100,shared=10)
        swap=SimpleNamespace(total=0,used=0,percent=0)
        result=sampler.memory_snapshot(vm,swap)
        self.assertEqual(result['used'],300)
        self.assertEqual(result['percent'],30)
        self.assertEqual(result['cached'],500)
        self.assertEqual(result['swapTotal'],0)

if __name__=='__main__':unittest.main()
