"""Actual Windows process/NTFS regressions; no administrator token needed."""
import os
from contextlib import closing
from pathlib import Path
import stat
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from windows_smoke_support import remove_owned_tree


class OperationLockTests(unittest.TestCase):
    def test_invitation_wait_can_outlast_startup_health_without_weakening_exclusion(self):
        from unittest.mock import patch
        source=Path(__file__).resolve().parents[1]/'manager'
        sys.path.insert(0,str(source))
        from pawtalk_manager.config import lock
        with tempfile.TemporaryDirectory(prefix='pawtalk-lock-') as directory:
            file=Path(directory)/'operation.lock'
            # Exercise the actual platform lock; isolate unrelated managed ACL policy.
            code=('import sys,time;from unittest.mock import patch;sys.path.insert(0,'+repr(str(source))+');'
                  'from pawtalk_manager.config import lock;'
                  '\nwith patch("pawtalk_manager.config.secure"),lock(sys.argv[1]):\n print("locked",flush=True);time.sleep(0.6)')
            child=subprocess.Popen([sys.executable,'-B','-I','-c',code,str(file)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            try:
                self.assertEqual(child.stdout.readline().strip(),'locked')
                with patch('pawtalk_manager.config.secure'):
                    with self.assertRaisesRegex(ValueError,'Another PawTalk operation'):
                        with lock(file):self.fail('Concurrent maintenance lock was ignored')
                    start=time.monotonic()
                    with self.assertRaises(ValueError):
                        with lock(file,timeout=0.05):self.fail('Bounded timeout was ignored')
                    self.assertLess(time.monotonic()-start,1)
                    with lock(file,timeout=3):pass
                self.assertEqual(child.wait(timeout=5),0)
            finally:
                if child.poll() is None:child.kill();child.wait()
                child.stdout.close();child.stderr.close()


@unittest.skipUnless(os.name=='nt','Windows CRT/NTFS semantics')
class WindowsHandoffTests(unittest.TestCase):
    def test_handoff_waits_for_child_and_propagates_both_exit_codes(self):
        source=Path(__file__).resolve().parents[1]/'manager'
        for code in [0,7]:
            with self.subTest(code=code),tempfile.TemporaryDirectory(prefix='pawtalk-handoff-') as directory:
                marker=Path(directory)/'finished'
                child="import pathlib,sys,time;time.sleep(0.5);pathlib.Path(sys.argv[1]).write_text('finished');sys.exit(int(sys.argv[2]))"
                parent=('import sys;sys.path.insert(0,'+repr(str(source))+');from pawtalk_manager.cli import handoff;'
                        'handoff([sys.executable,"-B","-I","-c",'+repr(child)+',sys.argv[1],sys.argv[2]])')
                process=subprocess.Popen([sys.executable,'-B','-X','utf8','-I','-c',parent,str(marker),str(code)],
                                         stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                try:
                    result=process.wait(timeout=10)
                    self.assertEqual(result,code)
                    self.assertTrue(marker.exists(),'Installer parent returned before its successor completed')
                finally:
                    if process.poll() is None:
                        process.kill();process.wait()
                    # A broken execv implementation leaves a bounded successor;
                    # let that regression fixture finish before removing its files.
                    deadline=time.monotonic()+2
                    while not marker.exists() and time.monotonic()<deadline:time.sleep(0.02)

    def test_owned_cleanup_handles_readonly_notice_and_refuses_outside_paths(self):
        with tempfile.TemporaryDirectory(prefix='pawtalk-cleanup-') as parent:
            root=Path(parent)/'owned-bootstrap';root.mkdir()
            notice=root/'X-SYS-LICENSE';notice.write_text('synthetic notice')
            os.chmod(notice,stat.S_IREAD)
            remove_owned_tree(root,Path(parent),'owned-')
            self.assertFalse(root.exists())
            other=Path(parent)/'unowned';other.mkdir()
            with self.assertRaises(ValueError):remove_owned_tree(other,Path(parent),'owned-')
            self.assertTrue(other.exists())

    def test_sqlite_transaction_scope_needs_explicit_connection_close(self):
        with tempfile.TemporaryDirectory(prefix='pawtalk-sqlite-cleanup-') as parent:
            root=Path(parent)/'owned-room';root.mkdir()
            database=root/'chat.sqlite'
            with closing(sqlite3.connect(database)) as db:
                with db:
                    db.execute('CREATE TABLE probe(value TEXT)')
                # A transaction context commits but retains the Windows file handle.
                with self.assertRaises(PermissionError):database.unlink()
            # Keep the db reference alive: cleanup must not depend on Python GC.
            remove_owned_tree(root,Path(parent),'owned-')
            self.assertFalse(root.exists())


if __name__=='__main__':unittest.main()
