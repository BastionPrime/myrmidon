# tools/egress-proxy/tests/test_config.py
"""myrmidon(EGRESS-A, EGRESS-B): a setting this image cannot honour stops it, loudly.

Log-only is the safe default of the service; `enforce` adds the per-project
decision of EGRESS-B, and a mode the image does not implement must get a refusal
to start, not a proxy that quietly keeps letting everything through and looks
like it is enforcing something.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest

from egress_proxy.config import (
    BOTS_FILE_ENV,
    ConfigError,
    MODE_ENV,
    POLICY_FILE_ENV,
    POLICY_URL_ENV,
    load_bots,
    load_config,
)


class LoadConfigTest(unittest.TestCase):
    def test_defaults_to_log_without_settings(self) -> None:
        config = load_config({})
        self.assertEqual(config.mode, "log")
        self.assertEqual(config.port, 3128)
        self.assertEqual(config.bind, "0.0.0.0")
        self.assertEqual(config.connect_timeout_sec, 30)
        self.assertEqual(config.bots, {})
        self.assertEqual(config.policy_url, "")
        self.assertEqual(config.policy_file, "")
        self.assertEqual(config.policy_refresh_sec, 30)

    def test_refuses_a_mode_it_does_not_implement(self) -> None:
        for mode in ("block", "off", "deny"):
            with self.subTest(mode=mode):
                with self.assertRaises(ConfigError):
                    load_config({MODE_ENV: mode})

    def test_enforce_needs_a_policy_source(self) -> None:
        with self.assertRaises(ConfigError) as raised:
            load_config({MODE_ENV: "enforce"})
        self.assertIn(POLICY_URL_ENV, str(raised.exception))
        self.assertEqual(
            load_config({MODE_ENV: "enforce", POLICY_URL_ENV: "http://board.example.com/policy"}).mode,
            "enforce",
        )
        self.assertEqual(
            load_config({MODE_ENV: "enforce", POLICY_FILE_ENV: "/etc/egress-policy.json"}).policy_file,
            "/etc/egress-policy.json",
        )

    def test_reads_the_policy_settings(self) -> None:
        config = load_config(
            {
                POLICY_URL_ENV: " http://board.example.com/api/myrmidon/bot-egress/policy ",
                "EGRESS_PROXY_POLICY_TOKEN": " a-secret ",
                "EGRESS_PROXY_POLICY_REFRESH_SEC": "15",
            }
        )
        self.assertEqual(config.policy_url, "http://board.example.com/api/myrmidon/bot-egress/policy")
        self.assertEqual(config.policy_token, "a-secret")
        self.assertEqual(config.policy_refresh_sec, 15)

    def test_reads_the_port_and_the_connect_timeout(self) -> None:
        config = load_config({"EGRESS_PROXY_PORT": "8080", "EGRESS_PROXY_CONNECT_TIMEOUT_SEC": "5"})
        self.assertEqual(config.port, 8080)
        self.assertEqual(config.connect_timeout_sec, 5)
        for bad in ("not-a-number", "0", "70000"):
            with self.subTest(bad=bad):
                with self.assertRaises(ConfigError):
                    load_config({"EGRESS_PROXY_PORT": bad})


class LoadBotsTest(unittest.TestCase):
    def _write(self, document: object) -> str:
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(document, handle)
        handle.close()
        self.addCleanup(os.unlink, handle.name)
        return handle.name

    def test_reads_bot_keys_and_their_projects(self) -> None:
        path = self._write({"bots": {"agent-a": {"project": "life"}, "agent-b": {"project": "work"}}})
        bots = load_bots(path)
        self.assertEqual(bots["agent-a"].project, "life")
        self.assertEqual(bots["agent-b"].project, "work")

    def test_a_bot_without_a_project_is_allowed(self) -> None:
        # The map is attribution, not access: an entry without a project only
        # means the journal names no project for that bot.
        path = self._write({"bots": {"agent-a": {}}})
        self.assertEqual(load_bots(path)["agent-a"].project, "")

    def test_refuses_a_missing_file_a_bad_document_and_a_bad_entry(self) -> None:
        with self.assertRaises(ConfigError):
            load_bots("/nonexistent/bots.json")
        with self.assertRaises(ConfigError):
            load_bots(self._write(["not", "an", "object"]))
        with self.assertRaises(ConfigError):
            load_bots(self._write({"bots": {"agent-a": {"project": 1}}}))
        with self.assertRaises(ConfigError):
            load_bots(self._write({"bots": "not-an-object"}))

    def test_no_path_means_no_map(self) -> None:
        self.assertEqual(load_bots(None), {})
        self.assertEqual(load_bots(""), {})

    def test_the_variable_names_a_path(self) -> None:
        path = self._write({"bots": {"agent-a": {"project": "life"}}})
        self.assertEqual(load_config({BOTS_FILE_ENV: path}).bots["agent-a"].project, "life")


if __name__ == "__main__":
    unittest.main()