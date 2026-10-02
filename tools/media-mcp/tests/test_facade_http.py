import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from starlette.testclient import TestClient

from media_mcp.config import Settings, load_bots
from media_mcp.facade import build_app


def make(tmp: Path, **kw):
    (tmp / "bots.json").write_text(json.dumps({"bots": {"bot-a": {"token_sha256": hashlib.sha256(b"ta").hexdigest()}}}))
    cfg = Settings(data_dir=tmp, bots=load_bots(tmp / "bots.json"), spool_min_free_bytes=0, **kw)
    return build_app(cfg)


AUTH = {"Authorization": "Bearer ta"}
INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
    "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}
MCP_HEADERS = {**AUTH, "Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


class FacadeHttp(unittest.TestCase):
    def test_dns_rebinding_protection(self):
        with tempfile.TemporaryDirectory() as t, TestClient(make(Path(t)), base_url="http://media-mcp:8080") as c:
            self.assertEqual(c.post("/mcp", json=INIT, headers={**MCP_HEADERS, "Host": "evil.example"}).status_code, 421)
            self.assertEqual(c.post("/mcp", json=INIT, headers={**MCP_HEADERS, "Host": "media-mcp:8080"}).status_code, 200)

    def test_upload_stops_at_quota_and_leaves_nothing(self):
        with tempfile.TemporaryDirectory() as t, TestClient(make(Path(t), bot_quota_bytes=1000), base_url="http://media-mcp:8080") as c:
            r = c.put("/v1/files?name=a.bin", content=b"x" * 2000, headers=AUTH)
            self.assertEqual(r.status_code, 413)
            left = list((Path(t) / "bots" / "bot-a" / "files").iterdir())
            self.assertEqual(left, [])
            self.assertEqual(c.put("/v1/files?name=a.bin", content=b"x" * 900, headers=AUTH).status_code, 201)
            self.assertEqual(c.put("/v1/files?name=b.bin", content=b"x" * 200, headers=AUTH).status_code, 413)


if __name__ == "__main__":
    unittest.main()
