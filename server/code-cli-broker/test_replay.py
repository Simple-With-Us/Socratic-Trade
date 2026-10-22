import sqlite3,os,tempfile,threading,unittest,uuid
from replay import ReplayStore,ReplayDenied
class ReplayTests(unittest.TestCase):
    def test_restart_and_ceiling(self):
        with tempfile.TemporaryDirectory() as d:
            p=d+'/seen.db';ident=str(uuid.uuid4());ReplayStore(p,12).reserve(ident)
            with self.assertRaises(ReplayDenied):ReplayStore(p,12).reserve(ident)
            ReplayStore(p,12).reserve(str(uuid.uuid4()))
            with self.assertRaises(ReplayDenied):ReplayStore(p,12).reserve(str(uuid.uuid4()))
    def test_concurrent_same_request(self):
        with tempfile.TemporaryDirectory() as d:
            store=ReplayStore(d+'/seen.db');ident=str(uuid.uuid4());out=[]
            def run():
                try:store.reserve(ident);out.append('reserved')
                except ReplayDenied:out.append('denied')
            threads=[threading.Thread(target=run) for _ in range(5)]
            for t in threads:t.start()
            for t in threads:t.join()
            self.assertEqual(out.count('reserved'),1);self.assertEqual(out.count('denied'),4)
    def test_nonprivate_parent_and_symlink(self):
        with tempfile.TemporaryDirectory() as d:
            os.symlink(d+'/target',d+'/link')
            with self.assertRaises(OSError):ReplayStore(d+'/link')
            os.chmod(d,0o755)
            with self.assertRaises(ReplayDenied):ReplayStore(d+'/seen.db')
    def test_invalid_id(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ReplayDenied):ReplayStore(d+'/seen.db').reserve('bad')

    def test_six_unit_budget_and_unknown_outcome(self):
        with tempfile.TemporaryDirectory() as d:
            p=d+'/seen.db';store=ReplayStore(p,11);ident=str(uuid.uuid4());store.reserve(ident)
            with self.assertRaises(ReplayDenied):ReplayStore(p,11).reserve(str(uuid.uuid4()))
            with self.assertRaises(ReplayDenied):ReplayStore(p,11).reserve(ident)
            with sqlite3.connect(p) as c:self.assertEqual(c.execute('SELECT SUM(attempt_units) FROM reservations').fetchone()[0],6)
    def test_atomic_budget_concurrent_different_requests(self):
        with tempfile.TemporaryDirectory() as d:
            store=ReplayStore(d+'/seen.db',6);out=[]
            def run():
                try:store.reserve(str(uuid.uuid4()));out.append('reserved')
                except ReplayDenied:out.append('denied')
            threads=[threading.Thread(target=run) for _ in range(5)]
            for t in threads:t.start()
            for t in threads:t.join()
            self.assertEqual(out.count('reserved'),1);self.assertEqual(out.count('denied'),4)
    def test_old_reservations_preserved(self):
        with tempfile.TemporaryDirectory() as d:
            p=d+'/seen.db';ident=str(uuid.uuid4())
            with sqlite3.connect(p) as c:
                c.execute('CREATE TABLE reservations (request_id TEXT PRIMARY KEY,reserved_at INTEGER NOT NULL)')
                c.execute('INSERT INTO reservations VALUES (?,0)',(ident,))
            os.chmod(p,0o600)
            store=ReplayStore(p,6)
            with self.assertRaises(ReplayDenied):store.reserve(ident)
            with self.assertRaises(ReplayDenied):store.reserve(str(uuid.uuid4()))
    def test_reservation_cannot_understate_retry_bound(self):
        with tempfile.TemporaryDirectory() as d:
            store=ReplayStore(d+'/seen.db')
            for units in [1,0,-1,True,7,'6']:
                with self.assertRaises(ReplayDenied):store.reserve(str(uuid.uuid4()),units)
