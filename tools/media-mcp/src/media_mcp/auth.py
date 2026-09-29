"""Per-bot authentication (bearer token and/or docker-DNS peer address) and rate limiting."""

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
    """Peer host name -> set of addresses via docker's embedded DNS, cached briefly."""

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

    def identify(self, bearer: str | None, peer_ip: str | None) -> BotPolicy | None:
        digest = hashlib.sha256(bearer.encode()).hexdigest() if bearer else None
        found: BotPolicy | None = None
        for bot in self.cfg.bots.values():
            token_ok = bool(digest and bot.token_sha256 and hmac.compare_digest(digest, bot.token_sha256))
            peer_ok = bool(peer_ip and bot.peer_host and peer_ip in self.resolver.addrs(bot.peer_host))
            if bot.token_sha256 and bot.peer_host:
                ok = token_ok and peer_ok
            elif bot.token_sha256:
                ok = token_ok
            else:
                ok = peer_ok  # peer-only bot: a bearer, if any, is ignored
            if ok:
                found = bot  # keep scanning: constant work, no early exit on the secret compare
        return found

    def allow(self, bot: BotPolicy) -> bool:
        limit = bot.rate_per_min or self.cfg.rate_per_min
        now = time.monotonic()
        q = self.hits.setdefault(bot.key, deque())
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= limit:
            return False
        q.append(now)
        return True


class AuthMiddleware:
    def __init__(self, app, auth: Authenticator):
        self.app, self.auth = app, auth

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] == "/healthz":
            return await self.app(scope, receive, send)
        headers = {k.decode().lower(): v.decode() for k, v in scope["headers"]}
        bearer = headers.get("authorization", "")
        bearer = bearer[7:].strip() if bearer.lower().startswith("bearer ") else None
        peer = (scope.get("client") or (None,))[0]
        bot = self.auth.identify(bearer, peer)
        if bot is None:
            return await JSONResponse({"error": "unauthorized"}, status_code=401)(scope, receive, send)
        if not self.auth.allow(bot):
            return await JSONResponse({"error": "rate limit"}, status_code=429, headers={"Retry-After": "10"})(
                scope, receive, send
            )
        tok = current_bot.set(bot)
        try:
            await self.app(scope, receive, send)
        finally:
            current_bot.reset(tok)
