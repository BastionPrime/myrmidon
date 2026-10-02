"""Staging area: files moving between OneDrive and one bot. Per-bot directories, quotas, TTL."""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
import uuid
from pathlib import Path

ID_RE = re.compile(r"^[0-9a-f]{32}$")
KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")


class StoreError(Exception):
    pass


def safe_name(name: str) -> str:
    name = os.path.basename((name or "").replace("\\", "/")).strip().strip(".")
    name = re.sub(r'[\x00-\x1f"*:<>?|/\\]', "_", name)[:200]
    return name or "file"


class Store:
    def __init__(self, root: Path, bot_quota: int, total_quota: int, max_file: int, ttl_hours: int):
        self.root, self.bot_quota, self.total_quota = root / "stage", bot_quota, total_quota
        self.max_file, self.ttl_s = max_file, ttl_hours * 3600
        self._lock = threading.Lock()

    def _dir(self, bot: str) -> Path:
        if not KEY_RE.match(bot):
            raise StoreError("bad bot key")
        p = self.root / bot
        p.mkdir(parents=True, exist_ok=True)
        return p

    def used(self, bot: str | None = None) -> int:
        base = self._dir(bot) if bot else self.root
        base.mkdir(parents=True, exist_ok=True)
        return sum(f.stat().st_size for f in base.rglob("*") if f.is_file())

    def room(self, bot: str) -> int:
        """Bytes a new file may still take for this bot."""
        return max(0, min(self.max_file, self.bot_quota - self.used(bot), self.total_quota - self.used()))

    def new_tmp(self, bot: str) -> Path:
        return self._dir(bot) / f".tmp-{uuid.uuid4().hex}"

    def commit(self, bot: str, tmp: Path, name: str, origin: str) -> dict:
        fid = uuid.uuid4().hex
        h = hashlib.sha256()
        with tmp.open("rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        meta = {"id": fid, "name": safe_name(name), "size": tmp.stat().st_size, "sha256": h.hexdigest(),
                "origin": origin, "created": int(time.time())}
        d = self._dir(bot)
        os.replace(tmp, d / fid)
        (d / f"{fid}.json").write_text(json.dumps(meta))
        return meta

    def meta(self, bot: str, fid: str) -> dict:
        if not ID_RE.match(fid or ""):
            raise StoreError("bad file id")
        try:
            return json.loads((self._dir(bot) / f"{fid}.json").read_text())
        except FileNotFoundError:
            raise StoreError("no such staged file (unknown id, expired or deleted)") from None

    def blob(self, bot: str, fid: str) -> Path:
        self.meta(bot, fid)
        return self._dir(bot) / fid

    def list(self, bot: str) -> list[dict]:
        out = []
        for p in sorted(self._dir(bot).glob("*.json"), key=lambda q: q.stat().st_mtime):
            try:
                out.append(json.loads(p.read_text()))
            except (OSError, ValueError):
                pass
        return out

    def delete(self, bot: str, fid: str) -> None:
        self.meta(bot, fid)
        d = self._dir(bot)
        (d / fid).unlink(missing_ok=True)
        (d / f"{fid}.json").unlink(missing_ok=True)

    def sweep(self) -> None:
        now = time.time()
        for f in self.root.rglob("*"):
            try:
                if f.is_file() and now - f.stat().st_mtime > self.ttl_s:
                    f.unlink()
            except OSError:
                pass
