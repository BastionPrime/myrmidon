#!/usr/bin/env python3
"""Stub OpenAI-compatible model provider for the tracing contract check.

One POST /v1/chat/completions answers with a fixed chat completion, so the
check exercises the real LITELLM -> provider HTTP path without contacting any
provider and without a provider key. Stdlib only.

It runs as a service inside the contract compose network and publishes no port:
the completion has to travel through the gateway, never around it.
"""
import http.server
import json
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):  # keep the run log readable
        pass

    def _send(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # readiness probe
        self._send({"status": "ok"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        if length:
            self.rfile.read(length)
        self._send({
            "id": "chatcmpl-tracing-contract",
            "object": "chat.completion",
            "created": 1,
            "model": "tracing-contract-stub",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "tracing contract ok"},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
        })


http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()