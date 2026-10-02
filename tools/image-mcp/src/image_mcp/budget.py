"""Per-bot daily generation budget, kept next to the bot's files and reset at UTC midnight.

The counter is one JSON document per bot: {"day": "YYYY-MM-DD", "used": N}. Charge n before a
generation and refund n if the gateway call fails, so a failed call does not spend budget.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from .config import BOT_KEY_RE
from .errors import CODE_BUDGET_EXCEEDED, CodedError

DAY_FMT = "%Y-%m-%d"


def utc_day(now: float | None = None) -> str:
    return time.strftime(DAY_FMT, time.gmtime(time.time() if now is None else now))


class Budget:
    def __init__(self, root: Path):
        self.root = root

    def _path(self, bot: str) -> Path:
        if not BOT_KEY_RE.match(bot):
            raise ValueError("bad bot key")
        d = self.root / "bots" / bot
        d.mkdir(parents=True, exist_ok=True)
        return d / "budget.json"

    def used(self, bot: str, now: float | None = None) -> int:
        try:
            data = json.loads(self._path(bot).read_text())
        except (OSError, ValueError):
            return 0
        if data.get("day") != utc_day(now):
            return 0  # a new UTC day starts at zero
        return max(0, int(data.get("used", 0)))

    def _write(self, path: Path, day: str, used: int) -> None:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"day": day, "used": used}))
        os.replace(tmp, path)

    def charge(self, bot: str, n: int, limit: int | None, now: float | None = None) -> int:
        """Reserve n generations. Raises CodedError(budget_exceeded) and never overdraws."""
        day = utc_day(now)
        path = self._path(bot)
        used = self.used(bot, now)
        if limit is not None and used + n > limit:
            raise CodedError(CODE_BUDGET_EXCEEDED, f"{max(0, limit - used)} of {limit} generations left today")
        self._write(path, day, used + n)
        return used + n

    def refund(self, bot: str, n: int, now: float | None = None) -> None:
        path = self._path(bot)
        used = self.used(bot, now)
        self._write(path, utc_day(now), max(0, used - n))