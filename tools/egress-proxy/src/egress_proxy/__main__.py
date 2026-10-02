# tools/egress-proxy/src/egress_proxy/__main__.py
"""`python -m egress_proxy serve` — the container's entry point.

A setting that cannot be honoured (an unknown mode, a malformed bots file) stops
the process with a non-zero code and one line naming the variable: a proxy that
starts with a mode it does not implement would leave the fleet's egress
unrecorded and unnoticed.
"""

from __future__ import annotations

import sys

from .config import ConfigError, load_config
from .server import serve


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else "serve"
    if command != "serve":
        print(f"egress-proxy: FATAL: unknown command {command!r} (only 'serve' is implemented)", file=sys.stderr, flush=True)
        return 2
    try:
        config = load_config()
    except ConfigError as exc:
        print(f"egress-proxy: FATAL: {exc}", file=sys.stderr, flush=True)
        return 1
    serve(config)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))