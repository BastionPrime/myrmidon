import base64
import unittest

import httpx

from image_mcp.config import Settings
from image_mcp.errors import (
    CODE_DOCUMENT_TOO_LARGE,
    CODE_UPSTREAM_ERROR,
    CodedError,
)
from image_mcp.gateway import Gateway, sniff

PNG = b"\x89PNG\r\n\x1a\n" + b"p" * 64
JPEG = b"\xff\xd8\xff\xe0" + b"j" * 64


def make(handler, **kw) -> Gateway:
    cfg = Settings(gateway_base_url="http://gw.test", models=frozenset({"m"}), **kw)
    return Gateway(cfg, client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))


def answer(**body) -> httpx.Response:
    return httpx.Response(200, json=body, headers={"x-request-id": "req-1"})


class Sniff(unittest.TestCase):
    def test_header_wins_when_image(self):
        self.assertEqual(sniff(b"", "image/webp"), "image/webp")

    def test_bytes_used_when_header_is_generic(self):
        self.assertEqual(sniff(PNG, "application/octet-stream"), "image/png")
        self.assertEqual(sniff(JPEG, None), "image/jpeg")
        self.assertEqual(sniff(b"RIFFxxxx", None), "image/webp")

    def test_unknown(self):
        self.assertEqual(sniff(b"nonsense", "text/plain"), "application/octet-stream")


class GatewayFormats(unittest.IsolatedAsyncioTestCase):
    async def test_b64_json(self):
        def handler(request):
            self.assertEqual(str(request.url), "http://gw.test/v1/images/generations")
            self.assertNotIn("authorization", {k.lower() for k in request.headers})
            return answer(data=[{"b64_json": base64.b64encode(PNG).decode()}])

        images, rid = await make(handler).generate("m", "a cat", "1024x1024", 1)
        self.assertEqual(images[0]["data"], PNG)
        self.assertEqual(images[0]["content_type"], "image/png")
        self.assertEqual(rid, "req-1")

    async def test_url_is_downloaded(self):
        seen = []

        def handler(request):
            if request.url.path == "/v1/images/generations":
                return answer(data=[{"url": "http://gw.test/blobs/a.png"}])
            seen.append(str(request.url))
            return httpx.Response(200, content=JPEG, headers={"content-type": "image/jpeg"})

        images, _ = await make(handler).generate("m", "a cat", "1024x1024", 1)
        self.assertEqual(seen, ["http://gw.test/blobs/a.png"])
        self.assertEqual(images[0]["data"], JPEG)
        self.assertEqual(images[0]["content_type"], "image/jpeg")

    async def test_gateway_key_is_sent_to_the_gateway_only(self):
        headers = []

        def handler(request):
            headers.append(dict(request.headers))
            if request.url.path == "/v1/images/generations":
                return answer(data=[{"url": "http://gw.test/blobs/a.png"}])
            return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})

        gw = make(handler, gateway_token="gw-secret")
        await gw.generate("m", "a cat", "1024x1024", 1)
        self.assertEqual(headers[0].get("authorization"), "Bearer gw-secret")
        self.assertNotIn("authorization", headers[1])  # the download URL is not the gateway contract

    async def test_negative_prompt_forwarded(self):
        bodies = []

        def handler(request):
            bodies.append(request.read())
            return answer(data=[{"b64_json": base64.b64encode(PNG).decode()}])

        await make(handler).generate("m", "a cat", "1024x1024", 1, negative_prompt="blur")
        self.assertIn(b'"negative_prompt"', bodies[0])
        self.assertIn(b'"n":1', bodies[0])

    async def test_upstream_http_error(self):
        def handler(request):
            return httpx.Response(400, json={"error": {"message": "Invalid model name"}})

        with self.assertRaises(CodedError) as cm:
            await make(handler).generate("m", "a cat", "1024x1024", 1)
        self.assertEqual(cm.exception.code, CODE_UPSTREAM_ERROR)
        self.assertIn("HTTP 400", str(cm.exception))

    async def test_upstream_transport_error(self):
        def handler(request):
            raise httpx.ConnectError("boom")

        with self.assertRaises(CodedError) as cm:
            await make(handler).generate("m", "a cat", "1024x1024", 1)
        self.assertEqual(cm.exception.code, CODE_UPSTREAM_ERROR)

    async def test_no_images(self):
        def handler(request):
            return answer(data=[])

        with self.assertRaises(CodedError) as cm:
            await make(handler).generate("m", "a cat", "1024x1024", 1)
        self.assertEqual(cm.exception.code, CODE_UPSTREAM_ERROR)

    async def test_bad_base64(self):
        def handler(request):
            return answer(data=[{"b64_json": "not-base64!!"}])

        with self.assertRaises(CodedError) as cm:
            await make(handler).generate("m", "a cat", "1024x1024", 1)
        self.assertEqual(cm.exception.code, CODE_UPSTREAM_ERROR)

    async def test_entry_without_payload(self):
        def handler(request):
            return answer(data=[{"revised_prompt": "x"}])

        with self.assertRaises(CodedError) as cm:
            await make(handler).generate("m", "a cat", "1024x1024", 1)
        self.assertEqual(cm.exception.code, CODE_UPSTREAM_ERROR)

    async def test_oversize_download_is_refused(self):
        def handler(request):
            if request.url.path == "/v1/images/generations":
                return answer(data=[{"url": "http://gw.test/blobs/big.png"}])
            return httpx.Response(200, content=b"x" * 5000, headers={"content-type": "image/png"})

        with self.assertRaises(CodedError) as cm:
            await make(handler, max_file_bytes=100).generate("m", "a cat", "1024x1024", 1)
        self.assertEqual(cm.exception.code, CODE_DOCUMENT_TOO_LARGE)

    async def test_bad_url_refused(self):
        def handler(request):
            return answer(data=[{"url": "file:///etc/passwd"}])

        with self.assertRaises(CodedError) as cm:
            await make(handler).generate("m", "a cat", "1024x1024", 1)
        self.assertEqual(cm.exception.code, CODE_UPSTREAM_ERROR)


if __name__ == "__main__":
    unittest.main()