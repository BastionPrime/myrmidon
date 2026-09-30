# tools/egress-proxy/tests/test_server.py
"""myrmidon(EGRESS-A): what the proxy does with a request, over a real socket.

Two requests go through a real proxy on 127.0.0.1 against real local targets: a
plain HTTP one (absolute-form request line) and a CONNECT tunnel. Both must
reach the destination and be recorded; a request for the proxy itself must be a
health probe and must not appear in the journal. A destination that does not
answer must be recorded as a failure and reported to the client as 502 — the
mode records, it does not refuse, so this is the only error path it has.
"""

from __future__ import annotations

import base64
import io
import json
import socket
import threading
import unittest
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from egress_proxy.config import BotEntry, Config
from egress_proxy.journal import DestinationJournal
from egress_proxy.server import EgressProxyServer

#: The harness closes sockets by letting them go out of scope; the proxy's own
#: per-request connections are the runtime's business, not a leak to report here.
warnings.simplefilter("ignore", ResourceWarning)


class _TargetHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        body = b"target says hello"
        self.send_response(200, "OK")
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        pass


class ProxyHarnessTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.journal_text = io.StringIO()
        self.proxy = EgressProxyServer(
            Config(
                mode="log",
                bind="127.0.0.1",
                port=0,
                connect_timeout_sec=2,
                bots={"agent-a": BotEntry(bot_key="agent-a", project="life")},
            ),
            DestinationJournal(self.journal_text, {"agent-a": BotEntry(bot_key="agent-a", project="life")}),
        )
        self.proxy_thread = threading.Thread(target=self.proxy.serve_forever, daemon=True)
        self.proxy_thread.start()

        self.target = ThreadingHTTPServer(("127.0.0.1", 0), _TargetHandler)
        self.target_thread = threading.Thread(target=self.target.serve_forever, daemon=True)
        self.target_thread.start()

        self.addCleanup(self.target.shutdown)
        self.addCleanup(self.proxy.shutdown)

    # -- helpers ----------------------------------------------------------

    @staticmethod
    def _basic(user: str) -> str:
        return "Basic " + base64.b64encode(f"{user}:egress".encode("utf-8")).decode("ascii")

    def _request(self, head: bytes, keep_open: bool = False) -> bytes:
        with socket.create_connection(("127.0.0.1", self.proxy.port), timeout=5) as sock:
            sock.sendall(head)
            sock.settimeout(5)
            chunks: list[bytes] = []
            while True:
                try:
                    chunk = sock.recv(65536)
                except socket.timeout:
                    break
                if not chunk:
                    break
                chunks.append(chunk)
                if not keep_open:
                    # The proxy answers with HTTP/1.0 and closes; one read is
                    # enough, but keep draining until the peer closes.
                    pass
            return b"".join(chunks)

    def _lines(self) -> list[dict]:
        return [json.loads(line) for line in self.journal_text.getvalue().splitlines() if line.strip()]


class PlainHttpTest(ProxyHarnessTestCase):
    def test_absolute_form_request_reaches_the_target_and_is_journalled(self) -> None:
        response = self._request(
            (
                f"GET http://127.0.0.1:{self.target.server_port}/hello HTTP/1.0\r\n"
                f"Host: 127.0.0.1:{self.target.server_port}\r\n"
                f"Proxy-Authorization: {self._basic('agent-a')}\r\n"
                "\r\n"
            ).encode("ascii")
        )
        self.assertIn(b"200", response.split(b"\r\n", 1)[0])
        self.assertIn(b"target says hello", response)

        lines = self._lines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["bot"], "agent-a")
        self.assertEqual(lines[0]["project"], "life")
        self.assertEqual(lines[0]["method"], "GET")
        self.assertEqual(lines[0]["scheme"], "http")
        self.assertEqual(lines[0]["destination"], "127.0.0.1")
        self.assertEqual(lines[0]["port"], self.target.server_port)
        self.assertEqual(lines[0]["result"], "ok")

    def test_a_request_without_a_proxy_user_is_still_served_and_recorded(self) -> None:
        response = self._request(
            f"GET http://127.0.0.1:{self.target.server_port}/hello HTTP/1.0\r\n\r\n".encode("ascii")
        )
        self.assertIn(b"target says hello", response)
        self.assertEqual(self._lines()[0]["bot"], "unknown")
        self.assertEqual(self._lines()[0]["project"], "")


class ConnectTest(ProxyHarnessTestCase):
    def test_connect_opens_a_tunnel_and_records_the_destination(self) -> None:
        with socket.create_connection(("127.0.0.1", self.proxy.port), timeout=5) as sock:
            sock.sendall(
                (
                    f"CONNECT 127.0.0.1:{self.target.server_port} HTTP/1.0\r\n"
                    f"Proxy-Authorization: {self._basic('agent-a')}\r\n"
                    "\r\n"
                ).encode("ascii")
            )
            head = sock.recv(4096)
            self.assertIn(b"200", head.split(b"\r\n", 1)[0])

            # Speak HTTP to the target through the tunnel.
            request = f"GET /hello HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n".encode("ascii")
            sock.sendall(request)
            sock.settimeout(5)
            payload = b""
            while b"target says hello" not in payload:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                payload += chunk
            self.assertIn(b"target says hello", payload)

        lines = self._lines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["method"], "CONNECT")
        self.assertEqual(lines[0]["scheme"], "https")
        self.assertEqual(lines[0]["port"], self.target.server_port)
        self.assertEqual(lines[0]["result"], "ok")

    def test_an_unreachable_destination_is_recorded_and_answered_with_502(self) -> None:
        # A port nothing listens on: closed socket on loopback.
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            dead_port = probe.getsockname()[1]

        response = self._request(f"CONNECT 127.0.0.1:{dead_port} HTTP/1.0\r\n\r\n".encode("ascii"))
        self.assertIn(b"502", response.split(b"\r\n", 1)[0])
        lines = self._lines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["bot"], "unknown")
        self.assertTrue(lines[0]["result"].startswith("error:"), lines[0]["result"])


class HealthTest(ProxyHarnessTestCase):
    def test_the_proxy_itself_is_a_health_probe_and_not_a_destination(self) -> None:
        response = self._request(b"GET /healthz HTTP/1.0\r\n\r\n")
        self.assertIn(b"200", response.split(b"\r\n", 1)[0])
        body = json.loads(response.split(b"\r\n\r\n", 1)[1])
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["mode"], "log")
        self.assertEqual(body["destinations"], 0)
        self.assertEqual(self._lines(), [])

    def test_any_other_local_path_is_404(self) -> None:
        response = self._request(b"GET /nothing-here HTTP/1.0\r\n\r\n")
        self.assertIn(b"404", response.split(b"\r\n", 1)[0])
        self.assertEqual(self._lines(), [])


if __name__ == "__main__":
    unittest.main()