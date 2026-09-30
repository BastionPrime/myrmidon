# tools/egress-proxy/src/egress_proxy/config.py
"""Instance settings of the egress proxy, read once at startup.

Every variable is instance-wide: the proxy serves the whole bot network, so a
bot is named in the journal from its own request (the proxy user in the URL the
driver puts into the bot's profile, see
server/src/myrmidon/bot-containers/egress.ts), never by a per-bot setting here.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

DEFAULT_PORT = 3128
DEFAULT_BIND = "0.0.0.0"
DEFAULT_CONNECT_TIMEOUT_SEC = 30
DEFAULT_POLICY_REFRESH_SEC = 30

MODE_ENV = "EGRESS_PROXY_MODE"
PORT_ENV = "EGRESS_PROXY_PORT"
BIND_ENV = "EGRESS_PROXY_BIND"
BOTS_FILE_ENV = "EGRESS_PROXY_BOTS_FILE"
CONNECT_TIMEOUT_ENV = "EGRESS_PROXY_CONNECT_TIMEOUT_SEC"
POLICY_URL_ENV = "EGRESS_PROXY_POLICY_URL"
POLICY_TOKEN_ENV = "EGRESS_PROXY_POLICY_TOKEN"
POLICY_FILE_ENV = "EGRESS_PROXY_POLICY_FILE"
POLICY_REFRESH_ENV = "EGRESS_PROXY_POLICY_REFRESH_SEC"

#: `log` records every destination and refuses none (EGRESS-A). `enforce` adds
#: the decision of every project whose policy says `block` (EGRESS-B); a project
#: whose policy says `log` keeps recording even then, so one project can be
#: switched back without touching the service.
SUPPORTED_MODES = ("log", "enforce")


class ConfigError(Exception):
    """A setting that must stop the service rather than be rounded off."""


@dataclass(frozen=True)
class BotEntry:
    """One bot as this proxy knows it: the project it belongs to, for the journal."""

    bot_key: str
    project: str = ""


@dataclass(frozen=True)
class Config:
    mode: str = "log"
    bind: str = DEFAULT_BIND
    port: int = DEFAULT_PORT
    connect_timeout_sec: int = DEFAULT_CONNECT_TIMEOUT_SEC
    bots: dict[str, BotEntry] = field(default_factory=dict)
    #: Where the lists come from: the board over HTTP, or a file. Either is
    #: optional in `log` mode and required in `enforce` — an enforcing service
    #: without a source would have nothing to decide with.
    policy_url: str = ""
    policy_token: str = ""
    policy_file: str = ""
    policy_refresh_sec: int = DEFAULT_POLICY_REFRESH_SEC


def _read_int(env: dict[str, str], name: str, default: int, minimum: int, maximum: int) -> int:
    raw = (env.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from exc
    if not minimum <= value <= maximum:
        raise ConfigError(f"{name} must be between {minimum} and {maximum}, got {value}")
    return value


def load_bots(path: str | None) -> dict[str, BotEntry]:
    """Read the optional bot -> project map.

    Nothing here is an access decision (log-only mode has none): the map only
    turns a bot key into the project the journal should name. A bot the map does
    not mention is still served — its destinations are recorded with an empty
    project, which is exactly the gap the observation period exists to close.
    """
    if not path:
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            document = json.load(handle)
    except FileNotFoundError as exc:
        raise ConfigError(f"{BOTS_FILE_ENV}: no such file: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ConfigError(f"{BOTS_FILE_ENV}: {path} is not valid JSON: {exc}") from exc
    if not isinstance(document, dict):
        raise ConfigError(f"{BOTS_FILE_ENV}: {path} must hold an object")
    raw_bots = document.get("bots", {})
    if not isinstance(raw_bots, dict):
        raise ConfigError(f'{BOTS_FILE_ENV}: {path}: "bots" must be an object')
    bots: dict[str, BotEntry] = {}
    for bot_key, entry in raw_bots.items():
        if not isinstance(entry, dict):
            raise ConfigError(f'{BOTS_FILE_ENV}: {path}: bot "{bot_key}" must be an object')
        project = entry.get("project", "")
        if not isinstance(project, str):
            raise ConfigError(f'{BOTS_FILE_ENV}: {path}: bot "{bot_key}": "project" must be a string')
        bots[str(bot_key)] = BotEntry(bot_key=str(bot_key), project=project.strip())
    return bots


def load_config(env: dict[str, str] | None = None) -> Config:
    env = dict(os.environ if env is None else env)
    mode = (env.get(MODE_ENV) or "log").strip().lower() or "log"
    if mode not in SUPPORTED_MODES:
        raise ConfigError(
            f"{MODE_ENV} must be one of {', '.join(SUPPORTED_MODES)}, got {mode!r}"
        )
    policy_url = (env.get(POLICY_URL_ENV) or "").strip()
    policy_file = (env.get(POLICY_FILE_ENV) or "").strip()
    if mode == "enforce" and not policy_url and not policy_file:
        # Same fail-closed rule as EGRESS-A's `log` without a proxy address: a
        # service asked to enforce must not come up enforcing nothing.
        raise ConfigError(
            f"{MODE_ENV} is \"enforce\": set {POLICY_URL_ENV} (the board's policy endpoint) "
            f"or {POLICY_FILE_ENV} — without a list there is nothing to decide with"
        )
    return Config(
        mode=mode,
        bind=(env.get(BIND_ENV) or DEFAULT_BIND).strip() or DEFAULT_BIND,
        port=_read_int(env, PORT_ENV, DEFAULT_PORT, 1, 65535),
        connect_timeout_sec=_read_int(env, CONNECT_TIMEOUT_ENV, DEFAULT_CONNECT_TIMEOUT_SEC, 1, 600),
        bots=load_bots((env.get(BOTS_FILE_ENV) or "").strip() or None),
        policy_url=policy_url,
        policy_token=(env.get(POLICY_TOKEN_ENV) or "").strip(),
        policy_file=policy_file,
        policy_refresh_sec=_read_int(env, POLICY_REFRESH_ENV, DEFAULT_POLICY_REFRESH_SEC, 1, 3600),
    )