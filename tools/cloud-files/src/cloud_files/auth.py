"""Who is calling. Two ways in:
 - a bot's own container (docker DNS name of the bot must resolve to the peer address): MCP and file transfer;
 - the board's tool gateway: shared bearer + the agent id the board forwards (x-paperclip-agent-id): MCP only.
A bearer without a known agent id may list tools (catalog, health) but cannot call them."""

from __future__ import annotations

import contextvars
import hashlib
import hmac
import socket
import time
from collections import deque

from starlette.responses import JSONResponse

from .config import BotPolicy, Settings

current_bot: contextvars.ContextVar[BotPolicy | None] = contextvars.ContextVar("current_bot", default=None)


class PeerResolver:
    def __init__(self, ttl: float = 20.0):
        self.ttl = ttl
        self._cache: dict[str, tuple[float, set[str]]] = {}

    def addrs(self, host: str) -> set[str]:
        now = time.monotonic()
        hit = self._cache.get(host)
        if hit and now - hit[0] < self.ttl:
            return hit[1]
        try:
            found = {ai[4][0] for ai in socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)}
        except OSError:
            found = set()
        self._cache[host] = (now, found)
        return found


class Authenticator:
    def __init__(self, cfg: Settings, resolver: PeerResolver | None = None):
        self.cfg = cfg
        self.resolver = resolver or PeerResolver()
        self.hits: dict[str, deque[float]] = {}

    def by_peer(self, peer_ip: str | None) -> BotPolicy | None:
        found = None
        if peer_ip:
            for bot in self.cfg.bots.values():
                if bot.peer_host and peer_ip in self.resolver.addrs(bot.peer_host):
                    found = bot
        return found

    def gateway_ok(self, bearer: str | None) -> bool:
        want = self.cfg.gateway_token_sha256
        if not (want and bearer):
            return False
        return hmac.compare_digest(hashlib.sha256(bearer.encode()).hexdigest(), want)

    def allow(self, key: str, limit: int) -> bool:
        now = time.monotonic()
        q = self.hits.setdefault(key, deque())
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= limit:
            return False
        q.append(now)
        return True


class AuthMiddleware:
    def __init__(self, app, auth: Authenticator):
        self.app, self.auth = app, auth

    async def _deny(self, scope, receive, send, code, msg, headers=None):
        return await JSONResponse({"error": msg}, status_code=code, headers=headers)(scope, receive, send)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] == "/healthz":
            return await self.app(scope, receive, send)
        h = {k.decode().lower(): v.decode() for k, v in scope["headers"]}
        bearer = h.get("authorization", "")
        bearer = bearer[7:].strip() if bearer.lower().startswith("bearer ") else None
        peer = (scope.get("client") or (None,))[0]
        bot = self.auth.by_peer(peer)
        via_gateway = False
        if bot is None and self.auth.gateway_ok(bearer):
            via_gateway = True
            bot = self.auth.cfg.bots.get(h.get("x-paperclip-agent-id", ""))
        elif bot is None:
            return await self._deny(scope, receive, send, 401, "unauthorized")
        if via_gateway and not scope["path"].startswith("/mcp"):
            return await self._deny(scope, receive, send, 403, "file transfer is only open to the bot's own container")
        key = bot.key if bot else "_gateway"
        limit = (bot.rate_per_min if bot else None) or self.auth.cfg.rate_per_min
        if not self.auth.allow(key, limit):
            return await self._deny(scope, receive, send, 429, "rate limit", {"Retry-After": "10"})
        tok = current_bot.set(bot)
        try:
            await self.app(scope, receive, send)
        finally:
            current_bot.reset(tok)
