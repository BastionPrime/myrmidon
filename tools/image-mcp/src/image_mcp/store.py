"""Per-bot file store on the shared spool volume.

Layout under DATA/bots/<bot>/:  files/<id>  (blob), meta/<id>.json.
A bot key selects the directory; the id is validated as 32 hex characters, so a path
that leaves the bot's directory cannot be built from bot input. A generated image is
counted against the bot's quota; files older than the TTL are swept.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from .config import BOT_KEY_RE

ID_RE = re.compile(r"^[0-9a-f]{32}$")
NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


class StoreError(Exception):
    """Safe to show the bot."""


def safe_name(name: str | None, default: str = "file") -> str:
    base = os.path.basename((name or "").replace("\\", "/"))
    base = NAME_RE.sub("_", base).strip("._-")[:80]
    return base or default


class Store:
    def __init__(self, root: Path, quota_bytes: int, max_file_bytes: int, ttl_hours: int,
                 spool_max_bytes: int = 0, spool_min_free_bytes: int = 0):
        self.root = root
        self.quota_bytes = quota_bytes
        self.max_file_bytes = max_file_bytes
        self.ttl_s = ttl_hours * 3600
        self.spool_max_bytes = spool_max_bytes  # 0 = no ceiling
        self.spool_min_free_bytes = spool_min_free_bytes  # 0 = do not look at the filesystem
        self._locks: dict[str, threading.RLock] = {}
        self._locks_guard = threading.Lock()
        self._spool_cache: tuple[float, int] | None = None

    @contextmanager
    def lock(self, bot: str):
        """Serialises quota check + write for one bot (reserve and put must not interleave)."""
        if not BOT_KEY_RE.match(bot):
            raise StoreError("bad bot key")
        with self._locks_guard:
            lk = self._locks.setdefault(bot, threading.RLock())  # keys are bounded by the bot config
        with lk:
            yield

    # -- paths
    def bot_dir(self, bot: str) -> Path:
        if not BOT_KEY_RE.match(bot):
            raise StoreError("bad bot key")
        p = self.root / "bots" / bot
        for sub in ("files", "meta"):
            (p / sub).mkdir(parents=True, exist_ok=True)
        return p

    def blob(self, bot: str, fid: str) -> Path:
        if not ID_RE.match(fid or ""):
            raise StoreError("bad file id")
        return self.bot_dir(bot) / "files" / fid

    def _meta_path(self, bot: str, fid: str) -> Path:
        if not ID_RE.match(fid or ""):
            raise StoreError("bad file id")
        return self.bot_dir(bot) / "meta" / f"{fid}.json"

    # -- read
    def meta(self, bot: str, fid: str) -> dict:
        try:
            return json.loads(self._meta_path(bot, fid).read_text())
        except FileNotFoundError:
            raise StoreError("no such file (unknown id, expired or deleted)") from None

    def list(self, bot: str) -> list[dict]:
        out = []
        for p in sorted((self.bot_dir(bot) / "meta").glob("*.json"), key=lambda q: q.stat().st_mtime):
            try:
                out.append(json.loads(p.read_text()))
            except (OSError, ValueError):
                continue
        return out

    def used_bytes(self, bot: str) -> int:
        """Everything the bot holds on disk, counted once per inode."""
        d = self.bot_dir(bot)
        seen: set[tuple[int, int]] = set()
        total = 0
        try:
            entries = list(os.scandir(d / "files"))
        except OSError:
            entries = []
        for e in entries:
            try:
                st = e.stat(follow_symlinks=False)
            except OSError:
                continue
            seen.add((st.st_dev, st.st_ino))
            total += st.st_size
        return total

    def remaining(self, bot: str, quota: int | None = None) -> int:
        return max(0, (quota or self.quota_bytes) - self.used_bytes(bot))

    def spool_used(self, max_age: float = 15.0) -> int:
        """Sum over all bots; cached briefly."""
        now = time.monotonic()
        if self._spool_cache and now - self._spool_cache[0] < max_age:
            return self._spool_cache[1]
        total = 0
        for bdir in (self.root / "bots").glob("*"):
            if BOT_KEY_RE.match(bdir.name):
                total += self.used_bytes(bdir.name)
        self._spool_cache = (now, total)
        return total

    def spool_free_bytes(self) -> int:
        """How much may still be written to the spool: the smaller of the ceiling and the free space."""
        room = 1 << 62
        if self.spool_max_bytes:
            room = max(0, self.spool_max_bytes - self.spool_used())
        if self.spool_min_free_bytes:
            try:
                room = min(room, max(0, shutil.disk_usage(self.root).free - self.spool_min_free_bytes))
            except OSError:
                pass
        return room

    # -- write
    def reserve(self, bot: str, size: int, quota: int | None = None) -> None:
        if size > self.max_file_bytes:
            raise StoreError(f"file larger than {self.max_file_bytes // 2**20} MiB")
        if self.used_bytes(bot) + size > (quota or self.quota_bytes):
            raise StoreError("bot storage quota exceeded: delete files with file_delete")
        if size > self.spool_free_bytes():
            raise StoreError("the service storage is full, try again later")

    def put_bytes(self, bot: str, data: bytes, name: str, kind: str = "upload", quota: int | None = None) -> dict:
        with self.lock(bot):
            self.reserve(bot, len(data), quota)
            self._spool_cache = None
            fid = uuid.uuid4().hex
            dst = self.blob(bot, fid)
            dst.write_bytes(data)
            meta = {"id": fid, "name": safe_name(name), "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                    "kind": kind, "created": int(time.time())}
            tmp = self._meta_path(bot, fid).with_suffix(".tmp")
            tmp.write_text(json.dumps(meta))
            os.replace(tmp, self._meta_path(bot, fid))
            return meta

    def delete(self, bot: str, fid: str) -> None:
        self.meta(bot, fid)
        self.blob(bot, fid).unlink(missing_ok=True)
        self._meta_path(bot, fid).unlink(missing_ok=True)
        self._spool_cache = None

    def sweep(self) -> int:
        """Remove files older than the TTL, across all bots."""
        cutoff, n = time.time() - self.ttl_s, 0
        for bdir in (self.root / "bots").glob("*"):
            for m in (bdir / "meta").glob("*.json"):
                if m.stat().st_mtime < cutoff:
                    (bdir / "files" / m.stem).unlink(missing_ok=True)
                    m.unlink(missing_ok=True)
                    n += 1
        return n