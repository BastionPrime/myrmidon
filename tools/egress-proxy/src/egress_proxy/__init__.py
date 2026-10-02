# tools/egress-proxy/src/egress_proxy/__init__.py
"""myrmidon(EGRESS-A, EGRESS-B): the fleet's outbound proxy for container bots.

The bots' docker network has no route out; this service is the only thing on it
that also sits on a network with one. Every request a bot sends outward
therefore passes through here, and here is where it is written down — which
bot, which project, which destination (EGRESS-A, docs/myrmidon/egress.md).

Since EGRESS-B it is also where the lists are applied: with the service in
`enforce` mode, a project whose policy says `block` refuses a destination that is
on neither its own list nor the bot's, and the refusal is recorded with the
result `blocked` (policy.py, server.py). A project that is still in `log` — or
the whole service in `log` mode — records and refuses nothing, which is what
makes the switch back to journaling a one-field change.
"""

__all__ = ["config", "journal", "policy", "server"]