import tempfile
import unittest
from pathlib import Path

from image_mcp.budget import Budget, utc_day
from image_mcp.errors import CODE_BUDGET_EXCEEDED, CodedError

# 2026-10-02T23:00:00Z and 2026-10-03T01:00:00Z: the day rolls over between them.
BEFORE_MIDNIGHT = 1790982000.0
AFTER_MIDNIGHT = 1790989200.0


class BudgetTest(unittest.TestCase):
    def test_charge_and_remainder(self):
        with tempfile.TemporaryDirectory() as t:
            b = Budget(Path(t))
            self.assertEqual(b.used("bot-a", now=BEFORE_MIDNIGHT), 0)
            self.assertEqual(b.charge("bot-a", 2, 3, now=BEFORE_MIDNIGHT), 2)
            self.assertEqual(b.used("bot-a", now=BEFORE_MIDNIGHT), 2)
            self.assertEqual(b.charge("bot-a", 1, 3, now=BEFORE_MIDNIGHT), 3)
            with self.assertRaises(CodedError) as cm:
                b.charge("bot-a", 1, 3, now=BEFORE_MIDNIGHT)
            self.assertEqual(cm.exception.code, CODE_BUDGET_EXCEEDED)
            self.assertIn("0 of 3 generations left today", str(cm.exception))

    def test_multi_image_cannot_overdraw(self):
        with tempfile.TemporaryDirectory() as t:
            b = Budget(Path(t))
            b.charge("bot-a", 2, 3, now=BEFORE_MIDNIGHT)
            with self.assertRaises(CodedError) as cm:
                b.charge("bot-a", 2, 3, now=BEFORE_MIDNIGHT)  # 2 + 2 > 3
            self.assertEqual(cm.exception.code, CODE_BUDGET_EXCEEDED)
            self.assertEqual(b.used("bot-a", now=BEFORE_MIDNIGHT), 2)

    def test_reset_at_utc_midnight(self):
        with tempfile.TemporaryDirectory() as t:
            b = Budget(Path(t))
            self.assertEqual(utc_day(BEFORE_MIDNIGHT), "2026-10-02")
            self.assertEqual(utc_day(AFTER_MIDNIGHT), "2026-10-03")
            b.charge("bot-a", 3, 3, now=BEFORE_MIDNIGHT)
            self.assertEqual(b.used("bot-a", now=BEFORE_MIDNIGHT), 3)
            self.assertEqual(b.used("bot-a", now=AFTER_MIDNIGHT), 0)
            self.assertEqual(b.charge("bot-a", 1, 3, now=AFTER_MIDNIGHT), 1)

    def test_refund(self):
        with tempfile.TemporaryDirectory() as t:
            b = Budget(Path(t))
            b.charge("bot-a", 2, 5, now=BEFORE_MIDNIGHT)
            b.refund("bot-a", 2, now=BEFORE_MIDNIGHT)
            self.assertEqual(b.used("bot-a", now=BEFORE_MIDNIGHT), 0)

    def test_bots_are_isolated(self):
        with tempfile.TemporaryDirectory() as t:
            b = Budget(Path(t))
            b.charge("bot-a", 3, 3, now=BEFORE_MIDNIGHT)
            self.assertEqual(b.used("bot-b", now=BEFORE_MIDNIGHT), 0)
            self.assertEqual(b.charge("bot-b", 1, 3, now=BEFORE_MIDNIGHT), 1)


if __name__ == "__main__":
    unittest.main()