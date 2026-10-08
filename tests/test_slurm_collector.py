import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('collector', Path(__file__).resolve().parents[1] / 'slurm/collector.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class ParserTests(unittest.TestCase):
    def test_jobs_with_padding_arrays_and_unknown_resources(self):
        output = '123_[1-4]    |N/A|alice   |long |PENDING|2|16|64G|0:00|2-00:00:00|999|Resources|cpu=16,gres/gpu=8|N/A|120\n124|N/A|alice|gpu-batch|RUNNING|1|8|32G|1:10:00|1-00:00:00|500|None|cpu=8,gres/gpu=2|N/A|2\n'
        jobs = collector.parse_jobs(output)
        self.assertEqual(jobs[0]['jobId'], '123_[1-4]')
        self.assertEqual(jobs[0]['cpus'], 16)
        self.assertEqual(jobs[0]['tres'], 'cpu=16,gres/gpu=8')
        self.assertEqual(jobs[1]['state'], 'RUNNING')
        self.assertEqual(jobs[0]['pendingSeconds'], 120)
        self.assertEqual(jobs[1]['pendingSeconds'], 2)
        self.assertEqual(jobs[1]['elapsedSeconds'], 4200)
        self.assertNotIn('command', jobs[0])

    def test_array_tasks_get_unique_ids(self):
        output = ('199074|0|alice|long|PENDING|1|1|1G|0:00|1:00:00|1|None|cpu=1|N/A|1\n'
                  '199074|1|alice|long|PENDING|1|1|1G|0:00|1:00:00|1|None|cpu=1|N/A|1\n')
        jobs = collector.parse_jobs(output)
        self.assertEqual([job['jobId'] for job in jobs], ['199074_0', '199074_1'])

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


SSHARE = (
    'root|root|1|0.066667|0|0.000000|1.000000|inf|cpu=0,mem=0,gres/gpu=0\n'
    'faculty-ml|alice|100|0.250000|4820000|0.310000|0.520000|1.600000|cpu=198000,mem=1,gres/gpu=12400\n'
    'students|alice|50|0.100000|1200000|0.090000|0.910000|3.200000|cpu=64000,mem=1,gres/gpu=3200\n'
    'students|bob|50|0.100000|900000|0.070000|0.930000|4.000000|cpu=8000,mem=1,gres/gpu=800\n')


class UserTests(unittest.TestCase):
    def test_parse_tres_reads_named_values(self):
        self.assertEqual(collector.parse_tres('cpu=8,gres/gpu=2,mem=32G')['gres/gpu'], '2')
        self.assertEqual(collector.parse_tres('N/A'), {})

    def test_parse_sshare_keeps_highest_usage_row_per_user(self):
        users = collector.parse_sshare(SSHARE)
        self.assertEqual(len(users), 3)
        by = {u['username']: u for u in users}
        self.assertEqual(by['alice']['account'], 'faculty-ml')
        self.assertEqual(by['alice']['rawUsage'], 4820000)
        self.assertEqual(by['alice']['runGpuMinutes'], 12400)
        self.assertEqual(by['root']['fairshare'], 1.0)
        self.assertIsNone(by['root']['levelFs'])
        self.assertEqual(by['bob']['fairshare'], 0.93)

    def test_parse_sshare_rejects_partial_rows(self):
        with self.assertRaises(ValueError):
            collector.parse_sshare('faculty-ml|alice|100|0.25\n')

    def test_running_usage_sums_current_allocation(self):
        jobs = [{'state': 'RUNNING', 'username': 'alice', 'cpus': 8, 'tres': 'cpu=8,gres/gpu=2'},
                {'state': 'RUNNING', 'username': 'alice', 'cpus': 4, 'tres': 'cpu=4,gres/gpu=1'},
                {'state': 'PENDING', 'username': 'bob', 'cpus': 8, 'tres': 'gres/gpu=4'}]
        running = collector.running_usage(jobs)
        self.assertEqual(running['alice'], {'runningJobs': 2, 'runningCpus': 12, 'runningGpus': 3})
        self.assertNotIn('bob', running)

    def test_build_users_merges_fairshare_and_running_allocation(self):
        original = collector.query
        collector.query = lambda args: SSHARE
        try:
            jobs = [{'state': 'RUNNING', 'username': 'alice', 'cpus': 8, 'tres': 'gres/gpu=2'}]
            users = collector.build_users({'scope': 'visible'}, jobs)
        finally:
            collector.query = original
        by = {u['username']: u for u in users}
        self.assertEqual(by['alice']['runningGpus'], 2)
        self.assertEqual(by['alice']['runningJobs'], 1)
        self.assertEqual(by['bob']['runningGpus'], 0)
        self.assertTrue(all(isinstance(u['fairshare'], float) for u in users))

    def test_build_users_limits_mine_scope_to_the_collector_user(self):
        import getpass
        original = collector.query
        collector.query = lambda args: SSHARE
        try:
            users = collector.build_users({'scope': 'mine'}, [])
        finally:
            collector.query = original
        self.assertEqual([u['username'] for u in users], [getpass.getuser()]) if getpass.getuser() in {'root','alice','bob'} else self.assertEqual(users, [])


if __name__ == '__main__':
    unittest.main()
