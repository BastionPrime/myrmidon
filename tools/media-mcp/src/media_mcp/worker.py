"""Worker: runs validated ffmpeg / ffprobe / pdftoppm jobs. Internal network only.

Sync kinds (probe, image, pdf_images) return when finished; ffmpeg jobs are queued and
polled. Each job runs in /spool/bots/<bot>/jobs/<job>/ with cwd=in/, output to ../out/.
No shell, no bot-supplied argv, resource limits per process, whole process group killed
on timeout or cancel.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import resource
import shutil
import signal
import time
from pathlib import Path

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from . import specs
from .config import BOT_KEY_RE, Settings, load_settings

JOB_ID_RE = __import__("re").compile(r"^[0-9a-f]{32}$")
TIMEOUTS = {"ffmpeg": 1800, "image": 60, "pdf_images": 180, "probe": 30, "loudness": 600}
SYNC_KINDS = {"image", "pdf_images", "probe", "loudness"}  # the facade waits for these on one HTTP call
NO_OUTPUT = {"probe", "loudness"}  # results come back as text, not files
MAX_OUT_BYTES = 2 * 1024**3  # hard ceiling per file; the facade passes the bot's remaining quota, which is lower
MIN_OUT_BYTES = 1 << 20
CONCURRENCY = int(os.environ.get("WORKER_CONCURRENCY", "2"))


def _limits(cpu_s: int, fsize: int = MAX_OUT_BYTES):
    def apply():
        os.setsid()
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_s * 2 + 30, cpu_s * 2 + 30))
        resource.setrlimit(resource.RLIMIT_FSIZE, (fsize, fsize))
        resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))

    return apply


class Worker:
    def __init__(self, cfg: Settings):
        self.cfg = cfg
        self.queue: asyncio.Queue[tuple[str, str]] = asyncio.Queue()
        self.procs: dict[str, asyncio.subprocess.Process] = {}
        self.cancelled: set[str] = set()

    def job_dir(self, bot: str, job: str) -> Path:
        if not BOT_KEY_RE.match(bot) or not JOB_ID_RE.match(job):
            raise specs.SpecError("bad bot or job id")
        return self.cfg.data_dir / "bots" / bot / "jobs" / job

    def timeout_for(self, kind: str) -> int:
        """Short kinds must finish before the facade's HTTP call gives up, or the work runs on unseen."""
        t = TIMEOUTS[kind]
        return min(t, self.cfg.backend_timeout_s + 30) if kind in SYNC_KINDS else t

    @staticmethod
    def dir_bytes(p: Path) -> int:
        total = 0
        for root, _d, names in os.walk(p):
            for n in names:
                try:
                    total += os.lstat(os.path.join(root, n)).st_size
                except OSError:
                    pass
        return total

    def out_limit(self, requested: int | None) -> int:
        """Bytes this job may write: the bot's remaining quota, the ceiling, and the free space."""
        lim = MAX_OUT_BYTES if not requested else max(MIN_OUT_BYTES, min(int(requested), MAX_OUT_BYTES))
        if self.cfg.spool_min_free_bytes:
            try:
                free = shutil.disk_usage(self.cfg.data_dir).free - self.cfg.spool_min_free_bytes
                lim = max(MIN_OUT_BYTES, min(lim, free))
            except OSError:
                pass
        return lim

    def fail(self, d: Path, error: str, status: str = "failed") -> None:
        """Terminal non-success state: free the disk now instead of waiting for the TTL."""
        for sub in ("in", "out"):
            shutil.rmtree(d / sub, ignore_errors=True)
        self.write_state(d, status=status, error=error, finished=time.time())

    async def _watch(self, d: Path, proc: asyncio.subprocess.Process, limit: int, hit: list) -> None:
        """Kill the job when everything it wrote together exceeds the limit (RLIMIT_FSIZE is per file)."""
        while proc.returncode is None:
            await asyncio.sleep(2)
            if await asyncio.to_thread(self.dir_bytes, d / "out") > limit:
                hit.append(True)
                self._kill(proc)
                return

    def state(self, d: Path) -> dict:
        try:
            return json.loads((d / "job.json").read_text())
        except (OSError, ValueError):
            return {"status": "unknown"}

    def write_state(self, d: Path, **kw) -> dict:
        st = self.state(d)
        st.update(kw)
        tmp = d / "job.json.tmp"
        tmp.write_text(json.dumps(st))
        os.replace(tmp, d / "job.json")
        return st

    def argv_for(self, kind: str, spec: dict, d: Path) -> list[str]:
        aliases = {p.name for p in (d / "in").iterdir()} if (d / "in").is_dir() else set()
        if kind == "ffmpeg":
            return specs.build_ffmpeg_argv(spec, aliases)
        if kind == "image":
            return specs.build_image_argv(spec, aliases)
        if kind == "pdf_images":
            return specs.build_pdf_images_argv(spec, aliases)
        if kind == "probe":
            return specs.build_probe_argv(specs.check_alias(spec.get("input"), aliases))
        if kind == "loudness":
            return specs.build_loudness_argv(specs.check_alias(spec.get("input"), aliases))
        raise specs.SpecError(f"unknown job kind {kind!r}")

    async def run(self, bot: str, job: str) -> None:
        d = self.job_dir(bot, job)
        st = self.state(d)
        kind, spec = st["kind"], st["spec"]
        if job in self.cancelled:
            self.fail(d, "cancelled", "cancelled")
            return
        try:
            argv = self.argv_for(kind, spec, d)
        except specs.SpecError as e:
            self.fail(d, str(e))
            return
        (d / "out").mkdir(exist_ok=True)
        timeout = self.timeout_for(kind)
        limit = self.out_limit(st.get("max_out_bytes"))
        self.write_state(d, status="running", started=time.time())
        env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(d), "LANG": "C.UTF-8"}
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv, cwd=d / "in", env=env, stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                preexec_fn=_limits(timeout, limit),
            )
        except OSError as e:
            self.fail(d, f"cannot start: {e.strerror}")
            return
        self.procs[job] = proc
        hit: list = []
        watcher = asyncio.create_task(self._watch(d, proc, limit, hit))
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            self._kill(proc)
            self.fail(d, f"timeout after {timeout}s")
            return
        finally:
            watcher.cancel()
            self.procs.pop(job, None)
        if job in self.cancelled:
            self.fail(d, "cancelled", "cancelled")
            return
        if hit or self.dir_bytes(d / "out") > limit:
            self.fail(d, "output exceeds the storage available to this bot")
            return
        tail = err.decode("utf-8", "replace")[-1500:]
        files = sorted(p.name for p in (d / "out").iterdir() if p.is_file())
        if proc.returncode == -signal.SIGXFSZ:
            self.fail(d, "output exceeds the storage available to this bot")
            return
        if proc.returncode != 0 or (kind not in NO_OUTPUT and not files):
            self.fail(d, tail or f"exit {proc.returncode}")
            return
        extra = {}
        if kind == "probe":
            extra = {"stdout": out.decode("utf-8", "replace")[:200_000]}
        elif kind == "loudness":  # ebur128 prints its summary on stderr
            extra = {"stdout": err.decode("utf-8", "replace")[-4000:]}
        self.write_state(d, status="done", outputs=files, log=tail, finished=time.time(), **extra)

    @staticmethod
    def _kill(proc: asyncio.subprocess.Process) -> None:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    async def loop(self) -> None:
        while True:
            bot, job = await self.queue.get()
            try:
                await self.run(bot, job)
            except Exception as e:  # never let the loop die
                try:
                    self.fail(self.job_dir(bot, job), f"internal: {type(e).__name__}")
                except Exception:
                    pass
            finally:
                self.cancelled.discard(job)
                self.queue.task_done()


def build_app(cfg: Settings | None = None) -> Starlette:
    cfg = cfg or load_settings(need_bots=False)
    if not cfg.worker_token:
        raise SystemExit("MEDIA_WORKER_TOKEN is required")
    w = Worker(cfg)
    sem = asyncio.Semaphore(CONCURRENCY)

    def authed(request: Request) -> bool:
        got = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        return hmac.compare_digest(got.encode(), cfg.worker_token.encode())

    async def submit(request: Request):
        if not authed(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        body = await request.json()
        try:
            bot, job, kind, spec = body["bot"], body["job"], body["kind"], body["spec"]
            d = w.job_dir(bot, job)
            if kind not in TIMEOUTS or not (d / "in").is_dir():
                raise specs.SpecError("unknown kind or job directory")
            w.argv_for(kind, spec, d)  # validate now
        except (KeyError, specs.SpecError) as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        mob = body.get("max_out_bytes")
        mob = mob if isinstance(mob, int) and not isinstance(mob, bool) and mob > 0 else None
        w.write_state(d, kind=kind, spec=spec, status="queued", created=time.time(), max_out_bytes=mob)
        if kind == "ffmpeg":
            await w.queue.put((bot, job))
            return JSONResponse({"job": job, "status": "queued"}, status_code=202)
        async with sem:  # short jobs run inline, bounded by the same concurrency
            await w.run(bot, job)
        w.cancelled.discard(job)
        return JSONResponse(w.state(d))

    async def status(request: Request):
        if not authed(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        try:
            d = w.job_dir(request.path_params["bot"], request.path_params["job"])
        except specs.SpecError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        st = w.state(d)
        st.pop("spec", None)
        return JSONResponse(st)

    async def cancel(request: Request):
        if not authed(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        try:
            d = w.job_dir(request.path_params["bot"], request.path_params["job"])
        except specs.SpecError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        job = request.path_params["job"]
        w.cancelled.add(job)
        if job in w.procs:
            w._kill(w.procs[job])
        if w.state(d).get("status") in ("queued",):
            w.fail(d, "cancelled", "cancelled")
        return JSONResponse({"job": job, "status": w.state(d).get("status")})

    async def health(_: Request):
        return JSONResponse({"ok": True, "queued": w.queue.qsize(), "running": len(w.procs)})

    async def lifespan(app):
        # Anything left running by a previous process is dead: say so instead of hanging.
        for st in (cfg.data_dir / "bots").glob("*/jobs/*/job.json"):
            try:
                s = json.loads(st.read_text())
                if s.get("status") in ("queued", "running"):
                    s.update(status="failed", error="worker restarted", finished=time.time())
                    st.write_text(json.dumps(s))
                    for sub in ("in", "out"):
                        shutil.rmtree(st.parent / sub, ignore_errors=True)
            except (OSError, ValueError):
                pass
        tasks = [asyncio.create_task(w.loop()) for _ in range(CONCURRENCY)]
        yield
        for t in tasks:
            t.cancel()

    return Starlette(
        routes=[
            Route("/v1/jobs", submit, methods=["POST"]),
            Route("/v1/jobs/{bot}/{job}", status, methods=["GET"]),
            Route("/v1/jobs/{bot}/{job}/cancel", cancel, methods=["POST"]),
            Route("/healthz", health),
        ],
        lifespan=lifespan,
    )
