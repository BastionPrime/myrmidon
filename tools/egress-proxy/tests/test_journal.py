# tools/egress-proxy/tests/test_journal.py
"""myrmidon(EGRESS-A): the journal line, and what it must never contain."""

from __future__ import annotations

import base64
import io
import json
import unittest

from egress_proxy.config import BotEntry
from egress_proxy.journal import (
    DestinationJournal,
    UNKNOWN_BOT,
    parse_proxy_user,
    project_for,
)


def basic(user: str, password: str = "egress") -> str:
    return "Basic " + base64.b64encode(f"{user}:{password}".encode("utf-8")).decode("ascii")


class ParseProxyUserTest(unittest.TestCase):
    def test_reads_the_bot_key_out_of_a_basic_header(self) -> None:
        self.assertEqual(parse_proxy_user(basic("agent-a")), "agent-a")

    def test_accepts_the_scheme_in_any_case(self) -> None:
        self.assertEqual(parse_proxy_user("basic " + basic("agent-a")[len("Basic ") :]), "agent-a")

    def test_falls_back_to_unknown_instead_of_refusing(self) -> None:
        # Log-only mode never refuses a request: a bot that missed its proxy URL
        # must still be served, and must still show up in the inventory.
        for header in (None, "", "Bearer abc", "Basic", "Basic !!!not-base64!!!", basic("")):
            with self.subTest(header=header):
                self.assertEqual(parse_proxy_user(header), UNKNOWN_BOT)

    def test_never_returns_the_password(self) -> None:
        self.assertEqual(parse_proxy_user(basic("agent-a", "s3cret")), "agent-a")


class ProjectForTest(unittest.TestCase):
    def test_names_the_project_of_a_known_bot_and_nothing_for_the_rest(self) -> None:
        bots = {"agent-a": BotEntry(bot_key="agent-a", project="life")}
        self.assertEqual(project_for(bots, "agent-a"), "life")
        self.assertEqual(project_for(bots, "agent-b"), "")
        self.assertEqual(project_for(bots, UNKNOWN_BOT), "")


class DestinationJournalTest(unittest.TestCase):
    def test_writes_one_json_line_with_the_bot_and_its_project(self) -> None:
        stream = io.StringIO()
        journal = DestinationJournal(stream, {"agent-a": BotEntry(bot_key="agent-a", project="life")})
        record = journal.record(bot="agent-a", method="CONNECT", host="api.example.com", port=443, scheme="https", result="ok")
        journal.emit(record)
        stream.seek(0)
        line = json.loads(stream.readline())
        self.assertEqual(line["bot"], "agent-a")
        self.assertEqual(line["project"], "life")
        self.assertEqual(line["method"], "CONNECT")
        self.assertEqual(line["destination"], "api.example.com")
        self.assertEqual(line["port"], 443)
        self.assertEqual(line["scheme"], "https")
        self.assertEqual(line["result"], "ok")
        self.assertRegex(line["ts"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        self.assertEqual(journal.count, 1)

    def test_a_line_carries_no_credential_and_no_request_body(self) -> None:
        stream = io.StringIO()
        journal = DestinationJournal(stream)
        journal.emit(journal.record(bot="agent-a", method="POST", host="api.example.com", port=80, scheme="http", result="ok"))
        stream.seek(0)
        written = stream.read()
        self.assertNotIn("Basic", written)
        self.assertNotIn("Authorization", written)

    def test_a_closed_stream_does_not_take_the_proxy_down(self) -> None:
        stream = io.StringIO()
        stream.close()
        journal = DestinationJournal(stream)
        journal.emit(journal.record(bot="agent-a", method="GET", host="api.example.com", port=80, scheme="http", result="ok"))
        self.assertEqual(journal.count, 0)


if __name__ == "__main__":
    unittest.main()