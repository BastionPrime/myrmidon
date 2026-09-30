# tools/egress-proxy/src/egress_proxy/policy.py
"""Destination allowlists and the per-project mode (EGRESS-B).

EGRESS-A made this service a journal: it recorded where every bot went and
refused nothing (server.py's own docstring says so). This module is the other
half of plan item 5 — the lists and the decision. It is deliberately small and
free of I/O so the decision itself can be tested without a socket:

  - a *project* has a mode and a list of destinations. Mode ``log`` keeps
    recording; mode ``block`` refuses a destination that is on neither its own
    list nor the bot's;
  - a *bot* has the project the journal should name for it and its own extra
    destinations.

Where the document comes from is the caller's business: the service fetches it
from the board (``fetch_policy``, ``PolicyRefresher``), but the same parser
reads a file, which is what the tests and a stand without a board use.
"""

from __future__ import annotations

import json
import re
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

#: The document version this image understands. A document of another version is
#: refused rather than read hopefully: the shape decides whether traffic passes.
SUPPORTED_DOCUMENT_VERSION = 1

MODE_LOG = "log"
MODE_BLOCK = "block"

#: Host names and IPv4 literals only, no wildcards: the list is matched by name
#: on both sides of the wire (the board stores it, this service enforces it), and
#: no client in the fleet understands a pattern.
HOST_PATTERN = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$")


class PolicyError(Exception):
    """A policy document that must not be used instead of the last good one."""


@dataclass(frozen=True)
class Destination:
    """One allowed destination: a host and an optional port.

    ``port is None`` means every port on that host — that is what a bare host in
    the list means, and it is also what the journal records for a destination
    whose port was not named.
    """

    host: str
    port: int | None

    def matches(self, host: str, port: int | None) -> bool:
        if self.host != host.strip().lower():
            return False
        return self.port is None or self.port == port


def parse_destination(text: str) -> Destination | None:
    """Reads ``host`` or ``host:port``. Anything else — a scheme, a path, a
    pattern — is not a destination and is refused, not stored as typed."""
    value = text.strip().lower()
    if not value or "/" in value or "?" in value or "#" in value or any(ch.isspace() for ch in value):
        return None
    host, sep, raw_port = value.partition(":")
    if not host or not HOST_PATTERN.match(host):
        return None
    if not sep or raw_port == "*":
        return Destination(host=host, port=None)
    if not raw_port.isdigit():
        return None
    port = int(raw_port)
    if not 0 < port < 65536:
        return None
    return Destination(host=host, port=port)


def _parse_destinations(raw: Any, where: str) -> list[Destination]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise PolicyError(f"{where}: destinations must be a list")
    parsed: list[Destination] = []
    for entry in raw:
        if not isinstance(entry, str):
            raise PolicyError(f"{where}: a destination must be a string")
        destination = parse_destination(entry)
        if destination is None:
            raise PolicyError(f"{where}: {entry!r} is not a destination")
        parsed.append(destination)
    return parsed


@dataclass(frozen=True)
class ProjectPolicy:
    mode: str = MODE_LOG
    allow: tuple[Destination, ...] = ()


@dataclass(frozen=True)
class BotPolicy:
    project: str = ""
    allow: tuple[Destination, ...] = ()


@dataclass(frozen=True)
class EgressPolicy:
    """The whole decision, loaded once and replaced atomically on refresh."""

    bots: dict[str, BotPolicy] = field(default_factory=dict)
    projects: dict[str, ProjectPolicy] = field(default_factory=dict)

    def project_of(self, bot: str) -> str:
        entry = self.bots.get(bot)
        return entry.project if entry is not None else ""

    def allows(self, bot: str, host: str, port: int | None) -> bool:
        """Whether this bot may reach ``host:port``.

        The bot's own list is added to its project's: a destination named on
        either one is allowed. A bot whose key is not in the document has no
        project and no list of its own — an empty list is *not* a refusal, the
        mode is (see ``decides_to_block``), so an unknown bot still has to be
        named in a project that is switched to blocking.
        """
        project = self.projects.get(self.project_of(bot))
        candidates: list[Destination] = list(project.allow) if project is not None else []
        own = self.bots.get(bot)
        if own is not None:
            candidates.extend(own.allow)
        return any(entry.matches(host, port) for entry in candidates)

    def decides_to_block(self, bot: str, host: str, port: int | None) -> bool:
        """True when this request must be refused.

        Only a project whose own mode is ``block`` decides that, and only for a
        destination it does not allow. A project without a policy, or with mode
        ``log``, records as EGRESS-A did.
        """
        project = self.projects.get(self.project_of(bot))
        if project is None or project.mode != MODE_BLOCK:
            return False
        return not self.allows(bot, host, port)


def parse_policy_document(document: Any) -> EgressPolicy:
    """Reads the document the board publishes (or the same shape from a file).

    Every mistake raises: a list this service cannot read must leave the last
    good policy in place, not silently become "nothing is allowed" (which would
    refuse a working project's traffic) or "everything is allowed" (which would
    quietly undo a blocking project).
    """
    if not isinstance(document, dict):
        raise PolicyError("policy document must be an object")
    version = document.get("version")
    if version != SUPPORTED_DOCUMENT_VERSION:
        raise PolicyError(f"policy document version must be {SUPPORTED_DOCUMENT_VERSION}, got {version!r}")

    bots: dict[str, BotPolicy] = {}
    raw_bots = document.get("bots", {})
    if not isinstance(raw_bots, dict):
        raise PolicyError("policy document: bots must be an object")
    for bot_key, entry in raw_bots.items():
        if not isinstance(entry, dict):
            raise PolicyError(f"policy document: bot {bot_key!r} must be an object")
        project = entry.get("project", "")
        if not isinstance(project, str):
            raise PolicyError(f"policy document: bot {bot_key!r}: project must be a string")
        bots[str(bot_key)] = BotPolicy(
            project=project.strip(),
            allow=tuple(_parse_destinations(entry.get("allow"), f"bot {bot_key!r}")),
        )

    projects: dict[str, ProjectPolicy] = {}
    raw_projects = document.get("projects", {})
    if not isinstance(raw_projects, dict):
        raise PolicyError("policy document: projects must be an object")
    for name, entry in raw_projects.items():
        if not isinstance(entry, dict):
            raise PolicyError(f"policy document: project {name!r} must be an object")
        mode = entry.get("mode", MODE_LOG)
        if mode not in (MODE_LOG, MODE_BLOCK):
            raise PolicyError(f"policy document: project {name!r}: mode must be {MODE_LOG!r} or {MODE_BLOCK!r}")
        projects[str(name)] = ProjectPolicy(
            mode=mode,
            allow=tuple(_parse_destinations(entry.get("allow"), f"project {name!r}")),
        )

    return EgressPolicy(bots=bots, projects=projects)


def load_policy_file(path: str) -> EgressPolicy:
    with open(path, "r", encoding="utf-8") as handle:
        return parse_policy_document(json.load(handle))


def fetch_policy(url: str, token: str | None, timeout_sec: float = 10.0) -> EgressPolicy:
    """Reads the document from the board.

    The board is the only place the lists are edited; the proxy never decides
    what belongs in them. A non-200, a timeout or a body that is not the
    expected document all raise — the refresher keeps the last good policy.
    """
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=timeout_sec) as response:  # noqa: S310 - operator-set URL
            body = response.read()
    except urllib.error.HTTPError as exc:
        raise PolicyError(f"policy request to the board failed: HTTP {exc.code}") from exc
    except (urllib.error.URLError, OSError) as exc:
        raise PolicyError(f"policy request to the board failed: {exc}") from exc
    try:
        document = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PolicyError(f"policy response is not JSON: {exc}") from exc
    return parse_policy_document(document)


class PolicyRefresher:
    """Keeps one policy and replaces it on a timer.

    The last good document is kept when a refresh fails: a board restart or a
    blip in the bots' network must not turn every blocking project into "no
    policy", which would either refuse everything or allow everything depending
    on which way the fallback leaned. Failures are reported through
    ``last_error`` and a callback, so the operator sees them in the container log.
    """

    def __init__(
        self,
        *,
        url: str,
        token: str | None,
        interval_sec: float,
        on_error: Any = None,
        timeout_sec: float = 10.0,
    ) -> None:
        self.url = url
        self.token = token
        self.interval_sec = interval_sec
        self.on_error = on_error
        self.timeout_sec = timeout_sec
        self._lock = threading.Lock()
        self._policy = EgressPolicy()
        self._revision = 0
        self.last_error: str | None = None
        self.last_success_at: float | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def policy(self) -> EgressPolicy:
        with self._lock:
            return self._policy

    @property
    def revision(self) -> int:
        with self._lock:
            return self._revision

    def _install(self, policy: EgressPolicy) -> None:
        with self._lock:
            self._policy = policy
            self._revision += 1
            self.last_error = None
            self.last_success_at = time.time()

    def refresh_once(self) -> bool:
        """One attempt. Returns whether a new policy was installed."""
        try:
            policy = fetch_policy(self.url, self.token, timeout_sec=self.timeout_sec)
        except PolicyError as exc:
            self.last_error = str(exc)
            if self.on_error is not None:
                self.on_error(str(exc))
            return False
        self._install(policy)
        return True

    def start(self) -> None:
        def run() -> None:
            while not self._stop.is_set():
                self.refresh_once()
                self._stop.wait(self.interval_sec)

        self._thread = threading.Thread(target=run, name="egress-policy-refresh", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)