"""Per-bot file store on the shared spool volume.

Layout under DATA/bots/<bot>/:  files/<id>  (blob), meta/<id>.json, jobs/<job>/{in,out,job.json}.
A bot key selects the directory; the id is validated as 32 hex characters, so a path
that leaves the bot's directory cannot be built from bot input.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import time
import uuid
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
    def __init__(self, root: Path, quota_bytes: int, max_file_bytes: int, ttl_hours: int):
        self.root = root
        self.quota_bytes = quota_bytes
        self.max_file_bytes = max_file_bytes
        self.ttl_s = ttl_hours * 3600

    # -- paths
    def bot_dir(self, bot: str) -> Path:
        if not BOT_KEY_RE.match(bot):
            raise StoreError("bad bot key")
        p = self.root / "bots" / bot
        for sub in ("files", "meta", "jobs"):
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
        return sum(m.get("size", 0) for m in self.list(bot))

    # -- write
    def reserve(self, bot: str, size: int, quota: int | None = None) -> None:
        if size > self.max_file_bytes:
            raise StoreError(f"file larger than {self.max_file_bytes // 2**20} MiB")
        if self.used_bytes(bot) + size > (quota or self.quota_bytes):
            raise StoreError("bot storage quota exceeded: delete files with file_delete")

    def put_path(self, bot: str, src: Path, name: str, kind: str = "upload", *, move: bool = True) -> dict:
        """Register an existing file (already inside the spool) as a stored file."""
        size = src.stat().st_size
        fid = uuid.uuid4().hex
        dst = self.blob(bot, fid)
        h = hashlib.sha256()
        with src.open("rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        if move:
            os.replace(src, dst)
        else:
            shutil.copyfile(src, dst)
        meta = {"id": fid, "name": safe_name(name), "size": size, "sha256": h.hexdigest(),
                "kind": kind, "created": int(time.time())}
        tmp = self._meta_path(bot, fid).with_suffix(".tmp")
        tmp.write_text(json.dumps(meta))
        os.replace(tmp, self._meta_path(bot, fid))
        return meta

    def put_bytes(self, bot: str, data: bytes, name: str, kind: str = "upload", quota: int | None = None) -> dict:
        self.reserve(bot, len(data), quota)
        tmp = self.bot_dir(bot) / "files" / f".tmp-{uuid.uuid4().hex}"
        tmp.write_bytes(data)
        return self.put_path(bot, tmp, name, kind)

    def delete(self, bot: str, fid: str) -> None:
        self.meta(bot, fid)
        self.blob(bot, fid).unlink(missing_ok=True)
        self._meta_path(bot, fid).unlink(missing_ok=True)

    def sweep(self) -> int:
        """Remove files and job dirs older than the TTL, across all bots."""
        cutoff, n = time.time() - self.ttl_s, 0
        for bdir in (self.root / "bots").glob("*"):
            for m in (bdir / "meta").glob("*.json"):
                if m.stat().st_mtime < cutoff:
                    (bdir / "files" / m.stem).unlink(missing_ok=True)
                    m.unlink(missing_ok=True)
                    n += 1
            for t in (bdir / "files").glob(".tmp-*"):
                if t.stat().st_mtime < cutoff:
                    t.unlink(missing_ok=True)
            for j in (bdir / "jobs").glob("*"):
                if j.is_dir() and j.stat().st_mtime < cutoff:
                    shutil.rmtree(j, ignore_errors=True)
                    n += 1
        return n
