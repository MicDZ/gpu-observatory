import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('collector', Path(__file__).resolve().parents[1] / 'slurm/collector.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class ParserTests(unittest.TestCase):
    def test_jobs_with_padding_arrays_and_unknown_resources(self):
        output = '123_[1-4]    |alice   |long |PENDING|2|16|64G|0:00|2-00:00:00|999|Resources|cpu=16,gres/gpu=8|N/A|120\n124|alice|gpu-batch|RUNNING|1|8|32G|1:10:00|1-00:00:00|500|None|cpu=8,gres/gpu=2|N/A|2\n'
        jobs = collector.parse_jobs(output)
        self.assertEqual(jobs[0]['jobId'], '123_[1-4]')
        self.assertEqual(jobs[0]['cpus'], 16)
        self.assertEqual(jobs[0]['tres'], 'cpu=16,gres/gpu=8')
        self.assertEqual(jobs[1]['state'], 'RUNNING')
        self.assertEqual(jobs[0]['pendingSeconds'], 120)
        self.assertEqual(jobs[1]['pendingSeconds'], 2)
        self.assertEqual(jobs[1]['elapsedSeconds'], 4200)
        self.assertNotIn('command', jobs[0])

    def test_empty_is_not_an_error(self):
        self.assertEqual(collector.parse_jobs(''), [])

    def test_partial_output_fails_instead_of_showing_an_empty_queue(self):
        with self.assertRaises(ValueError):
            collector.parse_jobs('123|alice|long\n')

    def test_partition_state_flags_are_preserved(self):
        parts = collector.parse_partitions('long*|up|15|mix-\ncpu-batch|up|2|idle\n')
        self.assertEqual(parts[0], {'name':'long','availability':'up','nodes':15,'state':'mix-'})
        self.assertEqual(sum(p['nodes'] for p in parts), 17)

    def test_duration_formats_and_unknowns(self):
        for value, expected in [('0:00',0),('3:43',223),('1:10:00',4200),('2-03:04:05',183845)]:
            self.assertEqual(collector.duration_seconds(value),expected)
        for value in ['INVALID','UNLIMITED','N/A','2:60','1-25:00:00']:
            self.assertIsNone(collector.duration_seconds(value))


if __name__ == '__main__':
    unittest.main()
