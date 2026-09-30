import hashlib
import json
import tempfile
import time
import unittest
from pathlib import Path

import httpx
from starlette.testclient import TestClient

from cloud_files.auth import PeerResolver
from cloud_files.config import ConfigError, Settings, load_acl
from cloud_files.paths import PathError, split_path
from cloud_files.server import build_app

ACL = {
    "roots": {
        "sources": {"kind": "shared", "drive_id": "D1", "item_id": "D1!sroot", "description": "shared"},
        "bot-a": {"kind": "own", "folder": "Bots/a"},
        "bot-b": {"kind": "own", "folder": "Bots/b"},
    },
    "bots": {
        "agent-a": {"label": "a", "peer_host": "bot-a-host", "drive": {"sources": "ro", "bot-a": "rw"}, "mail": "send"},
        "agent-b": {"label": "b", "peer_host": "bot-b-host", "drive": {"bot-b": "rw"}, "mail": "none"},
        "agent-c": {"label": "c", "peer_host": "bot-c-host", "drive": {"sources": "ro"}, "mail": "read"},
    },
}
GW = {"Authorization": "Bearer gw-secret", "x-paperclip-agent-id": "agent-a"}
INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
    "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}
H = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


class Resolver(PeerResolver):
    def addrs(self, host):
        return {"bot-a-host": {"192.0.2.1"}, "bot-b-host": {"192.0.2.2"}, "bot-c-host": {"192.0.2.3"}}.get(host, set())


def graph_handler(calls):
    def h(req: httpx.Request) -> httpx.Response:
        u = str(req.url)
        calls.append((req.method, req.url.path))
        if "/children" in u:
            return httpx.Response(200, json={"value": [{"name": "RQ002", "folder": {"childCount": 2}, "lastModifiedDateTime": "2026-09-01T00:00:00Z"}]})
        if req.url.path.endswith("/content"):
            return httpx.Response(200, content=b"hello world")
        if "clip.txt" in u or "/items/F1" in u:
            return httpx.Response(200, json={"id": "F1", "name": "clip.txt", "size": 11, "file": {}, "parentReference": {"driveId": "D1"}})
        if "/sendMail" in u:
            return httpx.Response(202)
        if "/me/mailFolders/inbox/messages" in u:
            return httpx.Response(200, json={"value": [{"id": "M" * 12, "subject": "s", "from": {"emailAddress": {"address": "x@y.z"}}, "receivedDateTime": "2026-09-30T00:00:00Z", "isRead": False}]})
        return httpx.Response(200, json={"id": "F1", "name": "x", "folder": {"childCount": 1}, "parentReference": {"driveId": "D1"}})
    return h


class Env:
    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = Path(self.tmp.name)
        (t / "bots.json").write_text(json.dumps(ACL))
        (t / "token.json").write_text(json.dumps({"access_token": "at", "refresh_token": "rt", "expires_at": time.time() + 3000}))
        roots, bots = load_acl(t / "bots.json")
        self.cfg = Settings(state_dir=t, roots=roots, bots=bots, client_id="cid",
                            gateway_token_sha256=hashlib.sha256(b"gw-secret").hexdigest(),
                            allowed_hosts=("cloud-files", "cloud-files:8080", "testserver"))
        self.calls: list = []
        self.app = build_app(self.cfg, transport=httpx.MockTransport(graph_handler(self.calls)))
        import cloud_files.server as srv
        # bots are recognised by peer address; tests pin the resolver
        for m in self.app.user_middleware:
            if getattr(m.cls, "__name__", "") == "AuthMiddleware":
                m.kwargs["auth"].resolver = Resolver()

    def call(self, client, tool, args, headers=None):
        hd = {**H, **(headers or GW)}
        r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": tool, "arguments": args}}, headers=hd)
        return r.json()


class AclTests(unittest.TestCase):
    def test_path_traversal_refused(self):
        for bad in ("../x", "a/../../b", "a\\..\\b", "a/b:c"):
            with self.assertRaises(PathError):
                split_path(bad)
        self.assertEqual(split_path("/a//b/./c/"), ["a", "b", "c"])

    def test_config_rejects_write_on_shared_root(self):
        with tempfile.TemporaryDirectory() as t:
            bad = json.loads(json.dumps(ACL))
            bad["bots"]["agent-a"]["drive"]["sources"] = "rw"
            p = Path(t) / "b.json"
            p.write_text(json.dumps(bad))
            with self.assertRaises(ConfigError):
                load_acl(p)

    def test_foreign_root_denied_and_no_graph_call(self):
        e = Env()
        with TestClient(e.app, base_url="http://cloud-files:8080") as c:
            out = e.call(c, "drive_list", {"root": "bot-b"})
            self.assertTrue(out["result"]["isError"])
            self.assertIn("access denied", out["result"]["content"][0]["text"])
        self.assertEqual(e.calls, [])

    def test_read_only_root_refuses_upload_and_move(self):
        e = Env()
        with TestClient(e.app, base_url="http://cloud-files:8080") as c:
            for tool, args in (("drive_upload", {"root": "sources", "path": "x.txt", "text": "t"}),
                               ("drive_mkdir", {"root": "sources", "path": "x"}),
                               ("drive_move", {"root": "sources", "path": "a", "to_path": "b"})):
                out = e.call(c, tool, args)
                self.assertTrue(out["result"]["isError"], tool)
                self.assertIn("read only", out["result"]["content"][0]["text"])
        self.assertEqual(e.calls, [])

    def test_list_in_allowed_root(self):
        e = Env()
        with TestClient(e.app, base_url="http://cloud-files:8080") as c:
            out = e.call(c, "drive_list", {"root": "sources"})
            self.assertFalse(out["result"].get("isError"), out)

    def test_mail_modes(self):
        e = Env()
        with TestClient(e.app, base_url="http://cloud-files:8080") as c:
            b = {"Authorization": "Bearer gw-secret", "x-paperclip-agent-id": "agent-b"}
            cc = {"Authorization": "Bearer gw-secret", "x-paperclip-agent-id": "agent-c"}
            self.assertTrue(e.call(c, "mail_list", {}, b)["result"]["isError"])
            self.assertFalse(e.call(c, "mail_list", {}, cc)["result"].get("isError"))
            out = e.call(c, "mail_send", {"to": ["a@b.co"], "subject": "s", "body": "b"}, cc)
            self.assertTrue(out["result"]["isError"])
            self.assertIn("may not send", out["result"]["content"][0]["text"])
            ok = e.call(c, "mail_send", {"to": ["a@b.co"], "subject": "s", "body": "b"})
            self.assertFalse(ok["result"].get("isError"), ok)


class AuthTests(unittest.TestCase):
    def test_wrong_bearer_and_unknown_agent(self):
        e = Env()
        with TestClient(e.app, base_url="http://cloud-files:8080") as c:
            self.assertEqual(c.post("/mcp", json=INIT, headers={**H, "Authorization": "Bearer nope"}).status_code, 401)
            out = e.call(c, "cloud_whoami", {}, {"Authorization": "Bearer gw-secret", "x-paperclip-agent-id": "stranger"})
            self.assertTrue(out["result"]["isError"])

    def test_file_transfer_only_from_bot_peer(self):
        e = Env()
        with TestClient(e.app, base_url="http://cloud-files:8080", client=("192.0.2.1", 5000)) as c:
            r = c.put("/v1/files?name=a.txt", content=b"abc")
            self.assertEqual(r.status_code, 201)
            fid = r.json()["id"]
            self.assertEqual(c.get(f"/v1/files/{fid}").content, b"abc")
        c = TestClient(e.app, base_url="http://cloud-files:8080", client=("192.0.2.2", 5000))
        self.assertEqual(c.get(f"/v1/files/{fid}").status_code, 404)  # another bot never sees it
        c = TestClient(e.app, base_url="http://cloud-files:8080", client=("192.0.2.99", 5000))
        if True:
            self.assertEqual(c.put("/v1/files?name=a", content=b"x", headers=GW).status_code, 403)
            self.assertEqual(c.put("/v1/files?name=a", content=b"x").status_code, 401)

    def test_download_stages_and_is_private(self):
        e = Env()
        with TestClient(e.app, base_url="http://cloud-files:8080") as c:
            out = e.call(c, "drive_download", {"root": "sources", "path": "RQ002/clip.txt"})
            self.assertFalse(out["result"].get("isError"), out)
            fid = json.loads(out["result"]["content"][0]["text"])["file_id"]
        c = TestClient(e.app, base_url="http://cloud-files:8080", client=("192.0.2.1", 1))
        self.assertEqual(c.get(f"/v1/files/{fid}").content, b"hello world")

    def test_dns_rebinding_host_refused(self):
        e = Env()
        with TestClient(e.app, base_url="http://cloud-files:8080") as c:
            self.assertEqual(c.post("/mcp", json=INIT, headers={**H, **GW, "Host": "evil.example"}).status_code, 421)


if __name__ == "__main__":
    unittest.main()
