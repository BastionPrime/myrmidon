# tools/egress-proxy/tests/test_policy.py
"""myrmidon(EGRESS-B): the lists and the decision, without a socket.

The decision is the whole point of item 5: a project in `block` mode must refuse
a destination that is on neither its list nor the bot's, and every other
combination must keep recording. A document this service cannot read must not
become "nothing is allowed" (which would break a working project) or "everything
is allowed" (which would quietly undo a blocking one) — so the parser is checked
against the malformed shapes as much as the good one.
"""

from __future__ import annotations

import tempfile
import unittest
from unittest import mock

from egress_proxy.policy import (
    BotPolicy,
    Destination,
    EgressPolicy,
    PolicyError,
    PolicyRefresher,
    ProjectPolicy,
    SUPPORTED_DOCUMENT_VERSION,
    fetch_policy,
    load_policy_file,
    parse_destination,
    parse_policy_document,
)


def document() -> dict:
    return {
        "version": SUPPORTED_DOCUMENT_VERSION,
        "bots": {
            "agent-a": {"project": "example-project", "allow": ["extra.example.com:8443"]},
            "agent-b": {"project": "other-project", "allow": []},
        },
        "projects": {
            "example-project": {"mode": "block", "allow": ["api.example.com"]},
            "other-project": {"mode": "log", "allow": []},
        },
    }


class ParseDestinationTest(unittest.TestCase):
    def test_reads_a_host_and_a_host_with_a_port(self) -> None:
        self.assertEqual(parse_destination("api.example.com"), Destination(host="api.example.com", port=None))
        self.assertEqual(parse_destination(" api.example.com:443 "), Destination(host="api.example.com", port=443))
        self.assertEqual(parse_destination("api.example.com:*"), Destination(host="api.example.com", port=None))

    def test_refuses_anything_that_is_not_a_destination(self) -> None:
        for bad in ("", "*.example.com", "https://api.example.com", "api.example.com/path", "a:b:c", "api.example.com:0", "api.example.com:70000", "with space"):
            with self.subTest(bad=bad):
                self.assertIsNone(parse_destination(bad))


class ParseDocumentTest(unittest.TestCase):
    def test_reads_bots_and_projects(self) -> None:
        policy = parse_policy_document(document())
        self.assertEqual(policy.project_of("agent-a"), "example-project")
        self.assertEqual(policy.project_of("nobody"), "")
        self.assertEqual(policy.projects["example-project"].mode, "block")
        self.assertEqual(policy.projects["example-project"].allow, (Destination("api.example.com", None),))

    def test_refuses_another_version(self) -> None:
        with self.assertRaises(PolicyError) as raised:
            parse_policy_document({"version": 99, "bots": {}, "projects": {}})
        self.assertIn("version", str(raised.exception))

    def test_refuses_a_document_it_cannot_read(self) -> None:
        for bad in (
            [],
            {"version": SUPPORTED_DOCUMENT_VERSION, "bots": [], "projects": {}},
            {"version": SUPPORTED_DOCUMENT_VERSION, "bots": {}, "projects": []},
            {"version": SUPPORTED_DOCUMENT_VERSION, "bots": {"agent-a": []}, "projects": {}},
            {"version": SUPPORTED_DOCUMENT_VERSION, "bots": {}, "projects": {"p": {"mode": "refuse"}}},
            {"version": SUPPORTED_DOCUMENT_VERSION, "bots": {}, "projects": {"p": {"mode": "block", "allow": "api.example.com"}}},
            {"version": SUPPORTED_DOCUMENT_VERSION, "bots": {}, "projects": {"p": {"mode": "block", "allow": ["*.example.com"]}}},
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(PolicyError):
                    parse_policy_document(bad)

    def test_missing_lists_are_empty_lists(self) -> None:
        policy = parse_policy_document({"version": SUPPORTED_DOCUMENT_VERSION})
        self.assertEqual(policy.bots, {})
        self.assertEqual(policy.projects, {})

    def test_reads_the_same_shape_from_a_file(self) -> None:
        import json

        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(document(), handle)
        handle.close()
        self.addCleanup(lambda: __import__("os").unlink(handle.name))
        policy = load_policy_file(handle.name)
        self.assertEqual(policy.project_of("agent-a"), "example-project")


class DecisionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.policy = parse_policy_document(document())

    def test_a_blocking_project_refuses_a_destination_on_no_list(self) -> None:
        self.assertTrue(self.policy.decides_to_block("agent-a", "unknown.example.com", 443))

    def test_a_blocking_project_allows_its_own_list_and_the_bot_s_own_list(self) -> None:
        self.assertFalse(self.policy.decides_to_block("agent-a", "api.example.com", 443))
        self.assertFalse(self.policy.decides_to_block("agent-a", "extra.example.com", 8443))

    def test_a_port_on_the_list_does_not_open_the_other_ports(self) -> None:
        # `extra.example.com:8443` is a destination, not a host: the same host on
        # another port is not allowed, which is the point of naming a port.
        self.assertTrue(self.policy.decides_to_block("agent-a", "extra.example.com", 443))

    def test_a_bare_host_allows_every_port_on_it(self) -> None:
        policy = EgressPolicy(
            bots={"agent-a": BotPolicy(project="example-project")},
            projects={"example-project": ProjectPolicy(mode="block", allow=(Destination("api.example.com", None),))},
        )
        self.assertFalse(policy.decides_to_block("agent-a", "api.example.com", 8443))

    def test_a_project_in_log_mode_never_refuses(self) -> None:
        self.assertFalse(self.policy.decides_to_block("agent-b", "unknown.example.com", 443))

    def test_a_bot_without_a_policy_is_never_refused(self) -> None:
        # An unknown bot has no project, so no project mode applies to it: it is
        # recorded as before, which is what keeps the observation honest.
        self.assertFalse(self.policy.decides_to_block("agent-z", "unknown.example.com", 443))


class RefresherTest(unittest.TestCase):
    def test_keeps_the_last_good_document_when_a_refresh_fails(self) -> None:
        errors: list[str] = []
        refresher = PolicyRefresher(url="http://board.example.com/policy", token=None, interval_sec=9999, on_error=errors.append)
        # A first good document, then a failing fetch: the policy must survive.
        with mock.patch("egress_proxy.policy.fetch_policy", return_value=parse_policy_document(document())):
            self.assertTrue(refresher.refresh_once())
        self.assertEqual(refresher.policy.project_of("agent-a"), "example-project")
        self.assertIsNone(refresher.last_error)
        with mock.patch("egress_proxy.policy.fetch_policy", side_effect=PolicyError("board is down")):
            self.assertFalse(refresher.refresh_once())
        self.assertEqual(refresher.policy.project_of("agent-a"), "example-project")
        self.assertEqual(refresher.last_error, "board is down")
        self.assertEqual(errors, ["board is down"])

    def test_fetch_refuses_a_non_json_body(self) -> None:
        fake = mock.MagicMock()
        fake.read.return_value = b"<html>not json</html>"
        fake.__enter__ = mock.MagicMock(return_value=fake)
        fake.__exit__ = mock.MagicMock(return_value=False)
        with mock.patch("urllib.request.urlopen", return_value=fake):
            with self.assertRaises(PolicyError):
                fetch_policy("http://board.example.com/policy", None)


if __name__ == "__main__":
    unittest.main()