import os
import tempfile
import unittest
from pathlib import Path

from media_mcp import worker
from media_mcp.config import Settings
from media_mcp.store import Store, StoreError


def job_dir(root: Path, bot="bot-a", job="a" * 32) -> Path:
    d = root / "bots" / bot / "jobs" / job
    (d / "in").mkdir(parents=True)
    (d / "out").mkdir()
    return d


class JobBytesCountAgainstQuota(unittest.TestCase):
    def test_out_dir_counts(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            s = Store(root, 100, 1000, 1)
            s.bot_dir("bot-a")
            d = job_dir(root)
            (d / "out" / "big.bin").write_bytes(b"x" * 90)
            self.assertEqual(s.used_bytes("bot-a"), 90)
            with self.assertRaises(StoreError):
                s.put_bytes("bot-a", b"y" * 20, "n")
            s.put_bytes("bot-a", b"y" * 10, "n")

    def test_hard_link_counts_once(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            s = Store(root, 1000, 1000, 1)
            m = s.put_bytes("bot-a", b"z" * 50, "v.mp4")
            d = job_dir(root)
            os.link(s.blob("bot-a", m["id"]), d / "in" / "v.mp4")
            self.assertEqual(s.used_bytes("bot-a"), 50)
            (d / "in" / "copy.mp4").write_bytes(b"c" * 30)  # a real copy counts
            self.assertEqual(s.used_bytes("bot-a"), 80)

    def test_upload_temporaries_count(self):
        with tempfile.TemporaryDirectory() as t:
            s = Store(Path(t), 100, 1000, 1)
            s.new_tmp("bot-a").write_bytes(b"t" * 70)
            self.assertEqual(s.used_bytes("bot-a"), 70)
            self.assertEqual(s.remaining("bot-a"), 30)

    def test_spool_ceiling_is_global(self):
        with tempfile.TemporaryDirectory() as t:
            s = Store(Path(t), 1000, 1000, 1, spool_max_bytes=100)
            s.put_bytes("bot-a", b"a" * 60, "a")
            with self.assertRaises(StoreError):
                s.put_bytes("bot-b", b"b" * 60, "b")  # each bot is within its own quota
            s.put_bytes("bot-b", b"b" * 30, "b")


class WorkerLimits(unittest.TestCase):
    def cfg(self, root: Path, **kw) -> Settings:
        return Settings(data_dir=root, **kw)

    def test_failure_frees_disk(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            d = job_dir(root)
            (d / "in" / "a.mp4").write_bytes(b"1" * 10)
            (d / "out" / "o.mp4").write_bytes(b"2" * 10)
            w = worker.Worker(self.cfg(root))
            w.fail(d, "boom")
            self.assertFalse((d / "in").exists() or (d / "out").exists())
            st = w.state(d)
            self.assertEqual((st["status"], st["error"]), ("failed", "boom"))

    def test_out_limit(self):
        with tempfile.TemporaryDirectory() as t:
            w = worker.Worker(self.cfg(Path(t), spool_min_free_bytes=0))
            self.assertEqual(w.out_limit(50 * 2**20), 50 * 2**20)
            self.assertEqual(w.out_limit(10 * 2**40), worker.MAX_OUT_BYTES)  # never above the ceiling
            self.assertEqual(w.out_limit(5), worker.MIN_OUT_BYTES)
            self.assertEqual(w.out_limit(None), worker.MAX_OUT_BYTES)

    def test_sync_timeouts_fit_facade_call(self):
        with tempfile.TemporaryDirectory() as t:
            c = self.cfg(Path(t))
            w = worker.Worker(c)
            for kind in worker.SYNC_KINDS:
                self.assertLess(w.timeout_for(kind), c.backend_timeout_s + 60)
            self.assertEqual(w.timeout_for("ffmpeg"), worker.TIMEOUTS["ffmpeg"])


if __name__ == "__main__":
    unittest.main()
