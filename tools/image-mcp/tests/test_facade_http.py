import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from starlette.testclient import TestClient

from image_mcp.config import Settings, load_bots
from image_mcp.facade import build_app
from image_mcp.store import Store

PNG = b"\x89PNG\r\n\x1a\n" + b"p" * 64


class FakeGateway:
    def __init__(self, images=None):
        self.images = images if images is not None else [{"data": PNG, "content_type": "image/png"}]

    async def generate(self, model, prompt, size, n, negative_prompt=None):
        return self.images, "req-1"

    async def aclose(self):
        pass


def make(tmp: Path, gateway=None, **kw):
    (tmp / "bots.json").write_text(json.dumps({"bots": {
        "bot-a": {"token_sha256": hashlib.sha256(b"ta").hexdigest()},
        "bot-b": {"token_sha256": hashlib.sha256(b"tb").hexdigest()},
    }}))
    cfg = Settings(data_dir=tmp, models=frozenset({"m"}), sizes=frozenset({"1024x1024"}),
                   bots=load_bots(tmp / "bots.json"), spool_min_free_bytes=0, **kw)
    return cfg, build_app(cfg, gateway=gateway or FakeGateway())


AUTH_A = {"Authorization": "Bearer ta"}
AUTH_B = {"Authorization": "Bearer tb"}
INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
    "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}
MCP_HEADERS = {**AUTH_A, "Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


def mcp_call(client, method, params=None, id=2, sid=None):
    body = {"jsonrpc": "2.0", "id": id, "method": method}
    if params is not None:
        body["params"] = params
    headers = dict(MCP_HEADERS)
    if sid:
        headers["Mcp-Session-Id"] = sid
    return client.post("/mcp", json=body, headers=headers)


class FacadeHttp(unittest.TestCase):
    def test_authentication_is_required(self):
        with tempfile.TemporaryDirectory() as t, TestClient(make(Path(t))[1], base_url="http://image-mcp:8080") as c:
            self.assertEqual(c.post("/mcp", json=INIT, headers={"Accept": "application/json"}).status_code, 401)
            self.assertEqual(c.get("/v1/files/abc", headers={"Authorization": "Bearer nope"}).status_code, 401)
            self.assertEqual(c.post("/mcp", json=INIT, headers=MCP_HEADERS).status_code, 200)

    def test_dns_rebinding_protection(self):
        with tempfile.TemporaryDirectory() as t, TestClient(make(Path(t))[1], base_url="http://image-mcp:8080") as c:
            self.assertEqual(c.post("/mcp", json=INIT, headers={**MCP_HEADERS, "Host": "evil.example"}).status_code, 421)
            self.assertEqual(c.post("/mcp", json=INIT, headers={**MCP_HEADERS, "Host": "image-mcp:8080"}).status_code, 200)

    def test_healthz_is_open(self):
        with tempfile.TemporaryDirectory() as t, TestClient(make(Path(t))[1], base_url="http://image-mcp:8080") as c:
            self.assertEqual(c.get("/healthz").json(), {"ok": True})

    def test_file_download_is_per_bot(self):
        with tempfile.TemporaryDirectory() as t:
            cfg, app = make(Path(t))
            store = Store(cfg.data_dir, cfg.bot_quota_bytes, cfg.max_file_bytes, cfg.file_ttl_hours)
            meta = store.put_bytes("bot-a", PNG, "mine.png")
            with TestClient(app, base_url="http://image-mcp:8080") as c:
                r = c.get(f"/v1/files/{meta['id']}", headers=AUTH_A)
                self.assertEqual(r.status_code, 200)
                self.assertEqual(r.content, PNG)
                self.assertEqual(c.get(f"/v1/files/{meta['id']}", headers=AUTH_B).status_code, 404)

    def test_rate_limit_returns_429(self):
        with tempfile.TemporaryDirectory() as t:
            _, app = make(Path(t), rate_per_min=2)
            with TestClient(app, base_url="http://image-mcp:8080") as c:
                codes = [c.post("/mcp", json=INIT, headers=MCP_HEADERS).status_code for _ in range(4)]
            self.assertIn(429, codes)
            self.assertLess(codes.count(200), 4)

    def test_generate_image_over_mcp(self):
        with tempfile.TemporaryDirectory() as t:
            _, app = make(Path(t))
            with TestClient(app, base_url="http://image-mcp:8080") as c:
                first = c.post("/mcp", json=INIT, headers=MCP_HEADERS)
                self.assertEqual(first.status_code, 200)
                sid = first.headers.get("mcp-session-id")
                if sid:
                    c.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"},
                           headers={**MCP_HEADERS, "Mcp-Session-Id": sid})
                r = mcp_call(c, "tools/call", {"name": "generate_image",
                                               "arguments": {"prompt": "a cat", "model": "m"}}, sid=sid)
                self.assertEqual(r.status_code, 200)
                payload = r.json()
                self.assertIn("result", payload, msg=payload)
                text = json.dumps(payload)
                self.assertIn("file_id", text)
                self.assertIn("image-1.png", text)

    def test_bad_model_over_mcp_is_a_coded_error(self):
        with tempfile.TemporaryDirectory() as t:
            _, app = make(Path(t))
            with TestClient(app, base_url="http://image-mcp:8080") as c:
                first = c.post("/mcp", json=INIT, headers=MCP_HEADERS)
                sid = first.headers.get("mcp-session-id")
                r = mcp_call(c, "tools/call", {"name": "generate_image",
                                               "arguments": {"prompt": "a cat", "model": "nope"}}, sid=sid)
                self.assertIn("invalid_model", json.dumps(r.json()))


if __name__ == "__main__":
    unittest.main()