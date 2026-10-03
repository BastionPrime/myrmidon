"""OPE-3288: медиа-клиент для скриптов бота (stdlib-only, python3.13 в контейнере бота).

Тонкая обёртка над MCP media-tools (http://media-mcp:8080). Построена так, чтобы
скрипты из tools/posts (post_media_prep.py, media_look.py) могли заменить прямые
вызовы subprocess ffmpeg/ffprobe на вызовы этого клиента, не меняя остальную логику:

- probe(path) — вместо ffprobe -show_entries … (длительность, потоки, кодеки);
- loudness(path) — EBU R128 LUFS/LRA/Peak;
- ffmpeg_run(spec, files) — синхронная обёртка над ffmpeg_submit + job_status-поллинг:
  возвращает список выходных файлов и качает их в локальный каталог;
- upload(path)/download(file_id, path) — REST /v1/files для больших файлов.

Аутентификация: переменные окружения MEDIA_TOOLS_URL (по умолчанию
http://media-mcp:8080) и MEDIA_TOOLS_TOKEN (bearer бота, если задан).
Синхронный (не async) API: вызывается из обычных CLI-скриптов.
"""
from __future__ import annotations

import base64
import json
import os
import time
import urllib.error
import urllib.request

DEFAULT_URL = os.environ.get("MEDIA_TOOLS_URL", "http://media-mcp:8080")
TOKEN = os.environ.get("MEDIA_TOOLS_TOKEN", "")
# Host-заголовок проверяет фасад (MEDIA_ALLOWED_HOSTS, по умолчанию media-mcp,media-mcp:8080).
# По умолчанию берём hostname из URL — при кастомном имени пропишите MEDIA_TOOLS_HOST.
_host = urllib.parse.urlsplit(DEFAULT_URL).hostname or "media-mcp"
HOST = os.environ.get("MEDIA_TOOLS_HOST", _host)
POLL_INTERVAL = float(os.environ.get("MEDIA_TOOLS_POLL_INTERVAL", "2"))
POLL_TIMEOUT = float(os.environ.get("MEDIA_TOOLS_POLL_TIMEOUT", "1800"))


class MediaError(RuntimeError):
    pass


def _headers():
    h = {"Content-Type": "application/json",
         "Accept": "application/json, text/event-stream",
         "Host": HOST}
    if TOKEN:
        h["Authorization"] = "Bearer " + TOKEN
    return h


def _rpc(method, params=None, timeout=180):
    body = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None:
        body["params"] = params
    req = urllib.request.Request(DEFAULT_URL + "/mcp", data=json.dumps(body).encode(),
                                 method="POST", headers=_headers())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode()
    except urllib.error.HTTPError as e:
        raise MediaError("media-mcp HTTP %d: %s" % (e.code, e.read().decode()[:300])) from None
    data = None
    if raw.startswith("event:") or raw.startswith("data:"):
        for line in raw.splitlines():
            if line.startswith("data:"):
                data = json.loads(line[5:].strip())
    else:
        data = json.loads(raw)
    if data is None:
        raise MediaError("media-mcp: empty response to " + method)
    if data.get("error"):
        raise MediaError("media-mcp rpc error: " + json.dumps(data["error"], ensure_ascii=False))
    return data.get("result", {})


def _call(name, args, timeout=180):
    res = _rpc("tools/call", {"name": name, "arguments": args}, timeout=timeout)
    if res.get("isError"):
        text = res.get("content", [{}])[0].get("text", "")
        raise MediaError("media-mcp tool %s: %s" % (name, text[:500]))
    texts = res.get("content", [])
    if texts and texts[0].get("type") == "text":
        try:
            return json.loads(texts[0]["text"])
        except ValueError:
            return texts[0]["text"]
    return res


# ---- файлы -----------------------------------------------------------------

def upload(path: str, name: str | None = None) -> dict:
    """Большой файл → file_id (REST PUT /v1/files?name=…). Возвращает мету файла."""
    name = name or os.path.basename(path)
    size = os.path.getsize(path)
    req = urllib.request.Request("%s/v1/files?name=%s" % (DEFAULT_URL, urllib.parse.quote(name)),
                                 method="PUT", data=open(path, "rb").read(),
                                 headers={**_headers(), "Content-Type": "application/octet-stream"})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raise MediaError("upload HTTP %d: %s" % (e.code, e.read().decode()[:300])) from None


def file_put(path: str, name: str | None = None) -> dict:
    """Маленький файл через MCP file_put (base64 inline)."""
    name = name or os.path.basename(path)
    with open(path, "rb") as fh:
        b64 = base64.b64encode(fh.read()).decode()
    return _call("file_put", {"name": name, "base64_data": b64})


def download(file_id: str, path: str) -> str:
    req = urllib.request.Request(DEFAULT_URL + "/v1/files/" + file_id, headers=_headers())
    with urllib.request.urlopen(req, timeout=600) as r:
        data = r.read()
    with open(path, "wb") as fh:
        fh.write(data)
    return path


# ---- зонды -----------------------------------------------------------------

def probe(path: str) -> dict:
    """ffprobe-эквивалент: duration/streams/codec. Файл уезжает в store бота."""
    meta = file_put(path)
    try:
        return _call("media_probe", {"input": {"file_id": meta["id"]}})
    finally:
        _delete_quiet(meta["id"])


def loudness(path: str) -> dict:
    meta = file_put(path)
    try:
        return _call("audio_loudness", {"input": {"file_id": meta["id"]}})
    finally:
        _delete_quiet(meta["id"])


def _delete_quiet(file_id: str) -> None:
    try:
        _call("file_delete", {"file_id": file_id})
    except MediaError:
        pass


# ---- ffmpeg ----------------------------------------------------------------

def ffmpeg_run(spec: dict, files: dict[str, str] | None = None, out_dir: str | None = None,
               keep_inputs: bool = False) -> list[dict]:
    """Синхронный прогон ffmpeg через сервис: upload входов → submit → поллинг → download.

    files: {alias: локальный путь}. Возвращает список мет выходных файлов с полем
    local_path (локальный скачанный файл), если задан out_dir. Идентификаторы
    выходных файлов остаются в store бота (TTL 48 ч).
    """
    file_ids: dict[str, str] = {}
    uploaded: list[str] = []
    try:
        for alias, p in (files or {}).items():
            meta = file_put(p) if os.path.getsize(p) < 24 * 2 ** 20 else upload(p)
            file_ids[alias] = meta["id"]
            uploaded.append(meta["id"])
        r = _call("ffmpeg_submit", {"files": {a: {"file_id": fid} for a, fid in file_ids.items()},
                                     "spec": spec})
        job = r["job_id"]
        deadline = time.time() + POLL_TIMEOUT
        st = {"status": "queued"}
        while time.time() < deadline:
            time.sleep(POLL_INTERVAL)
            st = _call("job_status", {"job_id": job})
            if st.get("status") in ("done", "failed", "cancelled"):
                break
        if st.get("status") != "done":
            raise MediaError("ffmpeg job %s: %s (%s)" % (job, st.get("status"), st.get("error", "")))
        outs = st.get("outputs", [])
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
            for o in outs:
                o["local_path"] = download(o["id"], os.path.join(out_dir, o["name"]))
        return outs
    finally:
        if not keep_inputs:
            for fid in uploaded:
                _delete_quiet(fid)
