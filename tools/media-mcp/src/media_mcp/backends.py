"""Clients for the ready-made backends (Gotenberg, Tika) and for our worker."""

from __future__ import annotations

import httpx

from .config import Settings


class BackendError(Exception):
    """Safe to show the bot."""


class Backends:
    def __init__(self, cfg: Settings):
        self.cfg = cfg
        t = httpx.Timeout(cfg.backend_timeout_s + 60, connect=5)
        self.http = httpx.AsyncClient(timeout=t)
        self.gotenberg_slots = __import__("asyncio").Semaphore(2)
        self.tika_slots = __import__("asyncio").Semaphore(2)

    async def aclose(self) -> None:
        await self.http.aclose()

    # -- Gotenberg
    async def gotenberg(self, route: str, files: list[tuple[str, tuple[str, object, str]]], fields: dict[str, str]) -> bytes:
        async with self.gotenberg_slots:
            try:
                r = await self.http.post(f"{self.cfg.gotenberg_url}{route}", files=files, data=fields)
            except httpx.HTTPError as e:
                raise BackendError(f"document converter unavailable ({type(e).__name__})") from None
        if r.status_code != 200:
            raise BackendError(f"document converter refused the file (HTTP {r.status_code}): {r.text[:300]}")
        return r.content

    # -- Tika
    async def tika_text(self, name: str, data, ocr: bool) -> str:
        headers = {
            "Accept": "text/plain",
            "Content-Disposition": f'attachment; filename="{name}"',
            "X-Tika-OCRLanguage": "rus+eng",
            "X-Tika-PDFOcrStrategy": "auto" if ocr else "no_ocr",
        }
        if not ocr:
            headers["X-Tika-OCRskipOcr"] = "true"
        async with self.tika_slots:
            try:
                r = await self.http.put(f"{self.cfg.tika_url}/tika", content=data, headers=headers)
            except httpx.HTTPError as e:
                raise BackendError(f"text extractor unavailable ({type(e).__name__})") from None
        if r.status_code == 204:
            return ""
        if r.status_code != 200:
            raise BackendError(f"text extractor failed (HTTP {r.status_code})")
        return r.text

    # -- worker
    def _wh(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.cfg.worker_token}"}

    async def worker_submit(self, bot: str, job: str, kind: str, spec: dict) -> dict:
        try:
            r = await self.http.post(f"{self.cfg.worker_url}/v1/jobs", headers=self._wh(),
                                     json={"bot": bot, "job": job, "kind": kind, "spec": spec})
        except httpx.HTTPError as e:
            raise BackendError(f"media worker unavailable ({type(e).__name__})") from None
        if r.status_code >= 400:
            raise BackendError(r.json().get("error", f"worker HTTP {r.status_code}") if r.headers.get("content-type", "").startswith("application/json") else f"worker HTTP {r.status_code}")
        return r.json()

    async def worker_status(self, bot: str, job: str) -> dict:
        try:
            r = await self.http.get(f"{self.cfg.worker_url}/v1/jobs/{bot}/{job}", headers=self._wh())
        except httpx.HTTPError as e:
            raise BackendError(f"media worker unavailable ({type(e).__name__})") from None
        return r.json()

    async def worker_cancel(self, bot: str, job: str) -> dict:
        try:
            r = await self.http.post(f"{self.cfg.worker_url}/v1/jobs/{bot}/{job}/cancel", headers=self._wh())
        except httpx.HTTPError as e:
            raise BackendError(f"media worker unavailable ({type(e).__name__})") from None
        return r.json()
