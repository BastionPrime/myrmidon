import base64
import tempfile
import unittest
from pathlib import Path

from image_mcp.budget import Budget
from image_mcp.config import BotPolicy, Settings
from image_mcp.errors import (
    CODE_BUDGET_EXCEEDED,
    CODE_DOCUMENT_TOO_LARGE,
    CODE_IMAGE_DISABLED,
    CODE_QUOTA_EXCEEDED,
    CODE_UPSTREAM_ERROR,
    CodedError,
)
from image_mcp.service import ImageService
from image_mcp.store import Store, StoreError

PNG = b"\x89PNG\r\n\x1a\n" + b"p" * 64


class FakeGateway:
    """Returns the images it was told to return, or raises the coded error it was given."""

    def __init__(self, images=None, error=None):
        self.images = images if images is not None else [{"data": PNG, "content_type": "image/png"}]
        self.error = error
        self.calls = []

    async def generate(self, model, prompt, size, n, negative_prompt=None):
        self.calls.append({"model": model, "prompt": prompt, "size": size, "n": n,
                           "negative_prompt": negative_prompt})
        if self.error is not None:
            raise self.error
        images = self.images if self.images else [{"data": PNG, "content_type": "image/png"}]
        return [images[i % len(images)] for i in range(n)], "req-1"

    async def aclose(self):
        pass


def build(tmp, gw, **cfg_kw):
    cfg = Settings(data_dir=Path(tmp), models=frozenset({"m"}), sizes=frozenset({"1024x1024"}),
                   spool_min_free_bytes=0, **cfg_kw)
    store = Store(cfg.data_dir, cfg.bot_quota_bytes, cfg.max_file_bytes, cfg.file_ttl_hours,
                  spool_max_bytes=cfg.spool_max_bytes, spool_min_free_bytes=cfg.spool_min_free_bytes)
    return cfg, store, ImageService(cfg, store, gw, Budget(cfg.data_dir))


BOT = BotPolicy(key="bot-a", tools=frozenset({"generate_image"}), generations_per_day=10)


class ServiceFlow(unittest.IsolatedAsyncioTestCase):
    async def test_generate_stores_files(self):
        with tempfile.TemporaryDirectory() as t:
            cfg, store, svc = build(t, FakeGateway())
            out = await svc.generate(BOT, "a cat", "m", "1024x1024", 2)
            self.assertEqual(len(out["files"]), 2)
            self.assertEqual(out["model"], "m")
            self.assertEqual(out["request_id"], "req-1")
            f = out["files"][0]
            self.assertEqual(f["content_type"], "image/png")
            self.assertTrue(f["name"].endswith(".png"))
            self.assertEqual(f["bytes"], len(PNG))
            self.assertEqual(store.blob("bot-a", f["file_id"]).read_bytes(), PNG)
            self.assertEqual(Budget(cfg.data_dir).used("bot-a"), 2)

    async def test_results_are_isolated_per_bot(self):
        with tempfile.TemporaryDirectory() as t:
            _, store, svc = build(t, FakeGateway())
            out = await svc.generate(BOT, "a cat", "m", "1024x1024", 1)
            fid = out["files"][0]["file_id"]
            self.assertEqual(store.meta("bot-a", fid)["name"], "image-1.png")
            with self.assertRaises(StoreError):
                store.meta("bot-b", fid)

    async def test_budget_exceeded(self):
        with tempfile.TemporaryDirectory() as t:
            cfg, _, svc = build(t, FakeGateway())
            bot = BotPolicy(key="bot-a", tools=frozenset({"generate_image"}), generations_per_day=1)
            await svc.generate(bot, "a cat", "m", "1024x1024", 1)
            with self.assertRaises(CodedError) as cm:
                await svc.generate(bot, "a cat", "m", "1024x1024", 1)
            self.assertEqual(cm.exception.code, CODE_BUDGET_EXCEEDED)
            self.assertIn("0 of 1 generations left today", str(cm.exception))

    async def test_multi_image_budget_not_overdrawn(self):
        with tempfile.TemporaryDirectory() as t:
            cfg, store, svc = build(t, FakeGateway())
            bot = BotPolicy(key="bot-a", tools=frozenset({"generate_image"}), generations_per_day=3)
            await svc.generate(bot, "a cat", "m", "1024x1024", 2)
            with self.assertRaises(CodedError) as cm:
                await svc.generate(bot, "a cat", "m", "1024x1024", 2)
            self.assertEqual(cm.exception.code, CODE_BUDGET_EXCEEDED)
            self.assertEqual(Budget(cfg.data_dir).used("bot-a"), 2)

    async def test_disabled_tool(self):
        with tempfile.TemporaryDirectory() as t:
            _, _, svc = build(t, FakeGateway())
            bot = BotPolicy(key="bot-a", tools=frozenset({"file_get"}))
            with self.assertRaises(CodedError) as cm:
                await svc.generate(bot, "a cat", "m", "1024x1024", 1)
            self.assertEqual(cm.exception.code, CODE_IMAGE_DISABLED)

    async def test_zero_budget_is_disabled(self):
        with tempfile.TemporaryDirectory() as t:
            _, _, svc = build(t, FakeGateway())
            bot = BotPolicy(key="bot-a", tools=frozenset({"generate_image"}), generations_per_day=0)
            with self.assertRaises(CodedError) as cm:
                await svc.generate(bot, "a cat", "m", "1024x1024", 1)
            self.assertEqual(cm.exception.code, CODE_IMAGE_DISABLED)

    async def test_upstream_error_spends_no_budget_and_stores_nothing(self):
        with tempfile.TemporaryDirectory() as t:
            cfg, store, svc = build(t, FakeGateway(error=CodedError(CODE_UPSTREAM_ERROR, "boom")))
            with self.assertRaises(CodedError) as cm:
                await svc.generate(BOT, "a cat", "m", "1024x1024", 2)
            self.assertEqual(cm.exception.code, CODE_UPSTREAM_ERROR)
            self.assertEqual(Budget(cfg.data_dir).used("bot-a"), 0)
            self.assertEqual(store.list("bot-a"), [])

    async def test_oversize_image_is_document_too_large_and_refunded(self):
        with tempfile.TemporaryDirectory() as t:
            gw = FakeGateway(images=[{"data": PNG, "content_type": "image/png"}])
            cfg, store, svc = build(t, gw, max_file_bytes=10)
            with self.assertRaises(CodedError) as cm:
                await svc.generate(BOT, "a cat", "m", "1024x1024", 1)
            self.assertEqual(cm.exception.code, CODE_DOCUMENT_TOO_LARGE)
            self.assertEqual(Budget(cfg.data_dir).used("bot-a"), 0)
            self.assertEqual(store.list("bot-a"), [])

    async def test_partial_store_failure_rolls_back(self):
        with tempfile.TemporaryDirectory() as t:
            gw = FakeGateway(images=[{"data": PNG, "content_type": "image/png"},
                                     {"data": PNG, "content_type": "image/png"}])
            cfg, store, svc = build(t, gw, bot_quota_bytes=len(PNG) + 1)
            with self.assertRaises(CodedError) as cm:
                await svc.generate(BOT, "a cat", "m", "1024x1024", 2)
            self.assertEqual(cm.exception.code, CODE_QUOTA_EXCEEDED)
            self.assertEqual(store.list("bot-a"), [])
            self.assertEqual(Budget(cfg.data_dir).used("bot-a"), 0)

    async def test_arguments_forwarded_and_prompt_stripped(self):
        with tempfile.TemporaryDirectory() as t:
            gw = FakeGateway()
            _, _, svc = build(t, gw)
            await svc.generate(BOT, "  a cat  ", "m", "1024x1024", 1, "  blur ")
            self.assertEqual(gw.calls[0]["prompt"], "a cat")
            self.assertEqual(gw.calls[0]["negative_prompt"], "blur")
            self.assertEqual(gw.calls[0]["n"], 1)

    async def test_default_budget_from_settings(self):
        with tempfile.TemporaryDirectory() as t:
            cfg, _, svc = build(t, FakeGateway(), generations_per_day=1)
            bot = BotPolicy(key="bot-a", tools=frozenset({"generate_image"}))  # no per-bot value
            await svc.generate(bot, "a cat", "m", "1024x1024", 1)
            with self.assertRaises(CodedError) as cm:
                await svc.generate(bot, "a cat", "m", "1024x1024", 1)
            self.assertEqual(cm.exception.code, CODE_BUDGET_EXCEEDED)

    async def test_inline_png_roundtrip(self):
        with tempfile.TemporaryDirectory() as t:
            _, store, svc = build(t, FakeGateway())
            out = await svc.generate(BOT, "a cat", "m", "1024x1024", 1)
            fid = out["files"][0]["file_id"]
            self.assertEqual(base64.b64decode(base64.b64encode(store.blob("bot-a", fid).read_bytes())), PNG)


if __name__ == "__main__":
    unittest.main()