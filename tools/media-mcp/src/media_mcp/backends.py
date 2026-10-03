"""Clients for the ready-made backends (Gotenberg, Tika, the STT gateway) and for our worker."""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

import httpx

from .config import Settings

log = logging.getLogger("media_mcp.backends")


class BackendError(Exception):
    """Safe to show the bot."""


async def _file_chunks(fh, chunk: int = 1 << 20):
    while True:
        data = await asyncio.to_thread(fh.read, chunk)
        if not data:
            return
        yield data


class Backends:
    def __init__(self, cfg: Settings):
        self.cfg = cfg
        t = httpx.Timeout(cfg.backend_timeout_s + 60, connect=5)
        self.http = httpx.AsyncClient(timeout=t)
        self.gotenberg_slots = asyncio.Semaphore(2)
        self.tika_slots = asyncio.Semaphore(2)

    async def aclose(self) -> None:
        await self.http.aclose()

    # -- Gotenberg
    async def gotenberg(self, route: str, files: list[tuple[str, tuple[str, object, str]]], fields: dict[str, str],
                        dest: Path, max_bytes: int) -> int:
        """Convert and stream the PDF into `dest`; refuse (and delete the partial file) past max_bytes."""
        async with self.gotenberg_slots:
            try:
                async with self.http.stream("POST", f"{self.cfg.gotenberg_url}{route}", files=files, data=fields) as r:
                    if r.status_code != 200:
                        body = (await r.aread())[:300].decode("utf-8", "replace")
                        log.warning("gotenberg %s -> HTTP %s: %s", route, r.status_code, body)
                        raise BackendError(f"document converter refused the file (HTTP {r.status_code})")
                    total = 0
                    with dest.open("wb") as out:
                        async for chunk in r.aiter_bytes(1 << 20):
                            total += len(chunk)
                            if total > max_bytes:
                                raise BackendError(f"converted PDF is larger than {max_bytes // 2**20} MiB or than the free quota")
                            await asyncio.to_thread(out.write, chunk)
                    return total
            except httpx.HTTPError as e:
                dest.unlink(missing_ok=True)
                raise BackendError(f"document converter unavailable ({type(e).__name__})") from None
            except BaseException:
                dest.unlink(missing_ok=True)
                raise

    # -- Tika
    async def tika_text(self, name: str, fh, size: int, ocr: bool, max_chars: int) -> tuple[str, bool]:
        """Stream the file to Tika and read the answer only up to max_chars. -> (text, cut_off)."""
        headers = {
            "Accept": "text/plain",
            "Content-Disposition": f'attachment; filename="{name}"',
            "Content-Length": str(size),
            "X-Tika-OCRLanguage": "rus+eng",
            "X-Tika-PDFOcrStrategy": "auto" if ocr else "no_ocr",
        }
        if not ocr:
            headers["X-Tika-OCRskipOcr"] = "true"
        async with self.tika_slots:
            try:
                async with self.http.stream("PUT", f"{self.cfg.tika_url}/tika", content=_file_chunks(fh), headers=headers) as r:
                    if r.status_code == 204:
                        return "", False
                    if r.status_code != 200:
                        raise BackendError(f"text extractor failed (HTTP {r.status_code})")
                    parts: list[str] = []
                    n = 0
                    async for piece in r.aiter_text():
                        parts.append(piece)
                        n += len(piece)
                        if n > max_chars:
                            break
            except httpx.HTTPError as e:
                raise BackendError(f"text extractor unavailable ({type(e).__name__})") from None
        text = "".join(parts)
        return text[:max_chars], len(text) > max_chars

    # -- stt gateway
    async def stt_transcribe(self, name: str, fh, size: int, model: str, language: str | None) -> dict:
        """POST the file as multipart to the STT gateway; -> normalized {text, segments}.

        The gateway API key goes only in the Authorization header; it never enters
        an error message or the log. The response is read up to stt_max_response_bytes."""
        if size > self.cfg.stt_max_multipart_bytes:
            raise BackendError(f"audio larger than {self.cfg.stt_max_multipart_bytes // 2**20} MiB for transcription; split it first (audio_split)")
        headers = {"Authorization": f"Bearer {self.cfg.stt_api_key}"} if self.cfg.stt_api_key else {}
        try:
            async with self.http.stream("POST", f"{self.cfg.stt_base_url}/v1/audio/transcriptions",
                                        files={"file": (name, fh, "application/octet-stream")},
                                        data={"model": model} | ({"language": language} if language else {}),
                                        headers=headers) as r:
                if r.status_code == 404:
                    raise BackendError(f"model {model} is not registered on the transcription gateway")
                if r.status_code != 200:
                    body = (await r.aread())[:300].decode("utf-8", "replace")
                    log.warning("stt gateway -> HTTP %s (model %s)", r.status_code, model)  # never the key or body
                    raise BackendError(f"transcription gateway refused the request (HTTP {r.status_code})")
                parts: list[bytes] = []
                n = 0
                async for chunk in r.aiter_bytes(1 << 20):
                    parts.append(chunk)
                    n += len(chunk)
                    if n > self.cfg.stt_max_response_bytes:
                        raise BackendError(f"transcription response larger than {self.cfg.stt_max_response_bytes // 2**20} MiB")
        except httpx.HTTPError as e:
            raise BackendError(f"transcription gateway unavailable ({type(e).__name__})") from None
        raw = b"".join(parts)
        try:
            return json.loads(raw)
        except ValueError:
            raise BackendError("transcription gateway returned a non-JSON answer (is the model name correct?)") from None

    # -- worker
    def _wh(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.cfg.worker_token}"}

    async def worker_submit(self, bot: str, job: str, kind: str, spec: dict, max_out_bytes: int | None = None) -> dict:
        try:
            r = await self.http.post(f"{self.cfg.worker_url}/v1/jobs", headers=self._wh(),
                                     json={"bot": bot, "job": job, "kind": kind, "spec": spec,
                                           "max_out_bytes": max_out_bytes})
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
