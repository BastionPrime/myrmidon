"""Environment-driven settings, read once at start.

The model allow-list, the sizes and the per-bot budget are configuration, never bot code:
the service reads them from the environment (and from config/bots.json for the per-bot part).
No secret value lives in this file; the gateway key is read from the environment variable
named by IMAGE_GATEWAY_TOKEN (or from the file named by IMAGE_GATEWAY_TOKEN_FILE).
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

BOT_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
SIZE_RE = re.compile(r"^[1-9][0-9]{0,4}x[1-9][0-9]{0,4}$")


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    return int(raw) if raw else default


def _csv(name: str, default: str = "") -> tuple[str, ...]:
    raw = os.environ.get(name, "").strip() or default
    return tuple(v.strip() for v in raw.split(",") if v.strip())


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
    generations_per_day: int | None = None  # 0 = disabled; None = the service default


@dataclass(frozen=True)
class Settings:
    data_dir: Path = Path("/spool")
    bots_file: Path = Path("/config/bots.json")
    listen_host: str = "0.0.0.0"
    listen_port: int = 8080
    gateway_base_url: str = "http://image-gateway:4000"
    gateway_token: str = ""
    models: frozenset[str] = frozenset()  # IMAGE_MODELS; empty = nothing may be generated
    sizes: frozenset[str] = frozenset({"1024x1024", "1328x1328"})
    max_prompt_chars: int = 2000
    max_images_per_call: int = 4
    generations_per_day: int = 200  # service default when the bot sets none
    # limits
    max_request_bytes: int = 24 * 1024 * 1024  # one MCP request (base64 inline)
    max_inline_result_bytes: int = 4 * 1024 * 1024  # base64 in a tool result
    max_file_bytes: int = 32 * 1024 * 1024  # one generated image
    bot_quota_bytes: int = 2 * 1024**3
    spool_max_bytes: int = 32 * 1024**3  # ceiling for all bots together; 0 = none
    spool_min_free_bytes: int = 2 * 1024**3  # keep this much free on the spool filesystem; 0 = do not look
    file_ttl_hours: int = 48
    rate_per_min: int = 30
    allowed_hosts: tuple[str, ...] = ("image-mcp", "image-mcp:8080")  # Host header values the MCP endpoint accepts
    upstream_timeout_s: int = 120
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
        budget = cfg.get("generations_per_day")
        if budget is not None and (isinstance(budget, bool) or not isinstance(budget, int) or budget < 0):
            raise ValueError(f"bot {key}: generations_per_day must be a non-negative integer")
        out[key] = BotPolicy(
            key=key,
            token_sha256=(cfg.get("token_sha256") or "").lower() or None,
            peer_host=cfg.get("peer_host") or None,
            tools=frozenset(tools) if tools else None,
            quota_bytes=cfg.get("quota_bytes"),
            rate_per_min=cfg.get("rate_per_min"),
            generations_per_day=budget,
        )
    return out


def load_settings(*, need_bots: bool = True) -> Settings:
    e = os.environ.get
    models = frozenset(_csv("IMAGE_MODELS"))
    sizes = frozenset(s for s in _csv("IMAGE_SIZES", "1024x1024,1328x1328") if SIZE_RE.match(s))
    s = Settings(
        data_dir=Path(e("IMAGE_DATA_DIR", "/spool")),
        bots_file=Path(e("IMAGE_BOTS_FILE", "/config/bots.json")),
        listen_host=e("IMAGE_LISTEN_HOST", "0.0.0.0"),
        listen_port=_int("IMAGE_LISTEN_PORT", 8080),
        gateway_base_url=e("IMAGE_GATEWAY_BASE_URL", "http://image-gateway:4000").rstrip("/"),
        gateway_token=_secret("IMAGE_GATEWAY_TOKEN"),
        models=models,
        sizes=sizes,
        max_prompt_chars=_int("IMAGE_MAX_PROMPT_CHARS", 2000),
        max_images_per_call=_int("IMAGE_MAX_IMAGES_PER_CALL", 4),
        generations_per_day=_int("IMAGE_GENERATIONS_PER_DAY", 200),
        max_request_bytes=_int("IMAGE_MAX_REQUEST_BYTES", 24 * 1024 * 1024),
        max_inline_result_bytes=_int("IMAGE_MAX_INLINE_RESULT_BYTES", 4 * 1024 * 1024),
        max_file_bytes=_int("IMAGE_MAX_FILE_BYTES", 32 * 1024 * 1024),
        bot_quota_bytes=_int("IMAGE_BOT_QUOTA_BYTES", 2 * 1024**3),
        spool_max_bytes=_int("IMAGE_SPOOL_MAX_BYTES", 32 * 1024**3),
        spool_min_free_bytes=_int("IMAGE_SPOOL_MIN_FREE_BYTES", 2 * 1024**3),
        file_ttl_hours=_int("IMAGE_FILE_TTL_HOURS", 48),
        rate_per_min=_int("IMAGE_RATE_PER_MIN", 30),
        allowed_hosts=tuple(h.strip() for h in e("IMAGE_ALLOWED_HOSTS", "image-mcp,image-mcp:8080").split(",") if h.strip()),
        upstream_timeout_s=_int("IMAGE_UPSTREAM_TIMEOUT_S", 120),
    )
    if need_bots:
        object.__setattr__(s, "bots", load_bots(s.bots_file))
    return s