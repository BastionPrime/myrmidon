# tools/egress-proxy/src/egress_proxy/journal.py
"""The destination journal — the whole point of log-only mode (EGRESS-A).

One line per request a bot sends through the proxy, as compact JSON so the
observation period's inventory (which project reaches which host) can be read
back with `grep`/`jq` instead of a parser. The line names the bot and its
project, the destination and the outcome. It never carries a credential: the
proxy user is taken out of `Proxy-Authorization` and the header itself is
dropped — that value is the only thing in a proxy request that is a secret.
"""

from __future__ import annotations

import base64
import binascii
import json
import sys
import time
from typing import Any, TextIO

from .config import BotEntry

UNKNOWN_BOT = "unknown"

#: Keys of a journal line, in the order they are written.
RECORD_FIELDS = ("ts", "bot", "project", "method", "scheme", "destination", "port", "result")


def parse_proxy_user(authorization_header: str | None) -> str:
    """The bot key out of `Proxy-Authorization: Basic <base64(user:password)>`.

    Log-only mode does not authenticate anybody: a request without a header, or
    with one this function cannot read, still passes and is recorded under
    `unknown` — the journal is observation, not access control, and a bot that
    somehow missed its proxy URL must not disappear from the inventory.
    """
    if not authorization_header:
        return UNKNOWN_BOT
    parts = authorization_header.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "basic":
        return UNKNOWN_BOT
    try:
        decoded = base64.b64decode(parts[1].strip(), validate=True).decode("utf-8", "replace")
    except (ValueError, binascii.Error):
        return UNKNOWN_BOT
    user, _, _password = decoded.partition(":")
    user = user.strip()
    return user or UNKNOWN_BOT


def project_for(bots: dict[str, BotEntry], bot: str) -> str:
    entry = bots.get(bot)
    return entry.project if entry is not None else ""


class DestinationJournal:
    """Writes the journal, one JSON line per destination. Never raises."""

    def __init__(self, stream: TextIO | None = None, bots: dict[str, BotEntry] | None = None) -> None:
        self.stream = stream if stream is not None else sys.stdout
        self.bots = bots or {}
        self.count = 0

    def record(
        self,
        *,
        bot: str,
        method: str,
        host: str,
        port: int,
        scheme: str,
        result: str,
    ) -> dict[str, Any]:
        record = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "bot": bot,
            "project": project_for(self.bots, bot),
            "method": method,
            "scheme": scheme,
            "destination": host,
            "port": port,
            "result": result,
        }
        return record

    def emit(self, record: dict[str, Any]) -> None:
        line = json.dumps({key: record[key] for key in RECORD_FIELDS}, ensure_ascii=False, separators=(",", ":"))
        try:
            self.stream.write(f"{line}\n")
            self.stream.flush()
        except (ValueError, OSError):
            # A closed stdout (container stopping) must not take the proxy down
            # with it: the request it was describing is already on its way.
            return
        self.count += 1