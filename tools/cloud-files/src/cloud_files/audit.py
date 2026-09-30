"""Call journal: one JSON line per call, no file contents, no mail subjects or bodies."""

from __future__ import annotations

import json
import logging
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path


class Audit:
    def __init__(self, state_dir: Path):
        self.log = logging.getLogger("cloud_files.audit")
        self.log.setLevel(logging.INFO)
        self.log.propagate = False
        if not self.log.handlers:
            h = RotatingFileHandler(state_dir / "audit.log", maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8")
            h.setFormatter(logging.Formatter("%(message)s"))
            self.log.addHandler(h)
            self.log.addHandler(logging.StreamHandler())

    def write(self, bot: str, tool: str, ok: bool, **fields) -> None:
        self.log.info(json.dumps({"ts": int(time.time()), "bot": bot, "tool": tool, "ok": ok, **fields}, ensure_ascii=False))
