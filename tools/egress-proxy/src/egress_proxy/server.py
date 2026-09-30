# tools/egress-proxy/src/egress_proxy/server.py
"""The log-only forward proxy (EGRESS-A).

Two shapes of request arrive here, and both are served the same way — recorded,
then passed on, whatever the destination:

  - plain HTTP, as an absolute-form request line (`GET http://host/path`),
    which is what a client that read `HTTP_PROXY` sends;
  - `CONNECT host:port`, which is what an HTTPS client sends first (curl,
    httpx, git, apt — all of them). The proxy sees the host and port and the
    tunnel carries TLS it never decrypts: that is the destination record this
    mode is after, without any certificate of ours inside a bot.

Nothing is refused. A destination that does not answer is recorded with the
failure and reported to the client as 502; a destination that answers is
recorded and relayed. A request addressed to the proxy itself (a relative path)
is a health probe, not a destination, and is not journalled.
"""

from __future__ import annotations

import http.client
import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, cast
from urllib.parse import urlsplit

from .config import Config
from .journal import DestinationJournal, parse_proxy_user

#: Headers that belong to the client-proxy hop (RFC 9110 §7.6.1) plus the one
#: credential a proxy request carries; none of them is forwarded upstream.
HOP_BY_HOP_HEADERS = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "proxy-connection",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)

MAX_REQUEST_BYTES = 64 * 1024 * 1024


class _Tunnel:
    """Copies bytes both ways between the client socket and the upstream one."""

    def __init__(self, client: socket.socket, upstream: socket.socket) -> None:
        self.client = client
        self.upstream = upstream

    @staticmethod
    def _pump(source: socket.socket, sink: socket.socket) -> None:
        try:
            while True:
                chunk = source.recv(65536)
                if not chunk:
                    break
                sink.sendall(chunk)
        except OSError:
            pass
        finally:
            try:
                sink.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    def run(self) -> None:
        upstream_to_client = threading.Thread(target=self._pump, args=(self.upstream, self.client), daemon=True)
        upstream_to_client.start()
        self._pump(self.client, self.upstream)
        upstream_to_client.join(timeout=5)
        for sock in (self.client, self.upstream):
            try:
                sock.close()
            except OSError:
                pass


class EgressProxyHandler(BaseHTTPRequestHandler):
    """Serves one connection. `server` is an `EgressProxyServer`."""

    protocol_version = "HTTP/1.0"
    server_version = "myrmidon-egress-proxy"
    sys_version = ""

    @property
    def proxy(self) -> "EgressProxyServer":
        return cast("EgressProxyServer", self.server)

    # -- journal ----------------------------------------------------------

    def _bot(self) -> str:
        return parse_proxy_user(self.headers.get("Proxy-Authorization"))

    def _journal(self, *, bot: str, method: str, host: str, port: int, scheme: str, result: str) -> None:
        record = self.proxy.journal.record(bot=bot, method=method, host=host, port=port, scheme=scheme, result=result)
        self.proxy.journal.emit(record)

    # -- CONNECT ----------------------------------------------------------

    def do_CONNECT(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's naming
        bot = self._bot()
        host, port = _split_host_port(self.path, default_port=443)
        if not host:
            self.send_error(400, "CONNECT needs host:port")
            return
        try:
            upstream = socket.create_connection((host, port), self.proxy.config.connect_timeout_sec)
        except OSError as exc:
            self._journal(bot=bot, method="CONNECT", host=host, port=port, scheme="https", result=f"error:{exc.errno or 0}")
            self.send_error(502, "cannot reach the destination")
            return
        self._journal(bot=bot, method="CONNECT", host=host, port=port, scheme="https", result="ok")
        self.send_response(200, "Connection Established")
        self.end_headers()
        self.close_connection = True
        _Tunnel(self.connection, upstream).run()

    # -- plain HTTP -------------------------------------------------------

    def _handle_forward(self) -> None:
        bot = self._bot()
        parts = urlsplit(self.path)
        if parts.scheme not in ("http",) or not parts.hostname:
            # A request for the proxy itself: the only one that is not a
            # destination. Used by the container health check.
            self._handle_local(parts)
            return
        host = parts.hostname
        port = parts.port or 80
        path = parts.path or "/"
        if parts.query:
            path = f"{path}?{parts.query}"

        body = self._read_body()
        upstream: http.client.HTTPConnection | None = None
        try:
            upstream = http.client.HTTPConnection(host, port, timeout=self.proxy.config.connect_timeout_sec)
            upstream.request(self.command, path, body=body, headers=self._forward_headers())
            response = upstream.getresponse()
            payload = response.read()
        except (OSError, http.client.HTTPException) as exc:
            self._journal(bot=bot, method=self.command, host=host, port=port, scheme="http", result=f"error:{type(exc).__name__}")
            self.send_error(502, "cannot reach the destination")
            return
        finally:
            if upstream is not None:
                try:
                    upstream.close()
                except OSError:
                    pass
        self._journal(bot=bot, method=self.command, host=host, port=port, scheme="http", result="ok")

        self.send_response(response.status, response.reason)
        for name, value in response.getheaders():
            if name.lower() in HOP_BY_HOP_HEADERS or name.lower() == "content-length":
                continue
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)
        self.close_connection = True

    def _read_body(self) -> bytes | None:
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            return None
        try:
            length = int(raw_length)
        except ValueError:
            return None
        if length <= 0:
            return None
        return self.rfile.read(min(length, MAX_REQUEST_BYTES))

    def _forward_headers(self) -> dict[str, str]:
        headers: dict[str, str] = {}
        for name, value in self.headers.items():
            if name.lower() in HOP_BY_HOP_HEADERS:
                continue
            headers[name] = value
        return headers

    def _handle_local(self, parts: Any) -> None:
        if parts.path in ("/healthz", "/"):
            body = json.dumps(
                {
                    "status": "ok",
                    "mode": self.proxy.config.mode,
                    "destinations": self.proxy.journal.count,
                    "bots": len(self.proxy.config.bots),
                },
                separators=(",", ":"),
            ).encode("utf-8")
            self.send_response(200, "OK")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404, "this is a forward proxy; it has no pages of its own")

    def do_GET(self) -> None:  # noqa: N802
        self._handle_forward()

    def do_HEAD(self) -> None:  # noqa: N802
        self._handle_forward()

    def do_POST(self) -> None:  # noqa: N802
        self._handle_forward()

    def do_PUT(self) -> None:  # noqa: N802
        self._handle_forward()

    def do_PATCH(self) -> None:  # noqa: N802
        self._handle_forward()

    def do_DELETE(self) -> None:  # noqa: N802
        self._handle_forward()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._handle_forward()

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        """The journal is the record; the ACCESS-LOG line would only repeat it
        and would print the absolute URL, which carries query strings (tokens
        included, in some APIs). Errors still reach stderr through base's
        `log_error`."""

    def log_error(self, format: str, *args: Any) -> None:  # noqa: A002
        message = format % args
        print(f"{self.address_string()} {message}", flush=True)


def _split_host_port(authority: str, *, default_port: int) -> tuple[str, int]:
    authority = authority.strip()
    if authority.startswith("["):  # [::1]:443
        host, _, rest = authority[1:].partition("]")
        _, _, raw_port = rest.partition(":")
        return host, _int_or(raw_port, default_port)
    host, sep, raw_port = authority.partition(":")
    return host.strip(), _int_or(raw_port if sep else "", default_port)


def _int_or(raw: str, default: int) -> int:
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if 0 < value < 65536 else default


class EgressProxyServer(ThreadingHTTPServer):
    """One process, one journal, one settings object."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, config: Config, journal: DestinationJournal | None = None) -> None:
        super().__init__((config.bind, config.port), EgressProxyHandler)
        self.config = config
        self.journal = journal if journal is not None else DestinationJournal(bots=config.bots)

    @property
    def port(self) -> int:
        return int(self.server_address[1])


def serve(config: Config) -> None:
    server = EgressProxyServer(config)
    print(
        f"egress-proxy: mode={config.mode} listening on {config.bind}:{server.port} "
        f"bots_in_map={len(config.bots)} (log-only: every destination is recorded, none is refused)",
        flush=True,
    )
    server.serve_forever()