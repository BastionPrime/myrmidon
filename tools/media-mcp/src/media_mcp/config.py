"""Environment-driven settings, read once at start."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

BOT_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    return int(raw) if raw else default


def _secret(name: str) -> str:
    """Value from NAME, or from the file named by NAME_FILE (docker secrets)."""
    path = os.environ.get(f"{name}_FILE", "").strip()
    if path:
        return Path(path).read_text(encoding="utf-8").strip()
    return os.environ.get(name, "").strip()


@dataclass(frozen=True)
class BotPolicy:
    key: str
    token_sha256: str | None = None  # hex sha256 of the bot's bearer token
    peer_host: str | None = None  # docker DNS name whose address must equal the peer
    tools: frozenset[str] | None = None  # None = every tool
    quota_bytes: int | None = None
    rate_per_min: int | None = None


@dataclass(frozen=True)
class Settings:
    data_dir: Path = Path("/spool")
    bots_file: Path = Path("/config/bots.json")
    listen_host: str = "0.0.0.0"
    listen_port: int = 8080
    gotenberg_url: str = "http://gotenberg:3000"
    tika_url: str = "http://tika:9998"
    worker_url: str = "http://media-worker:8081"
    worker_token: str = ""
    # limits
    max_request_bytes: int = 24 * 1024 * 1024  # one MCP request (base64 inline)
    max_inline_result_bytes: int = 4 * 1024 * 1024  # base64 in a tool result
    max_file_bytes: int = 512 * 1024 * 1024
    bot_quota_bytes: int = 4 * 1024**3
    spool_max_bytes: int = 64 * 1024**3  # ceiling for all bots together; 0 = none
    spool_min_free_bytes: int = 2 * 1024**3  # keep this much free on the spool filesystem; 0 = do not look
    file_ttl_hours: int = 48
    max_active_jobs_per_bot: int = 3
    rate_per_min: int = 90
    max_text_chars: int = 200_000
    max_convert_bytes: int = 64 * 1024 * 1024  # input of extract_text / office_to_pdf (streamed, but the converters hold it in memory)
    max_pdf_bytes: int = 128 * 1024 * 1024  # a converted PDF larger than this is cut off and refused
    allowed_hosts: tuple[str, ...] = ("media-mcp", "media-mcp:8080")  # Host header values the MCP endpoint accepts
    backend_timeout_s: int = 120
    bots: dict[str, BotPolicy] = field(default_factory=dict)


def load_bots(path: Path) -> dict[str, BotPolicy]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    out: dict[str, BotPolicy] = {}
    for key, cfg in (raw.get("bots") or {}).items():
        if not BOT_KEY_RE.match(key):
            raise ValueError(f"bad bot key {key!r}")
        if not cfg.get("token_sha256") and not cfg.get("peer_host"):
            raise ValueError(f"bot {key}: needs token_sha256 and/or peer_host")
        tools = cfg.get("tools")
        out[key] = BotPolicy(
            key=key,
            token_sha256=(cfg.get("token_sha256") or "").lower() or None,
            peer_host=cfg.get("peer_host") or None,
            tools=frozenset(tools) if tools else None,
            quota_bytes=cfg.get("quota_bytes"),
            rate_per_min=cfg.get("rate_per_min"),
        )
    return out


def load_settings(*, need_bots: bool = True) -> Settings:
    e = os.environ.get
    s = Settings(
        data_dir=Path(e("MEDIA_DATA_DIR", "/spool")),
        bots_file=Path(e("MEDIA_BOTS_FILE", "/config/bots.json")),
        listen_host=e("MEDIA_LISTEN_HOST", "0.0.0.0"),
        listen_port=_int("MEDIA_LISTEN_PORT", 8080),
        gotenberg_url=e("MEDIA_GOTENBERG_URL", "http://gotenberg:3000").rstrip("/"),
        tika_url=e("MEDIA_TIKA_URL", "http://tika:9998").rstrip("/"),
        worker_url=e("MEDIA_WORKER_URL", "http://media-worker:8081").rstrip("/"),
        worker_token=_secret("MEDIA_WORKER_TOKEN"),
        max_request_bytes=_int("MEDIA_MAX_REQUEST_BYTES", 24 * 1024 * 1024),
        max_inline_result_bytes=_int("MEDIA_MAX_INLINE_RESULT_BYTES", 4 * 1024 * 1024),
        max_file_bytes=_int("MEDIA_MAX_FILE_BYTES", 512 * 1024 * 1024),
        bot_quota_bytes=_int("MEDIA_BOT_QUOTA_BYTES", 4 * 1024**3),
        spool_max_bytes=_int("MEDIA_SPOOL_MAX_BYTES", 64 * 1024**3),
        spool_min_free_bytes=_int("MEDIA_SPOOL_MIN_FREE_BYTES", 2 * 1024**3),
        file_ttl_hours=_int("MEDIA_FILE_TTL_HOURS", 48),
        max_active_jobs_per_bot=_int("MEDIA_MAX_ACTIVE_JOBS_PER_BOT", 3),
        rate_per_min=_int("MEDIA_RATE_PER_MIN", 90),
        max_text_chars=_int("MEDIA_MAX_TEXT_CHARS", 200_000),
        max_convert_bytes=_int("MEDIA_MAX_CONVERT_BYTES", 64 * 1024 * 1024),
        max_pdf_bytes=_int("MEDIA_MAX_PDF_BYTES", 128 * 1024 * 1024),
        allowed_hosts=tuple(h.strip() for h in e("MEDIA_ALLOWED_HOSTS", "media-mcp,media-mcp:8080").split(",") if h.strip()),
        backend_timeout_s=_int("MEDIA_BACKEND_TIMEOUT_S", 120),
    )
    if need_bots:
        object.__setattr__(s, "bots", load_bots(s.bots_file))
    return s
