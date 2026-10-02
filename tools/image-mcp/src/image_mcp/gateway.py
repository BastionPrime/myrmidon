"""Client for the OpenAI-compatible image route of the model gateway.

The gateway base URL and the model allow-list come from settings; the key is passed in only
if the environment named one. The bot never chooses the URL. The response may carry the
image inline (data[].b64_json) or as a link (data[].url); both are supported, and a link is
downloaded over the same client. The repeat is the bot's job: this client makes one attempt.
"""

from __future__ import annotations

import base64
import binascii
import logging

import httpx

from .errors import CODE_DOCUMENT_TOO_LARGE, CODE_UPSTREAM_ERROR, CodedError

log = logging.getLogger("image_mcp.gateway")

# Leading bytes that identify an image without trusting the gateway's content type.
MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"RIFF", "image/webp"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
)


def sniff(data: bytes, header: str | None) -> str:
    """Content type from the header when it is an image type, otherwise from the bytes."""
    ct = (header or "").split(";")[0].strip().lower()
    if ct.startswith("image/"):
        return ct
    for magic, kind in MAGIC:
        if data.startswith(magic):
            return kind
    return "application/octet-stream"


class Gateway:
    def __init__(self, cfg, client: httpx.AsyncClient | None = None):
        self.cfg = cfg
        self.http = client or httpx.AsyncClient(timeout=httpx.Timeout(cfg.upstream_timeout_s, connect=10))

    async def aclose(self) -> None:
        await self.http.aclose()

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.cfg.gateway_token:
            headers["Authorization"] = f"Bearer {self.cfg.gateway_token}"
        return headers

    @staticmethod
    def _snippet(r: httpx.Response) -> str:
        try:
            text = r.text
        except Exception:  # noqa: BLE001 - any decode failure must not mask the HTTP status
            return ""
        return " ".join(text.split())[:200]

    async def generate(self, model: str, prompt: str, size: str, n: int,
                       negative_prompt: str | None = None) -> tuple[list[dict], str | None]:
        """POST /v1/images/generations -> ([{data, content_type}], request_id)."""
        body: dict = {"model": model, "prompt": prompt, "size": size, "n": n}
        if negative_prompt:
            body["negative_prompt"] = negative_prompt
        url = f"{self.cfg.gateway_base_url}/v1/images/generations"
        try:
            r = await self.http.post(url, json=body, headers=self._headers())
        except httpx.HTTPError as e:
            raise CodedError(CODE_UPSTREAM_ERROR, f"gateway unavailable ({type(e).__name__})") from None
        if r.status_code >= 400:
            raise CodedError(CODE_UPSTREAM_ERROR, f"gateway returned HTTP {r.status_code}: {self._snippet(r)}")
        try:
            payload = r.json()
        except ValueError:
            raise CodedError(CODE_UPSTREAM_ERROR, "gateway returned a non-JSON body") from None
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, list) or not data:
            raise CodedError(CODE_UPSTREAM_ERROR, "gateway returned no images")
        request_id = r.headers.get("x-request-id") or (payload.get("id") if isinstance(payload, dict) else None)
        images = [await self._one(item) for item in data]
        return images, request_id

    async def _one(self, item) -> dict:
        if not isinstance(item, dict):
            raise CodedError(CODE_UPSTREAM_ERROR, "gateway image entry is malformed")
        if item.get("b64_json"):
            try:
                raw = base64.b64decode(item["b64_json"], validate=True)
            except (binascii.Error, ValueError):
                raise CodedError(CODE_UPSTREAM_ERROR, "gateway returned invalid base64") from None
            return {"data": raw, "content_type": sniff(raw, None)}
        url = item.get("url")
        if url:
            if not isinstance(url, str) or not url.lower().startswith(("http://", "https://")):
                raise CodedError(CODE_UPSTREAM_ERROR, "gateway returned a bad image url")
            return await self._download(url)
        raise CodedError(CODE_UPSTREAM_ERROR, "gateway entry has neither b64_json nor url")

    async def _download(self, url: str) -> dict:
        """Fetch a linked image, capped at one file's size. No Authorization goes to this URL:
        it is not the gateway contract, and a third-party host must not see the key."""
        cap = self.cfg.max_file_bytes
        chunks: list[bytes] = []
        total = 0
        try:
            async with self.http.stream("GET", url, follow_redirects=True) as r:
                if r.status_code >= 400:
                    raise CodedError(CODE_UPSTREAM_ERROR, f"image download returned HTTP {r.status_code}")
                header = r.headers.get("content-type")
                async for chunk in r.aiter_bytes(1 << 16):
                    total += len(chunk)
                    if total > cap:
                        raise CodedError(CODE_DOCUMENT_TOO_LARGE, f"image larger than {cap // 2**20} MiB")
                    chunks.append(chunk)
        except httpx.HTTPError as e:
            raise CodedError(CODE_UPSTREAM_ERROR, f"image download failed ({type(e).__name__})") from None
        raw = b"".join(chunks)
        return {"data": raw, "content_type": sniff(raw, header)}