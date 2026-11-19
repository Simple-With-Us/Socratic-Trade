"""Durable reserve-before-execution admission. No prompts or secrets stored."""
import os,sqlite3,stat,time,uuid
class ReplayDenied(Exception):pass
class ReplayStore:
    def __init__(self,path,ceiling=10000):
        if type(ceiling) is not int or ceiling<1:raise ValueError('ceiling')
        parent=os.stat(os.path.dirname(os.path.abspath(path)))
        if parent.st_uid!=os.getuid() or parent.st_mode&0o077:raise ReplayDenied('private parent required')
        fd=os.open(path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077:raise ReplayDenied('private regular file required')
        finally:os.close(fd)
        self.path=path;self.ceiling=ceiling
        with self.connect() as c:
            c.execute('CREATE TABLE IF NOT EXISTS reservations (request_id TEXT PRIMARY KEY, reserved_at INTEGER NOT NULL, attempt_units INTEGER NOT NULL DEFAULT 6)')
            columns={row[1] for row in c.execute('PRAGMA table_info(reservations)')}
            if 'attempt_units' not in columns:
                c.execute('ALTER TABLE reservations ADD COLUMN attempt_units INTEGER NOT NULL DEFAULT 6')
    def connect(self):
        c=sqlite3.connect(self.path,timeout=2,isolation_level=None)
        c.execute('PRAGMA synchronous=FULL');c.execute('PRAGMA journal_mode=DELETE')
        return c
    def reserve(self,request_id,attempt_units=6):
        # Unknown outcome remains consumed forever; no automatic retries or refund.
        try:uuid.UUID(request_id)
        except (ValueError,TypeError,AttributeError):raise ReplayDenied('request id')
        if type(attempt_units) is not int or attempt_units != 6:raise ReplayDenied('six attempt units required')
        c=self.connect()
        try:
            c.execute('BEGIN IMMEDIATE')
            if c.execute('SELECT 1 FROM reservations WHERE request_id=?',(request_id,)).fetchone():raise ReplayDenied('replayed request')
            if c.execute('SELECT COALESCE(SUM(attempt_units),0) FROM reservations').fetchone()[0]+attempt_units>self.ceiling:raise ReplayDenied('attempt-unit ceiling')
            c.execute('INSERT INTO reservations (request_id,reserved_at,attempt_units) VALUES (?,?,?)',(request_id,int(time.time()),attempt_units))
            c.commit()
        except:
            c.rollback();raise
        finally:c.close()
