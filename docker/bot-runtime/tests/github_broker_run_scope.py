# myrmidon(G1): build-time regression for 09-run-scoped-github-broker.patch
# (CONTAINER-GITHUB-WRITE). The import smoke proves the patched modules import;
# this proves the behaviour the board depends on: a run's github_broker body
# field binds exactly for that run's contextvar context, is inherited by the
# terminal child env bridge, and never lands in the process env that
# concurrent runs share.

import os
import sys

sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else "/opt/hermes-src")

from tools.github_broker_context import (
    github_broker_bound,
    github_broker_env,
    set_github_broker_vars,
)
from tools.environments.local import _inject_session_context_env


def main() -> None:
    broker = {"broker_url": "http://paperclip-server-1:3100", "capability": "cap-token-123"}

    # Unbound: no broker vars leak anywhere.
    env: dict = {"FOO": "1"}
    _inject_session_context_env(env)
    assert "PAPERCLIP_GITHUB_BROKER_URL" not in env
    assert github_broker_env() == {}

    # Bound: the run's children see exactly the broker pair.
    marker, reset = set_github_broker_vars(broker)
    try:
        assert github_broker_env() == {
            "PAPERCLIP_GITHUB_BROKER_URL": broker["broker_url"],
            "PAPERCLIP_GITHUB_BROKER_TOKEN": broker["capability"],
        }
        env = {"FOO": "1", "GH_TOKEN": "dead-card-token", "GITHUB_TOKEN": "dead-card-token"}
        _inject_session_context_env(env)
        assert env["PAPERCLIP_GITHUB_BROKER_URL"] == broker["broker_url"]
        assert env["PAPERCLIP_GITHUB_BROKER_TOKEN"] == broker["capability"]
        # A broker capability means managed credentials are in charge: an
        # inherited static card token (dead or stale) must be blanked so it
        # cannot shadow the broker-acquired credential.
        assert "GH_TOKEN" not in env
        assert "GITHUB_TOKEN" not in env
        # The bridge must not touch the process env concurrent runs share.
        assert "PAPERCLIP_GITHUB_BROKER_URL" not in os.environ
    finally:
        reset(marker)
    assert github_broker_env() == {}
    env = {"FOO": "1"}
    _inject_session_context_env(env)
    assert "PAPERCLIP_GITHUB_BROKER_URL" not in env

    # Malformed payloads bind nothing, never a half-bound pair. (The API
    # server validates the body field is a str->str dict before calling, so
    # only mapping shapes are exercised here.)
    for bad in ({}, {"broker_url": "http://x"}, {"capability": "c"}, {"broker_url": "", "capability": "c"}):
        _, reset_bad = set_github_broker_vars(bad)
        assert github_broker_env() == {}
        reset_bad()
    assert github_broker_bound() is False

    print("github-broker run-scope regression: ok")


if __name__ == "__main__":
    main()
