"""The MCP facade: typed tools, per-bot auth, quotas; talks to internal backends only."""

from __future__ import annotations

import asyncio
import base64
import binascii
import functools
import json
import os
import re
import shutil
import stat
import time
import uuid
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import BaseModel, Field
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Route

from . import specs
from .auth import AuthMiddleware, Authenticator, current_bot
from .backends import BackendError, Backends
from .config import Settings, load_settings
from .store import Store, StoreError, safe_name

OFFICE_EXT = {"doc", "docx", "odt", "rtf", "xls", "xlsx", "ods", "csv", "ppt", "pptx", "odp", "txt", "wpd", "pages", "key", "numbers"}
JOB_IDS = __import__("re").compile(r"^[0-9a-f]{32}$")


class FileInput(BaseModel):
    """A file passed to a tool: an id returned earlier, or the bytes inline (small files)."""

    file_id: str | None = Field(None, description="id from file_put / file_list / a previous result")
    base64: str | None = Field(None, description="file bytes, base64; only for small files (see limits in server instructions)")
    name: str | None = Field(None, description="file name with extension (required with base64)")


INSTRUCTIONS = (
    "Shared media and office tools. Files live in your own private store (48 h, quota per bot). "
    "Small files: pass base64 inline. Large files (video): upload with "
    "PUT /v1/files?name=<name> (body = raw bytes) and download with GET /v1/files/<id> on the same address "
    "(same authentication), then use the returned file_id. "
    "Tools: file_put/file_get/file_list/file_delete, media_probe, audio_loudness, ffmpeg_submit + job_status/job_cancel, "
    "image_transform, pdf_to_images, office_to_pdf, html_to_pdf, extract_text. "
    "Arbitrary shell or node scripts are not available here."
)


def build_app(cfg: Settings | None = None) -> Any:
    cfg = cfg or load_settings()
    store = Store(cfg.data_dir, cfg.bot_quota_bytes, cfg.max_file_bytes, cfg.file_ttl_hours,
                  spool_max_bytes=cfg.spool_max_bytes, spool_min_free_bytes=cfg.spool_min_free_bytes)
    be = Backends(cfg)
    auth = Authenticator(cfg)
    locks: dict[str, asyncio.Lock] = {}  # per job, dropped when the job is registered
    bot_locks: dict[str, asyncio.Lock] = {}  # per bot (a bounded set): job admission is serial

    mcp = FastMCP(
        "media-tools", instructions=INSTRUCTIONS, stateless_http=True, json_response=True,
        host=cfg.listen_host, port=cfg.listen_port, max_request_body_size=cfg.max_request_bytes,
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=True,
                                                     allowed_hosts=list(cfg.allowed_hosts), allowed_origins=[]),
    )

    # ---- helpers ------------------------------------------------------------
    def me():
        bot = current_bot.get()
        if bot is None:
            raise ToolError("unauthorized")
        return bot

    def gate(tool: str):
        bot = me()
        if bot.tools is not None and tool not in bot.tools:
            raise ToolError(f"tool {tool} is not enabled for this bot")
        return bot

    def quota(bot) -> int:
        return bot.quota_bytes or cfg.bot_quota_bytes

    def public(meta: dict) -> dict:
        return {k: meta[k] for k in ("id", "name", "size", "sha256", "kind", "created")} | {"download": f"/v1/files/{meta['id']}"}

    def with_inline(meta: dict, inline: bool) -> dict:
        out = public(meta)
        if inline:
            if meta["size"] > cfg.max_inline_result_bytes:
                out["inline_skipped"] = f"larger than {cfg.max_inline_result_bytes} bytes, use download"
            else:
                out["base64"] = base64.b64encode(store.blob(me().key, meta["id"]).read_bytes()).decode()
        return out

    async def resolve(bot, ref: FileInput) -> tuple[dict, bool]:
        """-> (meta, temporary). Inline bytes become a temporary stored file."""
        try:
            if ref.file_id:
                return await asyncio.to_thread(store.meta, bot.key, ref.file_id), False
            if ref.base64:
                if not ref.name:
                    raise ToolError("name (with extension) is required with base64")
                try:
                    data = base64.b64decode(ref.base64, validate=True)
                except (binascii.Error, ValueError):
                    raise ToolError("base64 is not valid") from None
                meta = await asyncio.to_thread(store.put_bytes, bot.key, data, ref.name, "inline", quota(bot))
                return meta, True
        except StoreError as e:
            raise ToolError(str(e)) from None
        raise ToolError("give file_id or base64+name")

    async def drop(bot, temps: list[dict]) -> None:
        for m in temps:
            try:
                await asyncio.to_thread(store.delete, bot.key, m["id"])
            except StoreError:
                pass

    def active_jobs(bot) -> int:
        n = 0
        for st in (store.bot_dir(bot.key) / "jobs").glob("*/job.json"):
            try:
                if json.loads(st.read_text()).get("status") in ("queued", "running"):
                    n += 1
            except (OSError, ValueError):
                pass
        return n

    def prepare_job(bot, files: dict[str, dict], queued: bool = False) -> tuple[str, Path]:
        job = uuid.uuid4().hex
        d = store.bot_dir(bot.key) / "jobs" / job
        try:
            (d / "in").mkdir(parents=True)
            (d / "out").mkdir()
            for alias, meta in files.items():
                src, dst = store.blob(bot.key, meta["id"]), d / "in" / alias
                try:
                    os.link(src, dst)
                except OSError:
                    shutil.copyfile(src, dst)
            if queued:  # visible to active_jobs at once, before the worker has seen the job
                (d / "job.json").write_text(json.dumps({"status": "queued"}))
        except BaseException:
            shutil.rmtree(d, ignore_errors=True)
            raise
        return job, d

    def _register(bot, d: Path, st: dict) -> list[dict]:
        """Move the job's outputs into the bot's store. Runs in a thread, under the bot's store lock."""
        metas: list[dict] = []
        with store.lock(bot.key):
            try:
                names = st.get("outputs", [])
                if not isinstance(names, list):
                    raise StoreError("bad job result")
                for name in names:
                    if not isinstance(name, str) or not specs.OUT_NAME_RE.match(name) or ".." in name:
                        raise StoreError("the worker reported a bad output name")
                    try:
                        mode = os.lstat(d / "out" / name)
                    except OSError:
                        raise StoreError("a job output is missing") from None
                    if not stat.S_ISREG(mode.st_mode):
                        raise StoreError("a job output is not a regular file")
                    if mode.st_size > cfg.max_file_bytes:
                        raise StoreError(f"output larger than {cfg.max_file_bytes // 2**20} MiB")
                    metas.append(store.put_path(bot.key, d / "out" / name, name, "result"))
                if store.used_bytes(bot.key) > quota(bot):
                    raise StoreError("bot storage quota exceeded: delete files with file_delete")
            except StoreError as e:
                for m in metas:
                    store.delete(bot.key, m["id"])
                # Refused for good: free the job's bytes now and remember why.
                for sub in ("in", "out"):
                    shutil.rmtree(d / sub, ignore_errors=True)
                (d / "refused.json").write_text(json.dumps(str(e)))
                raise
            (d / "registered.json").write_text(json.dumps(metas))
            for sub in ("in", "out"):
                shutil.rmtree(d / sub, ignore_errors=True)
        return metas

    async def register_outputs(bot, job: str, d: Path, st: dict) -> list[dict]:
        """Move job outputs into the bot's store once; idempotent."""
        lock = locks.setdefault(job, asyncio.Lock())
        try:
            async with lock:
                reg, refused = d / "registered.json", d / "refused.json"
                if reg.exists():
                    return json.loads(reg.read_text())
                if refused.exists():
                    raise ToolError(json.loads(refused.read_text()))
                try:
                    return await asyncio.to_thread(_register, bot, d, st)
                except StoreError as e:
                    raise ToolError(str(e)) from None
        finally:
            locks.pop(job, None)

    async def run_sync(bot, kind: str, files: dict[str, dict], spec: dict) -> tuple[dict, list[dict]]:
        await asyncio.to_thread(store.reserve, bot.key, 0, quota(bot))
        job, d = prepare_job(bot, files)
        ok = False
        try:
            st = await be.worker_submit(bot.key, job, kind, spec, await max_out(bot))
            if st.get("status") != "done":
                raise ToolError(st.get("error") or "processing failed")
            metas = [] if kind in ("probe", "loudness") else await register_outputs(bot, job, d, st)
            ok = True
            return st, metas
        finally:
            if kind in ("probe", "loudness") or not ok:
                shutil.rmtree(d, ignore_errors=True)

    async def max_out(bot) -> int:
        """Bytes one job may write: what the bot has left, at most one file's worth."""
        def calc() -> int:
            left = min(store.remaining(bot.key, quota(bot)), store.spool_free_bytes())
            if left <= 0:
                raise StoreError("bot storage quota exceeded: delete files with file_delete")
            return min(left, cfg.max_file_bytes)
        return await asyncio.to_thread(calc)

    def bot_lock(key: str) -> asyncio.Lock:
        return bot_locks.setdefault(key, asyncio.Lock())

    async def gotenberg_to_store(bot, route: str, files: list, fields: dict[str, str], name: str) -> dict:
        """Convert with Gotenberg straight into a temporary file (size-capped), then register it."""
        def cap() -> int:
            left = min(store.remaining(bot.key, quota(bot)), store.spool_free_bytes())
            if left <= 0:
                raise StoreError("bot storage quota exceeded: delete files with file_delete")
            return min(left, cfg.max_pdf_bytes, cfg.max_file_bytes)
        limit = await asyncio.to_thread(cap)
        tmp = store.new_tmp(bot.key)
        try:
            await be.gotenberg(route, files, fields, tmp, limit)

            def fin() -> dict:
                with store.lock(bot.key):
                    store.reserve(bot.key, 0, quota(bot))  # the temporary is already counted
                    return store.put_path(bot.key, tmp, name, "result")

            return await asyncio.to_thread(fin)
        finally:
            tmp.unlink(missing_ok=True)

    def wrap(fn):
        @functools.wraps(fn)
        async def inner(*a, **kw):
            try:
                return await fn(*a, **kw)
            except (StoreError, specs.SpecError, BackendError) as e:
                raise ToolError(str(e)) from None

        return inner

    def tool(fn):
        return mcp.tool()(wrap(fn))

    # ---- files ---------------------------------------------------------------
    @tool
    async def file_put(name: str, base64_data: str) -> dict:
        """Store a small file (base64) in your private store; returns file_id. For big files use PUT /v1/files."""
        bot = gate("file_put")
        try:
            data = base64.b64decode(base64_data, validate=True)
        except (binascii.Error, ValueError):
            raise ToolError("base64 is not valid") from None
        return public(await asyncio.to_thread(store.put_bytes, bot.key, data, name, "upload", quota(bot)))

    @tool
    async def file_get(file_id: str) -> dict:
        """Return a stored file as base64 (only if small); larger files: GET /v1/files/<id>."""
        bot = gate("file_get")
        meta = await asyncio.to_thread(store.meta, bot.key, file_id)
        return with_inline(meta, True)

    @tool
    async def file_list() -> dict:
        """List your files with sizes and the remaining quota."""
        bot = gate("file_list")
        items = await asyncio.to_thread(store.list, bot.key)
        used = await asyncio.to_thread(store.used_bytes, bot.key)
        return {"files": [public(m) for m in items], "used_bytes": used, "quota_bytes": quota(bot), "ttl_hours": cfg.file_ttl_hours}

    @tool
    async def file_delete(file_id: str) -> dict:
        """Delete one of your files."""
        bot = gate("file_delete")
        await asyncio.to_thread(store.delete, bot.key, file_id)
        return {"deleted": file_id}

    # ---- media -----------------------------------------------------------------
    @tool
    async def media_probe(input: FileInput) -> dict:
        """ffprobe a video/audio/image file: duration, streams (codec, size, fps, channels), container."""
        bot = gate("media_probe")
        meta, temp = await resolve(bot, input)
        try:
            alias = safe_name(meta["name"])
            st, _ = await run_sync(bot, "probe", {alias: meta}, {"input": alias})
        finally:
            if temp:
                await drop(bot, [meta])
        try:
            raw = json.loads(st.get("stdout") or "{}")
        except ValueError:
            raise ToolError("probe output is not JSON") from None
        fmt = raw.get("format", {})
        keep = ("index", "codec_type", "codec_name", "width", "height", "r_frame_rate", "avg_frame_rate", "duration",
                "sample_rate", "channels", "channel_layout", "bit_rate", "pix_fmt", "nb_frames")
        return {"format": {k: fmt.get(k) for k in ("format_name", "duration", "size", "bit_rate")},
                "streams": [{k: s.get(k) for k in keep if k in s} for s in raw.get("streams", [])][:16]}

    @tool
    async def audio_loudness(input: FileInput) -> dict:
        """Integrated loudness (LUFS), loudness range (LU) and true peak (dBFS) of an audio or video file (EBU R128)."""
        bot = gate("audio_loudness")
        meta, temp = await resolve(bot, input)
        try:
            alias = safe_name(meta["name"])
            st, _ = await run_sync(bot, "loudness", {alias: meta}, {"input": alias})
        finally:
            if temp:
                await drop(bot, [meta])
        text = st.get("stdout", "")
        summary = text.rsplit("Summary:", 1)[-1] if "Summary:" in text else ""
        vals = {}
        for key, pat in (("integrated_lufs", r"\bI:\s+(-?[\d.]+|-inf)\s+LUFS"), ("range_lu", r"\bLRA:\s+(-?[\d.]+)\s+LU"),
                         ("true_peak_dbfs", r"\bPeak:\s+(-?[\d.]+|-inf)\s+dBFS")):
            mt = re.search(pat, summary)
            vals[key] = None if not mt or mt.group(1) == "-inf" else float(mt.group(1))
        if not summary:
            raise ToolError("no audio stream or no loudness summary")
        return vals

    @tool
    async def ffmpeg_submit(files: dict[str, FileInput], spec: dict) -> dict:
        """Queue an ffmpeg job (async). `files` maps an alias to a file; `spec` is
        {inputs:[{file:alias,start?,duration?,loop?,framerate?}|{lavfi:"color=c=black:s=1080x1920:d=3"}],
         filter_complex?|video_filter?/audio_filter? (allow-listed filters; subtitles/ass may name an alias, fontsdir='.'),
         maps?:["[v]","0:a"], output:{name,format(mp4|mov|mkv|webm|gif|mp3|m4a|wav|ogg|flac|opus|png|jpg|webp),
         video_codec?,audio_codec?,crf?,preset?,video_bitrate?,audio_bitrate?,fps?,pix_fmt?,sample_rate?,channels?,
         frames?,max_duration?,faststart?}}. Returns job_id; poll job_status. Outputs become files in your store."""
        bot = gate("ffmpeg_submit")
        if not files:
            raise ToolError("files: at least one input")
        aliases = {specs.check_alias(a) for a in files}
        specs.build_ffmpeg_argv(spec, aliases)  # validate before anything is created
        async with bot_lock(bot.key):  # the limit check and the job it guards are one step
            if active_jobs(bot) >= cfg.max_active_jobs_per_bot:
                raise ToolError(f"too many active jobs (limit {cfg.max_active_jobs_per_bot}); wait or job_cancel")
            metas: dict[str, dict] = {}
            temps: list[dict] = []
            try:
                for alias, ref in files.items():
                    m, t = await resolve(bot, ref)
                    metas[alias] = m
                    if t:
                        temps.append(m)
                limit = await max_out(bot)
                job, d = prepare_job(bot, metas, queued=True)
            except BaseException:
                await drop(bot, temps)
                raise
            await drop(bot, temps)  # hard links keep the bytes for the job; the store entry can go
            try:
                st = await be.worker_submit(bot.key, job, "ffmpeg", spec, limit)
            except BaseException:
                shutil.rmtree(d, ignore_errors=True)
                raise
        return {"job_id": job, "status": st.get("status", "queued")}

    @tool
    async def job_status(job_id: str, inline: bool = False) -> dict:
        """Status of an ffmpeg job. When done: outputs (file ids). inline=true adds base64 for small outputs."""
        bot = gate("job_status")
        if not JOB_IDS.match(job_id or ""):
            raise ToolError("bad job id")
        d = store.bot_dir(bot.key) / "jobs" / job_id
        if not d.is_dir():
            raise ToolError("no such job (unknown id or expired)")
        st = await be.worker_status(bot.key, job_id)
        out = {"job_id": job_id, "status": st.get("status")}
        if st.get("status") == "done":
            out["outputs"] = [with_inline(m, inline) for m in await register_outputs(bot, job_id, d, st)]
        elif st.get("status") in ("failed", "cancelled"):
            out["error"] = st.get("error", "")
            for sub in ("in", "out"):  # normally the worker already did; belt and braces
                shutil.rmtree(d / sub, ignore_errors=True)
        return out

    @tool
    async def job_cancel(job_id: str) -> dict:
        """Cancel a queued or running job."""
        bot = gate("job_cancel")
        if not JOB_IDS.match(job_id or "") or not (store.bot_dir(bot.key) / "jobs" / job_id).is_dir():
            raise ToolError("no such job")
        return await be.worker_cancel(bot.key, job_id)

    @tool
    async def image_transform(input: FileInput, format: str = "jpg", width: int | None = None, height: int | None = None,
                              fit: str = "inside", crop: dict | None = None, rotate: int = 0, quality: int | None = None,
                              background: str = "white", inline: bool = False) -> dict:
        """Resize/crop/rotate/convert one image (jpg|png|webp). fit: inside|contain|cover|fill. crop={x,y,w,h} applies first."""
        bot = gate("image_transform")
        meta, temp = await resolve(bot, input)
        try:
            alias = safe_name(meta["name"])
            spec = {"input": alias, "format": format, "fit": fit, "rotate": rotate, "background": background,
                    "output_name": "image." + format}
            for k, v in (("width", width), ("height", height), ("crop", crop), ("quality", quality)):
                if v is not None:
                    spec[k] = v
            _, outs = await run_sync(bot, "image", {alias: meta}, spec)
        finally:
            if temp:
                await drop(bot, [meta])
        return with_inline(outs[0], inline)

    @tool
    async def pdf_to_images(input: FileInput, dpi: int = 110, first_page: int = 1, last_page: int | None = None,
                            format: str = "png") -> dict:
        """Render PDF pages to png/jpeg (poppler). At most 40 pages per call; results are files in your store."""
        bot = gate("pdf_to_images")
        meta, temp = await resolve(bot, input)
        try:
            alias = safe_name(meta["name"])
            spec: dict[str, Any] = {"input": alias, "dpi": dpi, "first_page": first_page, "format": format}
            if last_page is not None:
                spec["last_page"] = last_page
            _, outs = await run_sync(bot, "pdf_images", {alias: meta}, spec)
        finally:
            if temp:
                await drop(bot, [meta])
        return {"pages": [public(m) for m in outs]}

    # ---- documents ---------------------------------------------------------------
    @tool
    async def office_to_pdf(input: FileInput, landscape: bool = False, page_ranges: str | None = None,
                            inline: bool = False) -> dict:
        """Convert an office document (docx, xlsx, pptx, odt, ods, odp, rtf, csv, ...) to PDF with LibreOffice."""
        bot = gate("office_to_pdf")
        meta, temp = await resolve(bot, input)
        try:
            name = safe_name(meta["name"])
            ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
            if ext not in OFFICE_EXT:
                raise ToolError(f"unsupported extension .{ext}; allowed: {', '.join(sorted(OFFICE_EXT))}")
            fields = {"landscape": "true" if landscape else "false"}
            if page_ranges:
                if not __import__("re").fullmatch(r"[0-9,\- ]{1,40}", page_ranges):
                    raise ToolError("page_ranges looks like 1-3,5")
                fields["nativePageRanges"] = page_ranges
            if meta["size"] > cfg.max_convert_bytes:
                raise ToolError(f"file larger than {cfg.max_convert_bytes // 2**20} MiB for conversion")
            with store.blob(bot.key, meta["id"]).open("rb") as fh:
                out = await gotenberg_to_store(bot, "/forms/libreoffice/convert",
                                               [("files", (name, fh, "application/octet-stream"))], fields,
                                               name.rsplit(".", 1)[0] + ".pdf")
        finally:
            if temp:
                await drop(bot, [meta])
        return with_inline(out, inline)

    @tool
    async def html_to_pdf(html: str, assets: dict[str, FileInput] | None = None, paper: str = "A4", landscape: bool = False,
                          print_background: bool = True, margin_mm: float = 10, inline: bool = False) -> dict:
        """Render an HTML string to PDF (headless Chromium, JavaScript off, only your own assets load). Local assets (css, images, fonts) go in `assets`
        (alias -> file) and are referenced by relative name. No URL mode: to render a live page use the browser tool."""
        bot = gate("html_to_pdf")
        sizes = {"A4": (8.27, 11.69), "A3": (11.69, 16.54), "A5": (5.83, 8.27), "Letter": (8.5, 11)}
        if paper not in sizes:
            raise ToolError(f"paper: one of {sorted(sizes)}")
        if len(html.encode()) > 4 * 1024 * 1024:
            raise ToolError("html larger than 4 MiB; move heavy parts to assets")
        if not 0 <= margin_mm <= 50:
            raise ToolError("margin_mm 0..50")
        w, h = sizes[paper]
        m = f"{margin_mm / 25.4:.3f}"
        fields = {"paperWidth": str(w), "paperHeight": str(h), "landscape": "true" if landscape else "false",
                  "printBackground": "true" if print_background else "false",
                  "marginTop": m, "marginBottom": m, "marginLeft": m, "marginRight": m, "waitDelay": "0.5s"}
        temps: list[dict] = []
        opened: list = []
        try:
            files: list = [("files", ("index.html", html.encode(), "text/html"))]
            for alias, ref in (assets or {}).items():
                specs.check_alias(alias)
                if alias == "index.html":
                    raise ToolError("asset alias index.html is reserved")
                meta, t = await resolve(bot, ref)
                if t:
                    temps.append(meta)
                fh = store.blob(bot.key, meta["id"]).open("rb")
                opened.append(fh)
                files.append(("files", (alias, fh, "application/octet-stream")))
            out = await gotenberg_to_store(bot, "/forms/chromium/convert/html", files, fields, "document.pdf")
        finally:
            for fh in opened:
                fh.close()
            await drop(bot, temps)
        return with_inline(out, inline)

    @tool
    async def extract_text(input: FileInput, ocr: bool = True, max_chars: int = 50_000) -> dict:
        """Text of a document (pdf, office, html, epub, ...) or OCR of an image/scan (Tesseract rus+eng) via Tika."""
        bot = gate("extract_text")
        cap = min(max(int(max_chars), 1000), cfg.max_text_chars)  # the answer is cut off here, not after reading it all
        meta, temp = await resolve(bot, input)
        try:
            if meta["size"] > cfg.max_convert_bytes:
                raise ToolError(f"file larger than {cfg.max_convert_bytes // 2**20} MiB for text extraction")
            with store.blob(bot.key, meta["id"]).open("rb") as fh:
                text, cut = await be.tika_text(safe_name(meta["name"]), fh, meta["size"], ocr, cap)
        finally:
            if temp:
                await drop(bot, [meta])
        text = text.strip()
        return {"text": text, "chars": len(text), "truncated": cut, "empty": not text and not cut, "ocr": ocr}

    # ---- REST for big files -------------------------------------------------------
    async def put_file(request: Request):
        bot = me()
        name = request.query_params.get("name", "")
        if not name:
            return JSONResponse({"error": "name query parameter required"}, status_code=400)
        try:
            declared = int(request.headers.get("content-length") or 0)
        except ValueError:
            return JSONResponse({"error": "bad content-length"}, status_code=400)
        tmp = None
        try:
            await asyncio.to_thread(store.reserve, bot.key, declared, quota(bot))
            left = await asyncio.to_thread(lambda: min(store.remaining(bot.key, quota(bot)), store.spool_free_bytes()))
            limit = min(cfg.max_file_bytes, left)
            tmp = store.new_tmp(bot.key)
            total, checked = 0, 0
            with tmp.open("wb") as f:
                async for chunk in request.stream():
                    total += len(chunk)
                    if total > limit:
                        raise StoreError("file too large or storage quota exceeded")
                    f.write(chunk)
                    if total - checked >= 32 * 2**20:  # parallel uploads share the quota
                        checked = total
                        await asyncio.to_thread(store.reserve, bot.key, 0, quota(bot))

            def fin() -> dict:
                with store.lock(bot.key):
                    store.reserve(bot.key, 0, quota(bot))  # the temporary is already counted
                    return store.put_path(bot.key, tmp, name, "upload")

            meta = await asyncio.to_thread(fin)
        except StoreError as e:
            return JSONResponse({"error": str(e)}, status_code=413)
        finally:
            if tmp is not None:
                tmp.unlink(missing_ok=True)
        return JSONResponse(public(meta), status_code=201)

    async def get_file(request: Request):
        bot = me()
        try:
            meta = await asyncio.to_thread(store.meta, bot.key, request.path_params["fid"])
        except StoreError as e:
            return JSONResponse({"error": str(e)}, status_code=404)
        return FileResponse(store.blob(bot.key, meta["id"]), filename=meta["name"], media_type="application/octet-stream")

    async def health(_: Request):
        return JSONResponse({"ok": True})

    app = mcp.streamable_http_app()
    app.router.routes.extend([
        Route("/v1/files", put_file, methods=["PUT", "POST"]),
        Route("/v1/files/{fid}", get_file, methods=["GET"]),
        Route("/healthz", health),
    ])
    app.add_middleware(AuthMiddleware, auth=auth)

    async def janitor():
        while True:
            await asyncio.sleep(1800)
            try:
                await asyncio.to_thread(store.sweep)
            except OSError:
                pass

    inner = app.router.lifespan_context

    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def lifespan(a):
        t = asyncio.create_task(janitor())
        async with inner(a):
            yield
        t.cancel()
        await be.aclose()

    app.router.lifespan_context = lifespan
    return app
