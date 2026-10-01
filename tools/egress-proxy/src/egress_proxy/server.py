# tools/egress-proxy/src/egress_proxy/server.py
"""The fleet's forward proxy: journalled (EGRESS-A) and, per project, enforcing (EGRESS-B).

Two shapes of request arrive here, and both are treated the same way — recorded,
then either passed on or refused according to the policy:

  - plain HTTP, as an absolute-form request line (`GET http://host/path`),
    which is what a client that read `HTTP_PROXY` sends;
  - `CONNECT host:port`, which is what an HTTPS client sends first (curl,
    httpx, git, apt — all of them). The proxy sees the host and port and the
    tunnel carries TLS it never decrypts: that is the destination record this
    mode is after, without any certificate of ours inside a bot.

In mode `log` nothing is refused: a destination that does not answer is recorded
with the failure and reported to the client as 502, one that answers is recorded
and relayed. In mode `enforce`, a project whose policy says `block` also refuses
a destination that is on neither its list nor the bot's, and the refusal is
recorded with `result` `blocked` and answered as 403 — the bot sees the refusal,
and so does the board's refusal feed (`GET /refusals`, read by the board for the
project page). A request addressed to the proxy itself (a relative path) is a
health probe, not a destination, and is not journalled.
"""

from __future__ import annotations

import http.client
import json
import socket
import threading
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, cast
from urllib.parse import urlsplit

from .config import Config
from .journal import DestinationJournal, parse_proxy_user
from .policy import EgressPolicy, PolicyError, PolicyRefresher, load_policy_file

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

#: How many refused destinations the refusal feed keeps. The durable record is
#: the journal (the container log); this is what the board reads for the project
#: page, so a bounded ring is enough — and it keeps a busy project from growing
#: the process without a limit.
REFUSAL_FEED_LIMIT = 200

#: The `result` a refused destination is recorded with. The board's feed and the
#: project page key on it.
BLOCKED_RESULT = "blocked"


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

    def _project(self, bot: str) -> str:
        """The project the journal names for this bot.

        The board's policy wins over the local bots file: once the lists are
        managed from the board, a name typed in a file on the host would
        quietly disagree with the project whose list is being enforced.
        """
        from_policy = self.proxy.policy.project_of(bot)
        if from_policy:
            return from_policy
        entry = self.proxy.config.bots.get(bot)
        return entry.project if entry is not None else ""

    def _journal(self, *, bot: str, method: str, host: str, port: int, scheme: str, result: str) -> None:
        record = self.proxy.journal.record(
            bot=bot,
            method=method,
            host=host,
            port=port,
            scheme=scheme,
            result=result,
            project=self._project(bot),
        )
        self.proxy.journal.emit(record)
        if result == BLOCKED_RESULT:
            self.proxy.record_refusal(record)

    def _refuses(self, bot: str, host: str, port: int) -> bool:
        """Whether the policy refuses this destination for this bot.

        Only `enforce` asks at all: in `log` mode the service must behave exactly
        as EGRESS-A left it, whatever the document says — that is what makes the
        mode the rollback switch.
        """
        if self.proxy.config.mode != "enforce":
            return False
        return self.proxy.policy.decides_to_block(bot, host, port)

    # -- CONNECT ----------------------------------------------------------

    def do_CONNECT(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's naming
        bot = self._bot()
        host, port = _split_host_port(self.path, default_port=443)
        if not host:
            self.send_error(400, "CONNECT needs host:port")
            return
        if self._refuses(bot, host, port):
            # myrmidon(EGRESS-B): recorded before answering, so a refusal is
            # visible both in the journal and on the project page.
            self._journal(bot=bot, method="CONNECT", host=host, port=port, scheme="https", result=BLOCKED_RESULT)
            self.send_error(403, "destination is not on this project's egress list")
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

        if self._refuses(bot, host, port):
            # myrmidon(EGRESS-B): refused before the body is read and before any
            # upstream connection, so a blocked POST never leaves the container.
            self._journal(bot=bot, method=self.command, host=host, port=port, scheme="http", result=BLOCKED_RESULT)
            self.send_error(403, "destination is not on this project's egress list")
            return

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
                    "projects": len(self.proxy.policy.projects),
                    "policy_revision": self.proxy.policy_revision,
                    "policy_error": self.proxy.policy_error,
                },
                separators=(",", ":"),
            ).encode("utf-8")
            self.send_response(200, "OK")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parts.path == "/refusals":
            # myrmidon(EGRESS-B): what the board reads for the project page. The
            # durable record stays the journal; this is the recent tail.
            body = json.dumps({"refusals": self.proxy.refusals()}, separators=(",", ":")).encode("utf-8")
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
    """One process, one journal, one settings object, one policy."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        config: Config,
        journal: DestinationJournal | None = None,
        policy: EgressPolicy | None = None,
        refresher: PolicyRefresher | None = None,
    ) -> None:
        super().__init__((config.bind, config.port), EgressProxyHandler)
        self.config = config
        self.journal = journal if journal is not None else DestinationJournal(bots=config.bots)
        self.refresher = refresher
        self._policy = policy if policy is not None else EgressPolicy()
        self._refusals: deque[dict[str, Any]] = deque(maxlen=REFUSAL_FEED_LIMIT)
        self._refusals_lock = threading.Lock()

    @property
    def port(self) -> int:
        return int(self.server_address[1])

    @property
    def policy(self) -> EgressPolicy:
        """The current list. Read per request; the refresher swaps it whole."""
        if self.refresher is not None:
            return self.refresher.policy
        return self._policy

    @property
    def policy_revision(self) -> int:
        return self.refresher.revision if self.refresher is not None else 0

    @property
    def policy_error(self) -> str | None:
        return self.refresher.last_error if self.refresher is not None else None

    def record_refusal(self, record: dict[str, Any]) -> None:
        with self._refusals_lock:
            self._refusals.append(record)

    def refusals(self) -> list[dict[str, Any]]:
        with self._refusals_lock:
            return list(self._refusals)


def build_policy(config: Config, on_error: Any = None) -> tuple[EgressPolicy, PolicyRefresher | None]:
    """The policy the service starts with, and the refresher that keeps it current.

    A file is read once (the operator's copy, useful on a stand that has no
    board). A URL is fetched once before the socket opens and again on a timer:
    a document that is wrong at startup must stop the service, not be replaced
    by an empty one — an enforcing proxy with no policy would block a project by
    accident. A refresh that fails later keeps the last good document.
    """
    if config.policy_url:
        refresher = PolicyRefresher(
            url=config.policy_url,
            token=config.policy_token or None,
            interval_sec=config.policy_refresh_sec,
            on_error=on_error,
        )
        refresher.refresh_once()
        if refresher.last_error is not None:
            raise PolicyError(refresher.last_error)
        return refresher.policy, refresher
    if config.policy_file:
        return load_policy_file(config.policy_file), None
    return EgressPolicy(), None


def serve(config: Config) -> None:
    refresher: PolicyRefresher | None = None
    try:
        policy, refresher = build_policy(
            config,
            on_error=lambda message: print(f"egress-proxy: policy refresh failed: {message}", flush=True),
        )
    except (PolicyError, OSError) as exc:
        raise SystemExit(f"egress-proxy: cannot read the egress policy: {exc}") from exc

    server = EgressProxyServer(config, policy=policy, refresher=refresher)
    if refresher is not None:
        refresher.start()
    print(
        f"egress-proxy: mode={config.mode} listening on {config.bind}:{server.port} "
        f"bots_in_map={len(config.bots)} projects={len(policy.projects)} "
        f"policy_url={config.policy_url or '-'} policy_file={config.policy_file or '-'}"
        + (
            " (log-only: every destination is recorded, none is refused)"
            if config.mode == "log"
            else " (enforce: a project in block mode refuses destinations that are not on its list)"
        ),
        flush=True,
    )
    server.serve_forever()