import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from media_mcp.auth import Authenticator, PeerResolver
from media_mcp.config import Settings, load_bots
from media_mcp.store import Store, StoreError


class Resolver(PeerResolver):
    def addrs(self, host):
        return {"192.0.2.5"} if host == "myrmidon-bot-a" else {"192.0.2.6"}


def cfg_for(tmp: Path) -> Settings:
    (tmp / "bots.json").write_text(json.dumps({"bots": {
        "bot-a": {"token_sha256": hashlib.sha256(b"ta").hexdigest(), "peer_host": "myrmidon-bot-a"},
        "bot-b": {"token_sha256": hashlib.sha256(b"tb").hexdigest()},
        "bot-c": {"peer_host": "myrmidon-bot-c"},
    }}))
    return Settings(data_dir=tmp, bots=load_bots(tmp / "bots.json"))


class StoreIsolation(unittest.TestCase):
    def test_bot_cannot_read_other_bots_file(self):
        with tempfile.TemporaryDirectory() as t:
            s = Store(Path(t), 10**6, 10**6, 1)
            m = s.put_bytes("bot-a", b"secret", "x.txt")
            self.assertEqual(s.blob("bot-a", m["id"]).read_bytes(), b"secret")
            with self.assertRaises(StoreError):
                s.meta("bot-b", m["id"])
            for bad in ("../bot-a/files/" + m["id"], m["id"] + "/../x", "", "x"):
                with self.assertRaises(StoreError):
                    s.blob("bot-b", bad)
            with self.assertRaises(StoreError):
                s.bot_dir("../etc")

    def test_quota(self):
        with tempfile.TemporaryDirectory() as t:
            s = Store(Path(t), 10, 100, 1)
            s.put_bytes("bot-a", b"12345678", "a")
            with self.assertRaises(StoreError):
                s.put_bytes("bot-a", b"12345678", "b")


class Auth(unittest.TestCase):
    def test_identify(self):
        with tempfile.TemporaryDirectory() as t:
            a = Authenticator(cfg_for(Path(t)), Resolver())
            self.assertEqual(a.identify("ta", "192.0.2.5").key, "bot-a")
            self.assertIsNone(a.identify("ta", "192.0.2.9"))  # token stolen, wrong host
            self.assertIsNone(a.identify("nope", "192.0.2.5"))
            self.assertEqual(a.identify("tb", "198.51.100.4").key, "bot-b")
            self.assertIsNone(a.identify(None, "192.0.2.5"))  # bot-a needs its token too
            self.assertIsNone(a.identify(None, None))

    def test_rate(self):
        with tempfile.TemporaryDirectory() as t:
            cfg = cfg_for(Path(t))
            a = Authenticator(cfg, Resolver())
            bot = cfg.bots["bot-b"]
            n = sum(a.allow(bot) for _ in range(cfg.rate_per_min + 5))
            self.assertEqual(n, cfg.rate_per_min)


if __name__ == "__main__":
    unittest.main()
