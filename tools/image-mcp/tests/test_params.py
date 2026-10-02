import unittest

from image_mcp.config import BotPolicy, Settings
from image_mcp.errors import (
    CODE_IMAGE_DISABLED,
    CODE_INVALID_MODEL,
    CODE_INVALID_N,
    CODE_INVALID_PROMPT,
    CODE_INVALID_SIZE,
    CodedError,
)
from image_mcp.service import validate

CFG = Settings(models=frozenset({"qwen-image-3.0", "z-image-turbo"}),
               sizes=frozenset({"1024x1024", "1328x1328"}), max_prompt_chars=20)
BOT = BotPolicy(key="bot-a", tools=frozenset({"generate_image"}))


def check(**kw):
    args = {"prompt": "a cat", "model": "z-image-turbo", "size": "1024x1024", "n": 1}
    args.update(kw)
    return validate(CFG, args.pop("bot", BOT), args.pop("prompt"), args.pop("model"),
                    args.pop("size"), args.pop("n"), args.pop("negative_prompt", None))


class Validate(unittest.TestCase):
    def test_ok(self):
        self.assertEqual(check(), ("a cat", None))

    def test_prompt_is_stripped(self):
        self.assertEqual(check(prompt="  a cat  "), ("a cat", None))

    def test_tool_not_enabled(self):
        with self.assertRaises(CodedError) as cm:
            check(bot=BotPolicy(key="bot-a", tools=frozenset({"file_get"})))
        self.assertEqual(cm.exception.code, CODE_IMAGE_DISABLED)

    def test_prompt_missing_or_empty(self):
        for bad in ("", "   ", None):
            with self.assertRaises(CodedError) as cm:
                check(prompt=bad)
            self.assertEqual(cm.exception.code, CODE_INVALID_PROMPT, msg=repr(bad))

    def test_prompt_too_long(self):
        with self.assertRaises(CodedError) as cm:
            check(prompt="x" * 21)
        self.assertEqual(cm.exception.code, CODE_INVALID_PROMPT)

    def test_negative_prompt_type_and_length(self):
        with self.assertRaises(CodedError) as cm:
            check(negative_prompt=5)
        self.assertEqual(cm.exception.code, CODE_INVALID_PROMPT)
        with self.assertRaises(CodedError) as cm:
            check(negative_prompt="x" * 21)
        self.assertEqual(cm.exception.code, CODE_INVALID_PROMPT)
        self.assertEqual(check(negative_prompt="  blur  "), ("a cat", "blur"))

    def test_allow_list_models(self):
        self.assertEqual(check(model="qwen-image-3.0")[0], "a cat")
        for bad in ("sd-xl", "Z-IMAGE-TURBO", "", "z-image-turbo "):
            with self.assertRaises(CodedError) as cm:
                check(model=bad)
            self.assertEqual(cm.exception.code, CODE_INVALID_MODEL, msg=repr(bad))

    def test_empty_allow_list_refuses_every_model(self):
        cfg = Settings(models=frozenset())
        with self.assertRaises(CodedError) as cm:
            validate(cfg, BOT, "a cat", "z-image-turbo", "1024x1024", 1)
        self.assertEqual(cm.exception.code, CODE_INVALID_MODEL)
        self.assertIn("IMAGE_MODELS", str(cm.exception))

    def test_allow_list_sizes(self):
        with self.assertRaises(CodedError) as cm:
            check(size="512x512")
        self.assertEqual(cm.exception.code, CODE_INVALID_SIZE)

    def test_n_range(self):
        for bad in (0, 5, True, 2.0, "2"):
            with self.assertRaises(CodedError) as cm:
                check(n=bad)
            self.assertEqual(cm.exception.code, CODE_INVALID_N, msg=repr(bad))
        self.assertEqual(check(n=4)[0], "a cat")


if __name__ == "__main__":
    unittest.main()