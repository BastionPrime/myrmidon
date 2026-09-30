"""Microsoft identity (device code, refresh) and a small Graph client. The token never leaves this module."""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path

import httpx

GRAPH = "https://graph.microsoft.com/v1.0"
LOGIN = "https://login.microsoftonline.com"


class GraphError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class NotAuthorized(GraphError):
    """The connector has no valid Microsoft token yet (the owner has not signed in)."""


class TokenStore:
    def __init__(self, state_dir: Path, client_id: str, tenant: str, scopes: str):
        self.path = state_dir / "token.json"
        self.client_id, self.tenant, self.scopes = client_id, tenant, scopes
        self._lock = asyncio.Lock()

    def _read(self) -> dict | None:
        try:
            return json.loads(self.path.read_text())
        except (FileNotFoundError, ValueError):
            return None

    def _write(self, data: dict) -> None:
        tmp = self.path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(data, f)
        os.replace(tmp, self.path)
        os.chmod(self.path, 0o600)

    def store_response(self, resp: dict) -> None:
        old = self._read() or {}
        self._write({
            "access_token": resp["access_token"],
            "refresh_token": resp.get("refresh_token") or old.get("refresh_token"),
            "expires_at": time.time() + int(resp.get("expires_in", 3600)),
            "scope": resp.get("scope", old.get("scope", "")),
        })

    def status(self) -> dict:
        t = self._read()
        if not t or not t.get("refresh_token"):
            return {"authorized": False}
        return {"authorized": True, "scope": t.get("scope", ""), "access_valid_s": max(0, int(t.get("expires_at", 0) - time.time()))}

    async def access_token(self, client: httpx.AsyncClient, force: bool = False) -> str:
        async with self._lock:
            t = self._read()
            if not t or not t.get("refresh_token"):
                raise NotAuthorized(503, "Microsoft 365 is not connected yet: the owner has to sign in once (device code)")
            if not force and t.get("access_token") and t.get("expires_at", 0) - time.time() > 300:
                return t["access_token"]
            r = await client.post(f"{LOGIN}/{self.tenant}/oauth2/v2.0/token", data={
                "client_id": self.client_id, "grant_type": "refresh_token",
                "refresh_token": t["refresh_token"], "scope": self.scopes})
            body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
            if r.status_code != 200:
                if body.get("error") in ("invalid_grant", "interaction_required"):
                    raise NotAuthorized(503, "Microsoft 365 sign-in expired: the owner has to sign in again (device code)")
                raise GraphError(502, f"token refresh failed: {body.get('error', r.status_code)}")
            self.store_response(body)
            return body["access_token"]


class Graph:
    def __init__(self, tokens: TokenStore, transport: httpx.AsyncBaseTransport | None = None):
        self.tokens = tokens
        self.http = httpx.AsyncClient(timeout=httpx.Timeout(60, connect=15), transport=transport)

    async def aclose(self) -> None:
        await self.http.aclose()

    async def request(self, method: str, url: str, *, retry: bool = True, **kw) -> httpx.Response:
        if url.startswith("/"):
            url = GRAPH + url
        headers = dict(kw.pop("headers", {}) or {})
        for attempt in range(4):
            tok = await self.tokens.access_token(self.http, force=False)
            r = await self.http.request(method, url, headers={**headers, "Authorization": f"Bearer {tok}"}, **kw)
            if r.status_code == 401 and attempt == 0:
                await self.tokens.access_token(self.http, force=True)
                continue
            if r.status_code in (429, 503) and retry and attempt < 3:
                await asyncio.sleep(min(int(r.headers.get("Retry-After", "2") or 2), 20))
                continue
            return r
        return r

    async def stream_get(self, url: str):
        """Download body chunks. The pre-authenticated redirect target gets no bearer."""
        if url.startswith("/"):
            url = GRAPH + url
        tok = await self.tokens.access_token(self.http)
        async with self.http.stream("GET", url, headers={"Authorization": f"Bearer {tok}"}, follow_redirects=True) as r:
            if r.status_code != 200:
                await r.aread()
                raise graph_error(r)
            async for chunk in r.aiter_bytes(1 << 20):
                yield chunk

    async def json(self, method: str, url: str, ok: tuple[int, ...] = (200, 201, 202, 204), **kw) -> dict:
        r = await self.request(method, url, **kw)
        if r.status_code not in ok:
            raise graph_error(r)
        return r.json() if r.content else {}


def graph_error(r: httpx.Response) -> GraphError:
    try:
        err = r.json().get("error", {})
        code, msg = err.get("code", ""), err.get("message", "")
    except ValueError:
        code, msg = "", ""
    if r.status_code == 404:
        return GraphError(404, "not found")
    if r.status_code in (401, 403):
        return GraphError(r.status_code, f"Microsoft refused the request ({code or r.status_code})")
    return GraphError(r.status_code, f"Microsoft Graph error {r.status_code} {code}: {msg[:200]}")


async def device_code_login(tokens: TokenStore, out_file: Path) -> int:
    """CLI: get a device code, write it (not secret) to out_file, poll until the owner signs in."""
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(f"{LOGIN}/{tokens.tenant}/oauth2/v2.0/devicecode",
                         data={"client_id": tokens.client_id, "scope": tokens.scopes})
        if r.status_code != 200:
            print("devicecode request failed:", r.status_code, r.text[:300])
            return 2
        d = r.json()
        out_file.write_text(json.dumps({k: d[k] for k in ("user_code", "verification_uri", "expires_in", "interval")}
                                       | {"created": int(time.time())}))
        deadline = time.time() + int(d["expires_in"])
        interval = int(d.get("interval", 5))
        while time.time() < deadline:
            await asyncio.sleep(interval)
            p = await c.post(f"{LOGIN}/{tokens.tenant}/oauth2/v2.0/token", data={
                "client_id": tokens.client_id, "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "device_code": d["device_code"]})
            body = p.json()
            if p.status_code == 200:
                tokens.store_response(body)
                me = await c.get(f"{GRAPH}/me?$select=userPrincipalName",
                                 headers={"Authorization": f"Bearer {body['access_token']}"})
                acct = me.json().get("userPrincipalName", "?") if me.status_code == 200 else "?"
                (out_file.parent / "auth-status.json").write_text(json.dumps(
                    {"account": acct, "scope": body.get("scope", ""), "at": int(time.time())}))
                print("authorized", acct)
                return 0
            err = body.get("error")
            if err == "authorization_pending":
                continue
            if err == "slow_down":
                interval += 5
                continue
            print("device code failed:", err)
            return 3
        print("device code expired")
        return 4
