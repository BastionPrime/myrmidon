"""OPE-3288: патч-слой для post_media_prep.py — заменяет вызовы ffmpeg/ffprobe на
медиасервис. Применяется в живом дереве bbq-workspace/tools/posts поверх текущего
post_media_prep.py (функция shim() вставляется до main, вызовы переклиниваются).

Стратегия: локальный ffmpeg/ffprobe остались как FAST-PATH (для сред, где бинарник
есть — профили на vm-core), а при их отсутствии путь автоматически уходит в
медиасервис (контейнер бота). Это сохраняет работоспособность у smm/operator
на старых средах и чинит video-director в контейнере бота (OPE-3288).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess

# --- media-клиент (см. media_client.py в том же каталоге) --------------------
import sys as _sys
import sys

_dir = os.path.dirname(os.path.abspath(__file__))
if _dir not in _sys.path:
    _sys.path.insert(0, _dir)

try:
    import media_client
    _HAS_MEDIA = True
except Exception:
    _HAS_MEDIA = False


class MediaFallbackError(RuntimeError):
    pass


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def ffprobe_available() -> bool:
    return shutil.which("ffprobe") is not None


def video_info(path: str) -> tuple[dict, str | None]:
    """OPE-3288: {duration, size,...} видео. Локальный ffprobe, иначе media_probe.
    Возвращает (info, error) — контракт прежний (_video_info OPE-2384)."""
    if ffprobe_available():
        try:
            proc = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration,size",
                 "-of", "json", path], capture_output=True, text=True, timeout=20)
            if proc.returncode != 0:
                return {}, (proc.stderr or "ffprobe failed").strip()
            return json.loads(proc.stdout).get("format", {}), None
        except (subprocess.TimeoutExpired, ValueError, OSError) as e:
            return {}, "ffprobe: %s" % e
    if not _HAS_MEDIA:
        return {}, None  # прежний best-effort для select: {}, не ошибка
    try:
        pr = media_client.probe(path)
    except media_client.MediaError as e:
        return {}, "media_probe: %s" % e
    fmt = pr.get("format", {})
    v = next((s for s in pr.get("streams", []) if s.get("codec_type") == "video"), {})
    info = {"duration": fmt.get("duration"), "size": fmt.get("size")}
    if v.get("width"):
        info["width"] = v["width"]
        info["height"] = v["height"]
    if v.get("r_frame_rate"):
        info["r_frame_rate"] = v["r_frame_rate"]
    return info, None


def run_ffmpeg(argv: list[str], inputs: dict[str, str] | None = None,
               output_path: str | None = None, cwd: str | None = None) -> int:
    """OPE-3288: запуск ffmpeg. Локально — subprocess; в контейнере бота — конверсия
    argv в спеку медиасервиса (поддерживается подмножество фильтров, используемых
    post_media_prep: crop, scale, pad, setsar, overlay, drawtext (через subtitles/ass —
    только сервисными спеками), trim/atrim, concat через filter_complex, fade).

    argv[0] == 'ffmpeg'. Возвращает rc. Локальный вывод пишется в output_path.
    Для сложных argv, не покрываемых спекой, — громкий отказ (rc=1, stderr-текст),
    чтобы отказ не был молчаливым (канон OPE-2384)."""
    if ffmpeg_available():
        proc = subprocess.run(argv, capture_output=True, text=True, cwd=cwd)
        return proc.returncode
    return media_ffmpeg_argv(argv, inputs, output_path, cwd)


# --- конверсия argv → спека ---------------------------------------------------
# Поддерживаем только то, что реально встречается в tools/posts. Всё прочее — отказ.


def media_ffmpeg_argv(argv: list[str], inputs: dict[str, str] | None = None,
                       output_path: str | None = None, cwd: str | None = None) -> int:
    if not _HAS_MEDIA:
        raise MediaFallbackError("ffmpeg недоступен, медиасервис не настроен "
                                 "(MEDIA_TOOLS_URL/MEDIA_TOOLS_TOKEN)")
    try:
        spec, alias_map = _argv_to_spec(argv, output_path)
    except MediaFallbackError as e:
        sys.stderr.write("[media-ffmpeg] %s\n" % e)
        return 1
    files = {alias: (os.path.join(cwd, p) if cwd and not os.path.isabs(p) else p)
             for alias, p in (inputs or alias_map).items()}
    out_dir = os.path.dirname(output_path) if output_path else (cwd or ".")
    try:
        outs = media_client.ffmpeg_run(spec, files=files, out_dir=out_dir)
    except (media_client.MediaError, OSError) as e:
        sys.stderr.write("[media-ffmpeg] %s\n" % e)
        return 1
    return 0


def _argv_to_spec(argv: list[str], output_path: str | None):
    """Минимальный парсер: -i (файлы), -vf/-af/-filter_complex, -ss/-t перед -i,
    -c:v/-c:a, -crf, -preset, -r, -pix_fmt, -movflags +faststart, выходной файл.
    Лавфи-входы и %d-паттерны не поддерживаются (в tools/posts не встречаются)."""
    if not argv or argv[0] != "ffmpeg":
        raise MediaFallbackError("ожидался argv[0]=ffmpeg")
    inputs_spec: list[dict] = []
    alias_map: dict[str, str] = {}
    vf = af = fc = None
    out_opts: dict = {"format": "mp4"}
    out_name = None
    i = 1
    cur_in: dict = {}
    n = 0
    while i < len(argv):
        a = argv[i]
        if a == "-i":
            src = argv[i + 1]
            if src.startswith("lavfi:"):
                raise MediaFallbackError("lavfi-входы не поддерживаются конверсией")
            alias = "in%d" % n
            n += 1
            inputs_spec.append({"file": alias, **cur_in})
            alias_map[alias] = src
            cur_in = {}
            i += 2
        elif a in ("-vf", "-filter:v"):
            vf = argv[i + 1]; i += 2
        elif a in ("-af", "-filter:a"):
            af = argv[i + 1]; i += 2
        elif a == "-filter_complex":
            fc = argv[i + 1]; i += 2
        elif a == "-ss":
            cur_in["start"] = float(argv[i + 1]); i += 2
        elif a in ("-t",):
            cur_in["duration"] = float(argv[i + 1]); i += 2
        elif a == "-c:v":
            out_opts["video_codec"] = argv[i + 1]; i += 2
        elif a == "-c:a":
            out_opts["audio_codec"] = argv[i + 1]; i += 2
        elif a == "-crf":
            out_opts["crf"] = int(argv[i + 1]); i += 2
        elif a == "-preset":
            out_opts["preset"] = argv[i + 1]; i += 2
        elif a == "-r":
            out_opts["fps"] = float(argv[i + 1]); i += 2
        elif a == "-pix_fmt":
            out_opts["pix_fmt"] = argv[i + 1]; i += 2
        elif a == "-movflags":
            if "faststart" in argv[i + 1]:
                out_opts["faststart"] = True
            i += 2
        elif a == "-y" or a.startswith("-loglevel") or a.startswith("-hide") or a.startswith("-nost"):
            i += 2 if a in ("-loglevel",) else 1
        elif a == "-b:v":
            out_opts["video_bitrate"] = argv[i + 1]; i += 2
        elif a == "-b:a":
            out_opts["audio_bitrate"] = argv[i + 1]; i += 2
        elif a == "-an":
            out_opts["audio_codec"] = "none"; i += 1
        elif a == "-vn":
            out_opts["video_codec"] = "none"; i += 1
        else:
            # позиционный выходной файл
            if not a.startswith("-"):
                out_name = a
                ext = os.path.splitext(a)[1].lstrip(".").lower()
                if ext in ("mp4", "mov", "mkv", "webm", "gif", "mp3", "m4a", "wav", "ogg", "png", "jpg"):
                    out_opts["format"] = ext
                i += 1
            else:
                raise MediaFallbackError("не поддерживается конверсией: %s" % a)
    if out_name is None and output_path:
        out_name = os.path.basename(output_path)
    if out_name is None:
        raise MediaFallbackError("не найден выходной файл в argv")
    spec = {"inputs": inputs_spec, "output": {**out_opts, "name": os.path.basename(out_name)}}
    if fc:
        spec["filter_complex"] = fc
    else:
        if vf:
            spec["video_filter"] = vf
        if af:
            spec["audio_filter"] = af
    # сервисные лимиты фильтрграфа: обратные слэши запрещены (спека), ковычек нет в tools/posts
    for key in ("video_filter", "audio_filter", "filter_complex"):
        val = spec.get(key)
        if val and "\\" in val:
            raise MediaFallbackError("фильтрграф содержит обратный слэш (запрещён сервисом): %s" % key)
    return spec, alias_map
# ---------------------------------------------------------------------------
# subprocess.run-совместимая обёртка (OPE-3288)
# ---------------------------------------------------------------------------

def subprocess_run_shim(argv, cwd=None, timeout=None):
    """Замена subprocess.run(argv) для argv[0]=='ffmpeg' без локального бинаря.

    Возвращает subprocess.CompletedProcess: returncode 0/1, stderr с текстом ошибки.
    Выходной файл сервиса скачивается в путь последнего позиционного аргумента argv
    (ffmpeg CLI: единственный выход идёт последним), поэтому вызывающий код находит
    файл там же, где ожидал локальный ffmpeg."""
    import subprocess as _sp

    out = None
    for tok in reversed(argv):
        if isinstance(tok, str) and not tok.startswith("-"):
            idx = argv.index(tok)
            if idx > 0 and argv[idx - 1].startswith("-"):
                continue
            out = tok
            break
    if out is None:
        cp = _sp.CompletedProcess(argv, 1)
        cp.stderr = "media-ffmpeg: выходной файл не распознан в argv"
        return cp
    out_abs = os.path.join(cwd, out) if cwd and not os.path.isabs(out) else out
    rc = media_ffmpeg_argv(argv, inputs=None, output_path=out_abs, cwd=cwd)
    cp = _sp.CompletedProcess(argv, rc)
    cp.stderr = "" if rc == 0 else "media-ffmpeg: задание сервиса упало (см. stderr выше)"
    return cp


def patch_tail() -> str:
    """Блок, дописываемый в конец post_media_prep.py (живое дерево tools/posts).
    Подменяет _video_info (контракт OPE-2384) и заворачивает subprocess.run для
    ffmpeg-argv, только когда локального ffmpeg нет."""
    return """
# --- OPE-3288: медиасервис вместо локального ffmpeg (контейнер бота) ------
# Хвост добавлен автоматически; при наличии локального ffmpeg поведение не
# меняется вовсе (fast-path), в контейнере бота уходит в media-mcp.
try:
    import media_shim as _media_shim

    _video_info = _media_shim.video_info  # контракт _video_info OPE-2384 сохранён

    if not _media_shim.ffmpeg_available():
        _subprocess_run_orig = subprocess.run

        def _subprocess_run(argv, *a, **kw):
            if isinstance(argv, (list, tuple)) and argv and argv[0] == "ffmpeg":
                return _media_shim.subprocess_run_shim(list(argv), cwd=kw.get("cwd"),
                                                       timeout=kw.get("timeout"))
            return _subprocess_run_orig(argv, *a, **kw)

        subprocess.run = _subprocess_run
except Exception:
    pass  # среда без медиасервиса работает как раньше
"""
