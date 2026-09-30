"""Settings from the environment and the per-bot ACL from bots.json (read once at start)."""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")
ROOT_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
MAIL_MODES = ("none", "read", "send")


class ConfigError(ValueError):
    pass


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
class Root:
    """A named part of OneDrive. `shared` = a folder in someone else's drive (read only);
    `own` = a folder in the connector account's own drive."""

    name: str
    kind: str  # "shared" | "own"
    description: str = ""
    drive_id: str | None = None  # shared
    item_id: str | None = None  # shared
    folder: str | None = None  # own: path from the drive root, no leading slash


@dataclass(frozen=True)
class BotPolicy:
    key: str  # Paperclip agent id
    label: str
    peer_host: str | None
    drive: dict[str, str]  # root name -> "ro" | "rw"
    mail: str = "none"  # none | read | send
    rate_per_min: int | None = None


@dataclass(frozen=True)
class Settings:
    state_dir: Path = Path("/state")
    acl_file: Path = Path("/config/bots.json")
    listen_host: str = "0.0.0.0"
    listen_port: int = 8080
    client_id: str = ""
    tenant: str = "consumers"
    scopes: str = "Files.ReadWrite.All Mail.ReadWrite Mail.Send offline_access User.Read"
    gateway_token_sha256: str = ""  # the board's shared bearer for /mcp (hex sha256)
    max_file_bytes: int = 1024**3
    bot_quota_bytes: int = 2 * 1024**3
    total_quota_bytes: int = 5 * 1024**3
    stage_ttl_hours: int = 12
    rate_per_min: int = 120
    max_text_bytes: int = 200_000
    max_mail_attachment_bytes: int = 3 * 1024 * 1024
    send_per_hour: int = 30
    max_recipients: int = 20
    allowed_hosts: tuple[str, ...] = ("cloud-files", "cloud-files:8080")
    roots: dict[str, Root] = field(default_factory=dict)
    bots: dict[str, BotPolicy] = field(default_factory=dict)


def load_acl(path: Path) -> tuple[dict[str, Root], dict[str, BotPolicy]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    roots: dict[str, Root] = {}
    for name, r in (raw.get("roots") or {}).items():
        if not ROOT_RE.match(name):
            raise ConfigError(f"bad root name {name!r}")
        kind = r.get("kind")
        if kind == "shared":
            if not (r.get("drive_id") and r.get("item_id")):
                raise ConfigError(f"root {name}: shared needs drive_id and item_id")
            roots[name] = Root(name, "shared", r.get("description", ""), r["drive_id"], r["item_id"])
        elif kind == "own":
            parts = [p for p in str(r.get("folder", "")).replace("\\", "/").split("/") if p]
            if not parts or any(p in (".", "..") for p in parts):
                raise ConfigError(f"root {name}: own needs a non-empty folder without dots")
            roots[name] = Root(name, "own", r.get("description", ""), folder="/".join(parts))
        else:
            raise ConfigError(f"root {name}: kind must be shared or own")
    bots: dict[str, BotPolicy] = {}
    for key, b in (raw.get("bots") or {}).items():
        if not KEY_RE.match(key):
            raise ConfigError(f"bad bot key {key!r}")
        drive = dict(b.get("drive") or {})
        for rn, mode in drive.items():
            if rn not in roots:
                raise ConfigError(f"bot {key}: unknown root {rn!r}")
            if mode not in ("ro", "rw"):
                raise ConfigError(f"bot {key}: root {rn}: mode must be ro or rw")
            if mode == "rw" and roots[rn].kind == "shared":
                raise ConfigError(f"bot {key}: root {rn} is shared with us read-only; rw is not possible")
        mail = b.get("mail", "none")
        if mail not in MAIL_MODES:
            raise ConfigError(f"bot {key}: mail must be one of {MAIL_MODES}")
        if not b.get("peer_host"):
            raise ConfigError(f"bot {key}: peer_host is required (file transfer identifies the bot by it)")
        bots[key] = BotPolicy(key, b.get("label", key), b["peer_host"], drive, mail, b.get("rate_per_min"))
    return roots, bots


def load_settings(*, need_acl: bool = True) -> Settings:
    e = os.environ.get
    tok = _secret("CLOUD_GATEWAY_TOKEN")
    s = Settings(
        state_dir=Path(e("CLOUD_STATE_DIR", "/state")),
        acl_file=Path(e("CLOUD_ACL_FILE", "/config/bots.json")),
        listen_host=e("CLOUD_LISTEN_HOST", "0.0.0.0"),
        listen_port=_int("CLOUD_LISTEN_PORT", 8080),
        client_id=e("CLOUD_CLIENT_ID", "").strip(),
        tenant=e("CLOUD_TENANT", "consumers").strip(),
        scopes=e("CLOUD_SCOPES", Settings.scopes).strip(),
        gateway_token_sha256=hashlib.sha256(tok.encode()).hexdigest() if tok else "",
        max_file_bytes=_int("CLOUD_MAX_FILE_BYTES", 1024**3),
        bot_quota_bytes=_int("CLOUD_BOT_QUOTA_BYTES", 2 * 1024**3),
        total_quota_bytes=_int("CLOUD_TOTAL_QUOTA_BYTES", 5 * 1024**3),
        stage_ttl_hours=_int("CLOUD_STAGE_TTL_HOURS", 12),
        rate_per_min=_int("CLOUD_RATE_PER_MIN", 120),
        send_per_hour=_int("CLOUD_SEND_PER_HOUR", 30),
        allowed_hosts=tuple(h.strip() for h in e("CLOUD_ALLOWED_HOSTS", "cloud-files,cloud-files:8080").split(",") if h.strip()),
    )
    if need_acl:
        roots, bots = load_acl(s.acl_file)
        object.__setattr__(s, "roots", roots)
        object.__setattr__(s, "bots", bots)
    return s
