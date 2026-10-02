"""Argument validation and the generate_image flow.

Kept free of MCP and of HTTP wiring so the whole decision path is unit-testable:
the facade only passes the identified bot and the raw tool arguments in.
"""

from __future__ import annotations

import asyncio

from .config import BotPolicy, Settings
from .errors import (
    CODE_DOCUMENT_TOO_LARGE,
    CODE_IMAGE_DISABLED,
    CODE_INVALID_MODEL,
    CODE_INVALID_N,
    CODE_INVALID_PROMPT,
    CODE_INVALID_SIZE,
    CODE_QUOTA_EXCEEDED,
    CodedError,
)
from .store import Store, StoreError

EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}


def validate(cfg: Settings, bot: BotPolicy, prompt, model, size, n,
             negative_prompt=None) -> tuple[str, str | None]:
    """Check the arguments against the bot policy and the service allow-lists.

    Raises CodedError with a stable code; returns the cleaned (prompt, negative_prompt).
    """
    if bot.tools is not None and "generate_image" not in bot.tools:
        raise CodedError(CODE_IMAGE_DISABLED, "generate_image is not enabled for this bot")
    if isinstance(prompt, str):
        prompt = prompt.strip()
    if not isinstance(prompt, str) or not prompt:
        raise CodedError(CODE_INVALID_PROMPT, "prompt is required")
    if len(prompt) > cfg.max_prompt_chars:
        raise CodedError(CODE_INVALID_PROMPT, f"prompt is longer than {cfg.max_prompt_chars} characters")
    if negative_prompt is not None:
        if not isinstance(negative_prompt, str):
            raise CodedError(CODE_INVALID_PROMPT, "negative_prompt must be a string")
        negative_prompt = negative_prompt.strip() or None
        if negative_prompt and len(negative_prompt) > cfg.max_prompt_chars:
            raise CodedError(CODE_INVALID_PROMPT,
                             f"negative_prompt is longer than {cfg.max_prompt_chars} characters")
    if model not in cfg.models:
        allowed = ", ".join(sorted(cfg.models)) or "none configured (set IMAGE_MODELS)"
        raise CodedError(CODE_INVALID_MODEL, f"model is not in the allow-list; allowed: {allowed}")
    if size not in cfg.sizes:
        raise CodedError(CODE_INVALID_SIZE, f"size is not in the allow-list; allowed: {', '.join(sorted(cfg.sizes))}")
    if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= cfg.max_images_per_call:
        raise CodedError(CODE_INVALID_N, f"n must be an integer in [1, {cfg.max_images_per_call}]")
    return prompt, negative_prompt


class ImageService:
    def __init__(self, cfg: Settings, store: Store, gateway, budget):
        self.cfg = cfg
        self.store = store
        self.gateway = gateway
        self.budget = budget
        self._locks: dict[str, asyncio.Lock] = {}

    def _lock(self, key: str) -> asyncio.Lock:
        return self._locks.setdefault(key, asyncio.Lock())

    def _limit(self, bot: BotPolicy) -> int | None:
        return bot.generations_per_day if bot.generations_per_day is not None else self.cfg.generations_per_day

    def _quota(self, bot: BotPolicy) -> int:
        return bot.quota_bytes or self.cfg.bot_quota_bytes

    async def generate(self, bot: BotPolicy, prompt, model, size, n=1, negative_prompt=None) -> dict:
        prompt, negative_prompt = validate(self.cfg, bot, prompt, model, size, n, negative_prompt)
        limit = self._limit(bot)
        if limit is not None and limit <= 0:
            raise CodedError(CODE_IMAGE_DISABLED, "image generation is disabled for this bot")
        async with self._lock(bot.key):  # charge and refund for one bot do not interleave
            await asyncio.to_thread(self.budget.charge, bot.key, n, limit)
        try:
            images, request_id = await self.gateway.generate(model, prompt, size, n, negative_prompt)
        except CodedError:
            await asyncio.to_thread(self.budget.refund, bot.key, n)
            raise

        files: list[dict] = []
        try:
            for i, img in enumerate(images, start=1):
                data = img["data"]
                if len(data) > self.cfg.max_file_bytes:
                    raise CodedError(CODE_DOCUMENT_TOO_LARGE,
                                     f"image larger than {self.cfg.max_file_bytes // 2**20} MiB")
                name = f"image-{i}{EXT.get(img['content_type'], '.bin')}"
                try:
                    meta = await asyncio.to_thread(self.store.put_bytes, bot.key, data, name, "result",
                                                   self._quota(bot))
                except StoreError as e:
                    raise CodedError(CODE_QUOTA_EXCEEDED, str(e)) from None
                files.append({"file_id": meta["id"], "name": meta["name"], "bytes": meta["size"],
                              "content_type": img["content_type"], "sha256": meta["sha256"],
                              "download": f"/v1/files/{meta['id']}"})
        except CodedError:
            await self._rollback(bot, files, n)
            raise
        return {"files": files, "model": model, "n": len(files), "request_id": request_id}

    async def _rollback(self, bot: BotPolicy, files: list[dict], charged: int) -> None:
        """A failed call leaves no half-stored images and spends no budget."""
        for f in files:
            try:
                await asyncio.to_thread(self.store.delete, bot.key, f["file_id"])
            except StoreError:
                pass
        await asyncio.to_thread(self.budget.refund, bot.key, charged)