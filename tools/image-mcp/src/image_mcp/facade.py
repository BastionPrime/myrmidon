"""The MCP facade: generate_image plus the per-bot file store, one endpoint for container bots."""

from __future__ import annotations

import asyncio
import base64
import functools
import json

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Route

from .auth import AuthMiddleware, Authenticator, current_bot
from .budget import Budget
from .config import Settings, load_settings
from .errors import CODE_TOOL_DISABLED, CodedError
from .gateway import Gateway
from .service import ImageService
from .store import Store, StoreError

INSTRUCTIONS = (
    "Image generation for container bots. Call generate_image with a prompt, a model from the "
    "allow-list and a size; the answer lists the produced files, each with file_id, name, bytes and "
    "content_type, plus base64 for files up to the inline limit. Larger files: download with "
    "GET /v1/files/<file_id> on the same address (same authentication). Files live in your own "
    "private store (48 h, quota per bot); file_get/file_list/file_delete manage them. "
    "The service makes one attempt per call: retry on your side if upstream_error comes back. "
    "Errors carry a stable code (image_disabled, invalid_prompt, invalid_model, invalid_size, "
    "invalid_n, budget_exceeded, upstream_error, document_too_large, quota_exceeded)."
)


def build_app(cfg: Settings | None = None, *, gateway=None) -> object:
    cfg = cfg or load_settings()
    store = Store(cfg.data_dir, cfg.bot_quota_bytes, cfg.max_file_bytes, cfg.file_ttl_hours,
                  spool_max_bytes=cfg.spool_max_bytes, spool_min_free_bytes=cfg.spool_min_free_bytes)
    gw = gateway or Gateway(cfg)
    svc = ImageService(cfg, store, gw, Budget(cfg.data_dir))
    auth = Authenticator(cfg)

    mcp = FastMCP(
        "image-tools", instructions=INSTRUCTIONS, stateless_http=True, json_response=True,
        host=cfg.listen_host, port=cfg.listen_port, max_request_body_size=cfg.max_request_bytes,
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=True,
                                                     allowed_hosts=list(cfg.allowed_hosts), allowed_origins=[]),
    )

    # ---- helpers ------------------------------------------------------------
    def me():
        bot = current_bot.get()
        if bot is None:
            raise ToolError("unauthorized")
        return bot

    def gate(tool: str):
        bot = me()
        if bot.tools is not None and tool not in bot.tools:
            raise CodedError(CODE_TOOL_DISABLED, f"tool {tool} is not enabled for this bot")
        return bot

    def quota(bot) -> int:
        return bot.quota_bytes or cfg.bot_quota_bytes

    def public(meta: dict) -> dict:
        return {k: meta[k] for k in ("id", "name", "size", "sha256", "kind", "created")} | {
            "download": f"/v1/files/{meta['id']}"}

    def with_inline(bot, entry: dict, inline: bool) -> dict:
        if not inline:
            return entry
        if entry["bytes"] > cfg.max_inline_result_bytes:
            entry["inline_skipped"] = f"larger than {cfg.max_inline_result_bytes} bytes, use download"
        else:
            entry["base64"] = base64.b64encode(store.blob(bot.key, entry["file_id"]).read_bytes()).decode()
        return entry

    def wrap(fn):
        @functools.wraps(fn)
        async def inner(*a, **kw):
            try:
                return await fn(*a, **kw)
            except (CodedError, StoreError) as e:
                raise ToolError(str(e)) from None

        return inner

    def tool(fn):
        return mcp.tool()(wrap(fn))

    # ---- tools ---------------------------------------------------------------
    @tool
    async def generate_image(prompt: str, model: str, size: str = "1024x1024", n: int = 1,
                             negative_prompt: str | None = None, inline: bool = True) -> dict:
        """Generate n images from a prompt with an allow-listed model.

        prompt: 1..2000 characters. model: from the service allow-list. size: from the service
        allow-list (for example 1024x1024). n: 1..4. negative_prompt: optional. inline: include
        base64 for small results (default true). Returns files, model and request_id.
        """
        bot = me()
        out = await svc.generate(bot, prompt, model, size, n, negative_prompt)
        for entry in out["files"]:
            with_inline(bot, entry, inline)
        return out

    @tool
    async def file_get(file_id: str) -> dict:
        """Return a stored image as base64 (only if small); larger: GET /v1/files/<file_id>."""
        bot = gate("file_get")
        meta = await asyncio.to_thread(store.meta, bot.key, file_id)
        return with_inline(bot, public(meta), True)

    @tool
    async def file_list() -> dict:
        """List your images with sizes, the remaining quota and the remaining daily budget."""
        bot = gate("file_list")
        items = await asyncio.to_thread(store.list, bot.key)
        used = await asyncio.to_thread(store.used_bytes, bot.key)
        limit = svc._limit(bot)
        spent = await asyncio.to_thread(svc.budget.used, bot.key)
        return {"files": [public(m) for m in items], "used_bytes": used, "quota_bytes": quota(bot),
                "ttl_hours": cfg.file_ttl_hours,
                "generations_today": spent, "generations_per_day": limit}

    @tool
    async def file_delete(file_id: str) -> dict:
        """Delete one of your images."""
        bot = gate("file_delete")
        await asyncio.to_thread(store.delete, bot.key, file_id)
        return {"deleted": file_id}

    # ---- REST for big files ---------------------------------------------------
    async def get_file(request: Request):
        bot = me()
        try:
            meta = await asyncio.to_thread(store.meta, bot.key, request.path_params["fid"])
        except StoreError as e:
            return JSONResponse({"error": str(e)}, status_code=404)
        return FileResponse(store.blob(bot.key, meta["id"]), filename=meta["name"],
                            media_type="application/octet-stream")

    async def health(_: Request):
        return JSONResponse({"ok": True})

    app = mcp.streamable_http_app()
    app.router.routes.extend([
        Route("/v1/files/{fid}", get_file, methods=["GET"]),
        Route("/healthz", health),
    ])
    app.add_middleware(AuthMiddleware, auth=auth)

    async def janitor():
        while True:
            await asyncio.sleep(1800)
            try:
                await asyncio.to_thread(store.sweep)
            except OSError:
                pass

    inner = app.router.lifespan_context

    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def lifespan(a):
        t = asyncio.create_task(janitor())
        async with inner(a):
            yield
        t.cancel()
        await gw.aclose()

    app.router.lifespan_context = lifespan
    return app