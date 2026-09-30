# tools/egress-proxy/src/egress_proxy/__init__.py
"""myrmidon(EGRESS-A): the fleet's outbound proxy for container bots, log-only.

The bots' docker network has no route out; this service is the only thing on it
that also sits on a network with one. Every request a bot sends outward
therefore passes through here, and here is where it is written down — which
bot, which project, which destination — with nothing refused (EGRESS-A,
docs/myrmidon/egress.md). A destination list that refuses is EGRESS-B.
"""

__all__ = ["config", "journal", "server"]