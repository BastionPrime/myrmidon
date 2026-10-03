"""Voice/STT tools: audio_split (ffmpeg segmenting) and stt_transcribe (gateway HTTP).

Covers: spec validation and chunk offsets, the worker's audio_split kind, HTTP
mocks for the transcription gateway (including the "model not registered" case),
allowlist/quotas for the new tools, and the rule that the gateway API key never
appears in a tool answer or a log line.
"""

import asyncio
import hashlib
import json
import logging
import tempfile
import unittest
from pathlib import Path

from starlette.testclient import TestClient

from media_mcp import specs
from media_mcp.backends import Backends, BackendError
from media_mcp.config import Settings, load_bots
from media_mcp.facade import build_app


def make(tmp: Path, **kw):
    (tmp / "bots.json").write_text(json.dumps({"bots": {"bot-a": {"token_sha256": hashlib.sha256(b"ta").hexdigest()}}}))
    cfg = Settings(data_dir=tmp, bots=load_bots(tmp / "bots.json"), spool_min_free_bytes=0, **kw)
    return build_app(cfg)


AUTH = {"Authorization": "Bearer ta"}
INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
    "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}
MCP_HEADERS = {**AUTH, "Accept": "application/json, text/event-stream", "Content-Type": "application/json"}

CALL = {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "", "arguments": {}}}


def call(c, name, args):
    return c.post("/mcp", json={**CALL, "params": {"name": name, "arguments": args}}, headers=MCP_HEADERS)


def result_of(r):
    body = r.json()
    assert body.get("result", {}).get("content"), body
    return json.loads(body["result"]["content"][0]["text"])


class _Chunked:
    """A sync file-like stand-in backed by bytes (for mocked httpx streams)."""

    def __init__(self, data: bytes):
        self._data, self._pos = data, 0

    def read(self, n=-1):
        chunk = self._data[self._pos:] if n is None or n < 0 else self._data[self._pos:self._pos + n]
        self._pos += len(chunk)
        return chunk


class FakeResponse:
    def __init__(self, status_code=200, payload=None, raw=None):
        self.status_code = status_code
        self._payload = payload
        self._raw = raw

    async def aread(self):
        return self._raw or json.dumps(self._payload or {}).encode()

    async def aiter_bytes(self, _n=None):
        data = self._raw or json.dumps(self._payload or {}).encode()
        for i in range(0, len(data), 1024):
            yield data[i:i + 1024]

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class FakeTransport:
    """httpx transport that records every request and answers from a queue."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    async def handle_async_request(self, request):
        from httpx import Request, Response
        self.requests.append(request)
        r = self.responses.pop(0) if self.responses else FakeResponse(500, {"error": "no mock"})
        if isinstance(r, Exception):
            raise r
        if isinstance(r, Response):
            return r
        return r


class AudioSplitSpec(unittest.TestCase):
    def test_argv(self):
        argv = specs.build_audio_split_argv({"input": "meeting.ogg", "chunk_sec": 300}, {"meeting.ogg"})
        self.assertEqual(argv[0], "ffmpeg")
        self.assertIn("-segment_time", argv)
        self.assertEqual(argv[argv.index("-segment_time") + 1], "300.000")
        self.assertEqual(argv[-1], "../out/chunk_%06d.wav")
        # chunks are 16 kHz mono pcm_s16le (what the transcription side expects)
        self.assertEqual(argv[argv.index("-ar") + 1], "16000")
        self.assertEqual(argv[argv.index("-ac") + 1], "1")

    def test_rejects_bad_specs(self):
        for bad in ({"input": "x.wav"},  # no chunk_sec
                    {"input": "x.wav", "chunk_sec": 1},  # below the 5 s floor
                    {"input": "x.wav", "chunk_sec": 3600},  # above the ceiling
                    {"input": "../etc/passwd", "chunk_sec": 60},  # path escape
                    {"input": "other.wav", "chunk_sec": 60}):  # not among the job inputs
            with self.assertRaises(specs.SpecError, msg=bad):
                specs.build_audio_split_argv(bad, {"x.wav"})

    def test_offsets(self):
        self.assertEqual(specs.split_offsets(["chunk_000000.wav"], 300.0), [0])
        self.assertEqual(specs.split_offsets([f"chunk_{i:06d}.wav" for i in range(3)], 300.0), [0, 300000, 600000])
        self.assertEqual(specs.split_offsets([f"chunk_{i:06d}.wav" for i in range(4)], 12.5), [0, 12500, 25000, 37500])
        with self.assertRaises(specs.SpecError):
            specs.split_offsets([], 300.0)


class SttNormalize(unittest.TestCase):
    def test_openai_style_segments(self):
        out = specs.normalize_stt_response({"text": "hello", "segments": [
            {"start": 0.5, "end": 1.5, "text": "hello"},
            {"start": 2.0, "end": 2.4, "speaker": "SPEAKER_01"},
        ]})
        self.assertEqual(out["text"], "hello")
        self.assertEqual(out["segments"][0], {"speaker": None, "startMs": 500, "endMs": 1500})
        self.assertEqual(out["segments"][1], {"speaker": "SPEAKER_01", "startMs": 2000, "endMs": 2400})

    def test_millisecond_fields(self):
        out = specs.normalize_stt_response({"text": "", "segments": [{"startMs": 100, "endMs": 200}]})
        self.assertEqual(out["segments"][0]["startMs"], 100)

    def test_ms_values_over_an_hour_are_seconds(self):
        out = specs.normalize_stt_response({"segments": [{"start": 7200.0, "end": 7201.0}]})
        self.assertEqual(out["segments"][0]["startMs"], 7200000)

    def test_duration_only(self):
        out = specs.normalize_stt_response({"segments": [{"start": 1.0, "duration": 2.5}]})
        self.assertEqual(out["segments"][0], {"speaker": None, "startMs": 1000, "endMs": 3500})

    def test_tolerates_noise(self):
        out = specs.normalize_stt_response({"text": None, "segments": ["junk", {"no": "timing"}, 5]})
        self.assertEqual(out["text"], "")
        self.assertEqual(len(out["segments"]), 1)
        self.assertEqual(out["segments"][0]["startMs"], 0)
        with self.assertRaises(specs.SpecError):
            specs.normalize_stt_response(["not", "a", "dict"])

    def test_model_and_language_validation(self):
        self.assertEqual(specs.check_stt_model("whisper-large-v3"), "whisper-large-v3")
        self.assertEqual(specs.check_stt_language("ru"), "ru")
        self.assertEqual(specs.check_stt_language("en-US"), "en-US")
        for bad in ("Whisper", "whisper large", "x" * 65, "", None, 5, "MODEL/v1"):
            with self.assertRaises(specs.SpecError):
                specs.check_stt_model(bad)
        for bad in ("russian", "ru1", "", None, "en_US"):
            with self.assertRaises(specs.SpecError):
                specs.check_stt_language(bad)


class SttBackend(unittest.TestCase):
    def cfg(self, tmp, key=""):
        return Settings(data_dir=tmp, stt_base_url="http://stt-gateway:8000", stt_api_key=key,
                        stt_max_multipart_bytes=32 * 2**20, stt_max_response_bytes=64 * 2**20)

    def be(self, tmp, transport):
        import httpx
        be = Backends(self.cfg(tmp, key="stt-secret-key-1"))
        be.http = httpx.AsyncClient(transport=httpx.MockTransport(transport) if callable(transport) else transport)
        return be

    def run_coro(self, coro):
        return asyncio.new_event_loop().run_until_complete(coro)

    def test_success_posts_multipart_with_model(self):
        seen = {}

        def transport(request):
            seen["url"] = str(request.url)
            seen["auth"] = request.headers.get("authorization")
            seen["content_type"] = request.headers.get("content-type", "")
            seen["body"] = request.read()
            return httpx.Response(200, json={"text": "hi", "segments": [{"start": 0.0, "end": 1.0, "text": "hi"}]})

        import httpx
        with tempfile.TemporaryDirectory() as t:
            be = self.be(Path(t), transport)
            out = self.run_coro(be.stt_transcribe("meeting.wav", _Chunked(b"RIFFxxxx"), 12, "whisper-large-v3", "ru"))
        self.assertEqual(out["text"], "hi")
        self.assertEqual(seen["url"], "http://stt-gateway:8000/v1/audio/transcriptions")
        self.assertEqual(seen["auth"], "Bearer stt-secret-key-1")
        self.assertIn("multipart/form-data", seen["content_type"])
        self.assertIn(b'name="model"', seen["body"])
        self.assertIn(b"whisper-large-v3", seen["body"])
        self.assertIn(b'name="language"', seen["body"])
        self.assertIn(b"meeting.wav", seen["body"])

    def test_model_not_registered_is_a_clear_error(self):
        import httpx

        def transport(request):
            return httpx.Response(404, json={"error": {"message": "The model `no-such-model` does not exist", "type": "invalid_request_error"}})

        with tempfile.TemporaryDirectory() as t:
            be = self.be(Path(t), transport)
            with self.assertRaises(BackendError) as cm:
                self.run_coro(be.stt_transcribe("m.wav", _Chunked(b"RIFF"), 5, "no-such-model", None))
        self.assertIn("model no-such-model is not registered", str(cm.exception))
        self.assertNotIn("stt-secret-key", str(cm.exception))

    def test_other_http_error_hides_body_and_key(self):
        import httpx

        def transport(request):
            return httpx.Response(500, text="boom stt-secret-key-1 leaked")

        with tempfile.TemporaryDirectory() as t:
            be = self.be(Path(t), transport)
            with self.assertRaises(BackendError) as cm:
                self.run_coro(be.stt_transcribe("m.wav", _Chunked(b"RIFF"), 5, "whisper-large-v3", None))
        self.assertIn("HTTP 500", str(cm.exception))
        self.assertNotIn("stt-secret-key", str(cm.exception))
        self.assertNotIn("boom", str(cm.exception))

    def test_oversize_input_refused_before_the_call(self):
        import httpx
        seen = []

        def transport(request):
            seen.append(request)
            return httpx.Response(200, json={"text": "x"})

        with tempfile.TemporaryDirectory() as t:
            be = self.be(Path(t), transport)
            with self.assertRaises(BackendError) as cm:
                self.run_coro(be.stt_transcribe("m.wav", _Chunked(b"RIFF"), 33 * 2**20, "whisper-large-v3", None))
        self.assertIn("split it first", str(cm.exception))
        self.assertEqual(seen, [])  # never left the facade

    def test_network_failure_is_typed(self):
        import httpx

        def transport(request):
            raise httpx.ConnectError("no route to stt-secret-key host")

        with tempfile.TemporaryDirectory() as t:
            be = self.be(Path(t), transport)
            with self.assertRaises(BackendError) as cm:
                self.run_coro(be.stt_transcribe("m.wav", _Chunked(b"RIFF"), 5, "whisper-large-v3", None))
        self.assertIn("unavailable", str(cm.exception))
        self.assertNotIn("stt-secret-key", str(cm.exception))


class SttTool(unittest.TestCase):
    def setUp(self):
        import httpx
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.responses = []

        def transport(request):
            r = self.responses.pop(0)
            return httpx.Response(r[0], json=r[1])

        self._orig_init = httpx.AsyncClient.__init__
        transport_obj = httpx.MockTransport(transport)

        def patched(client_self, *a, **kw):
            kw["transport"] = transport_obj
            self._orig_init(client_self, *a, **kw)

        httpx.AsyncClient.__init__ = patched
        # the app must be built after the patch: its Backends client inherits the mock transport
        self.client = TestClient(make(Path(self.tmp.name)), base_url="http://media-mcp:8080")
        self._httpx = httpx

    def tearDown(self):
        self._httpx.AsyncClient.__init__ = self._orig_init

    def test_tool_answer_has_text_segments_and_no_key(self):
        self.responses.append((200, {"text": "hello world", "segments": [
            {"start": 0.2, "end": 1.0, "text": "hello", "speaker": "SPEAKER_00"},
            {"start": 1.5, "end": 2.0, "text": "world"},
        ]}))
        with self.client:
            self.client.post("/mcp", json=INIT, headers=MCP_HEADERS)
            out = result_of(call(self.client, "stt_transcribe",
                                 {"input": {"base64": "UklGSFQ=", "name": "meeting.wav"}}))
        self.assertEqual(out["text"], "hello world")
        self.assertEqual(len(out["segments"]), 2)
        self.assertEqual(out["segments"][0]["speaker"], "SPEAKER_00")
        self.assertEqual(out["segments"][0]["startMs"], 200)
        self.assertNotIn("api_key", json.dumps(out).lower())

    def test_start_ms_shifts_segments(self):
        self.responses.append((200, {"text": "chunk two", "segments": [{"start": 1.0, "end": 2.0}]}))
        with self.client:
            self.client.post("/mcp", json=INIT, headers=MCP_HEADERS)
            out = result_of(call(self.client, "stt_transcribe",
                                 {"input": {"base64": "UklGSFQ=", "name": "chunk_000001.wav"}, "start_ms": 300000}))
        self.assertEqual(out["segments"][0]["startMs"], 301000)
        self.assertEqual(out["segments"][0]["endMs"], 302000)

    def test_model_not_registered_clear_error(self):
        self.responses.append((404, {"error": {"message": "model `bogus` does not exist"}}))
        with self.client:
            self.client.post("/mcp", json=INIT, headers=MCP_HEADERS)
            r = call(self.client, "stt_transcribe", {"input": {"base64": "UklGSFQ=", "name": "m.wav"}, "model": "bogus"})
        body = r.json()
        self.assertTrue(body.get("result", {}).get("isError"))
        msg = json.dumps(body)
        self.assertIn("not registered", msg)
        self.assertNotIn("stt", msg.lower().replace("stt_transcribe", "").replace("stt-secret", ""))

    def test_bad_arguments_rejected(self):
        with self.client:
            self.client.post("/mcp", json=INIT, headers=MCP_HEADERS)
            r = call(self.client, "stt_transcribe", {"input": {"base64": "UklGSFQ=", "name": "m.wav"}, "model": "Not A Model"})
            self.assertTrue(r.json().get("result", {}).get("isError"))
            r = call(self.client, "stt_transcribe", {"input": {"base64": "UklGSFQ=", "name": "m.wav"}, "language": "russian"})
            self.assertTrue(r.json().get("result", {}).get("isError"))
            r = call(self.client, "stt_transcribe", {"input": {"base64": "UklGSFQ=", "name": "m.wav"}, "start_ms": -5})
            self.assertTrue(r.json().get("result", {}).get("isError"))


class AudioSplitTool(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def fake_backends(self, f):
        on_submit = getattr(self, "on_submit", None)
        on_status = getattr(self, "on_status", None)

        class FakeBackends:
            async def worker_submit(self, bot, job, kind, spec, limit):
                if on_submit is None:
                    raise AssertionError("no on_submit set for this test")
                return on_submit(bot, job, kind, spec, limit)

            async def worker_status(self, bot, job):
                if on_status is None:
                    raise AssertionError("no on_status set for this test")
                return on_status(job)

            async def aclose(self):
                pass

        f.Backends = lambda cfg: FakeBackends()

    def test_submit_returns_job_id(self):
        submitted = {}

        def on_submit(bot, job, kind, spec, limit):
            submitted.update(kind=kind, spec=spec, limit=limit, job=job)
            return {"job": job, "status": "queued"}

        self.on_submit = on_submit
        import media_mcp.facade as f
        orig = f.Backends
        self.fake_backends(f)
        try:
            client = TestClient(make(Path(self.tmp.name)), base_url="http://media-mcp:8080")
            with client:
                client.post("/mcp", json=INIT, headers=MCP_HEADERS)
                out = result_of(call(client, "audio_split",
                                     {"input": {"base64": "UklGSFQ=", "name": "meeting.ogg"}, "chunk_sec": 60}))
        finally:
            f.Backends = orig
        self.assertEqual(submitted["kind"], "audio_split")
        self.assertEqual(submitted["spec"], {"input": "meeting.ogg", "chunk_sec": 60})
        self.assertEqual(out["status"], "queued")
        self.assertEqual(out["chunk_sec"], 60)
        # the job's input hard link exists and the job dir is visible to active_jobs
        root = Path(self.tmp.name) / "bots" / "bot-a" / "jobs" / submitted["job"]
        self.assertTrue((root / "in" / "meeting.ogg").exists())
        self.assertEqual(json.loads((root / "job.json").read_text()).get("status"), "queued")

    def test_bad_chunk_sec_rejected(self):
        client = TestClient(make(Path(self.tmp.name)), base_url="http://media-mcp:8080")
        with client:
            client.post("/mcp", json=INIT, headers=MCP_HEADERS)
            r = call(client, "audio_split", {"input": {"base64": "UklGSFQ=", "name": "m.ogg"}, "chunk_sec": 1})
            self.assertTrue(r.json().get("result", {}).get("isError"))

    def test_active_jobs_limit(self):
        # queue up to the limit, then the next call must be refused
        submitted = []

        def on_submit(bot, job, kind, spec, limit):
            submitted.append(job)
            return {"job": job, "status": "queued"}

        self.on_submit = on_submit
        import media_mcp.facade as f
        orig = f.Backends
        self.fake_backends(f)
        r = None
        try:
            client = TestClient(make(Path(self.tmp.name)), base_url="http://media-mcp:8080")
            with client:
                client.post("/mcp", json=INIT, headers=MCP_HEADERS)
                ok = 0
                for _ in range(5):
                    r = call(client, "audio_split",
                             {"input": {"base64": "UklGSFQ=", "name": "m.ogg"}, "chunk_sec": 300})
                    if r.json().get("result", {}).get("isError"):
                        break
                    ok += 1
                self.assertEqual(ok, 3)  # default max_active_jobs_per_bot
                err = json.dumps(r.json())
                self.assertIn("too many active jobs", err)
        finally:
            f.Backends = orig


class JobStatusOffsets(unittest.TestCase):
    def test_audio_split_outputs_carry_startms(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)

        job = "a" * 32
        d = root / "bots" / "bot-a" / "jobs" / job
        (d / "in").mkdir(parents=True)
        (d / "out").mkdir()
        for i in range(3):
            (d / "out" / f"chunk_{i:06d}.wav").write_bytes(b"RIFF" + b"\0" * 10)

        def on_status(j):
            return {"job": j, "status": "done", "kind": "audio_split", "chunk_sec": 300.0,
                    "outputs": ["chunk_000000.wav", "chunk_000001.wav", "chunk_000002.wav"]}

        import media_mcp.facade as f
        orig = f.Backends

        class FakeBackends:
            async def worker_status(self, bot, job):
                return on_status(job)

            async def aclose(self):
                pass

        f.Backends = lambda cfg: FakeBackends()
        try:
            client = TestClient(make(root), base_url="http://media-mcp:8080")
            with client:
                client.post("/mcp", json=INIT, headers=MCP_HEADERS)
                out = result_of(call(client, "job_status", {"job_id": job}))
        finally:
            f.Backends = orig
        self.assertEqual(out["chunk_sec"], 300.0)
        self.assertEqual(out["startMs_step"], 300000)
        self.assertEqual([o["startMs"] for o in out["outputs"]], [0, 300000, 600000])
        self.assertEqual(len(out["outputs"]), 3)


class AllowlistGuard(unittest.TestCase):
    """The guard: a bot whose allowlist does not include the new tools gets a refusal."""

    def make_limited(self, tmp: Path):
        (tmp / "bots.json").write_text(json.dumps({"bots": {
            "bot-a": {"token_sha256": hashlib.sha256(b"ta").hexdigest(),
                      "tools": ["file_put", "file_get", "file_list", "file_delete", "media_probe"]}}}))
        cfg = Settings(data_dir=tmp, bots=load_bots(tmp / "bots.json"), spool_min_free_bytes=0)
        return build_app(cfg)

    def test_tool_not_in_allowlist_is_refused(self):
        with tempfile.TemporaryDirectory() as t:
            client = TestClient(self.make_limited(Path(t)), base_url="http://media-mcp:8080")
            with client:
                client.post("/mcp", json=INIT, headers=MCP_HEADERS)
                for tool in ("audio_split", "stt_transcribe"):
                    r = call(client, tool, {"input": {"base64": "UklGSFQ=", "name": "m.wav"}})
                    body = r.json()
                    self.assertTrue(body.get("result", {}).get("isError"), tool)
                    self.assertIn("not enabled for this bot", json.dumps(body))

    def test_allowlisted_bot_gets_the_tool(self):
        # control: the same shape with the tool allowlisted must pass the gate
        class FakeBackends:
            async def stt_transcribe(self, *a, **kw):
                return {"text": "ok", "segments": []}

            async def aclose(self):
                pass

        import media_mcp.facade as f
        orig = f.Backends
        f.Backends = lambda cfg: FakeBackends()
        try:
            with tempfile.TemporaryDirectory() as t:
                (Path(t) / "bots.json").write_text(json.dumps({"bots": {
                    "bot-a": {"token_sha256": hashlib.sha256(b"ta").hexdigest(),
                              "tools": ["stt_transcribe", "file_put"]}}}))
                cfg = Settings(data_dir=Path(t), bots=load_bots(Path(t) / "bots.json"), spool_min_free_bytes=0)
                client = TestClient(build_app(cfg), base_url="http://media-mcp:8080")
                with client:
                    client.post("/mcp", json=INIT, headers=MCP_HEADERS)
                    out = result_of(call(client, "stt_transcribe", {"input": {"base64": "UklGSFQ=", "name": "m.wav"}}))
        finally:
            f.Backends = orig
        self.assertEqual(out["text"], "ok")


class KeyHygiene(unittest.TestCase):
    KEY = "stt-secret-key-1"

    def test_key_never_in_answers_or_logs(self):
        import httpx
        key_holder = {}

        def transport(request):
            if request.url.path.endswith("/transcriptions"):
                key_holder["header"] = request.headers.get("authorization", "")
                # a hostile gateway that echoes the key back in the body
                return httpx.Response(200, json={"text": "leaked from a hostile gateway"})
            return httpx.Response(200, json={})

        captured = []

        class Handler(logging.Handler):
            def emit(self, record):
                captured.append(record.getMessage())

        log = logging.getLogger("media_mcp.backends")
        handler = Handler()
        log.addHandler(handler)
        log.setLevel(logging.DEBUG)
        try:
            with tempfile.TemporaryDirectory() as t:
                cfg = Settings(data_dir=Path(t), stt_base_url="http://stt-gateway:8000",
                               stt_api_key=self.KEY, stt_max_multipart_bytes=32 * 2**20)
                be = Backends(cfg)
                be.http = httpx.AsyncClient(transport=httpx.MockTransport(transport))
                out = asyncio.new_event_loop().run_until_complete(
                    be.stt_transcribe("m.wav", _Chunked(b"RIFF"), 5, "whisper-large-v3", None))
        finally:
            log.removeHandler(handler)
        # the key travels in the header (that is the contract: the gateway must see it)
        self.assertEqual(key_holder.get("header"), f"Bearer {self.KEY}")
        # but it never surfaces in normalized answers or in any emitted log line
        self.assertNotIn(self.KEY, json.dumps(out))
        for line in captured:
            self.assertNotIn(self.KEY, line)
        # and the normalized answer keeps text but no headers
        self.assertIn("leaked", out["text"])
        self.assertNotIn("Bearer", json.dumps(out))


if __name__ == "__main__":
    unittest.main()
