# Bot-side media scripts

Клиентская часть медиасервиса для скриптов ботов, которые раньше звали локальный
ffmpeg/ffprobe (`post_media_prep.py`, `media_look.py` в живом дереве bbq-workspace,
`tools/posts`). В образе бота ffmpeg нет — эти модули переводят вызовы на
media-mcp (`docs/myrmidon/media-tools.md`), не меняя вызывающий код.

- `media_client.py` — stdlib-only клиент MCP media-tools (probe, loudness,
  ffmpeg_submit + job_status-поллинг, REST `/v1/files` для больших файлов).
- `media_shim.py` — drop-in слой: `video_info()` (контракт `_video_info`),
  `run_ffmpeg()`, `subprocess_run_shim()` (контракт `subprocess.CompletedProcess`)
  и `patch_tail()` — блок-хвост для `post_media_prep.py`. Локальный ffmpeg
  остаётся fast-path: среда с бинарником ведёт себя как раньше.
- `test_media_client.py`, `test_media_shim_full.py` — проверки против живого
  media-mcp (стенд или прод), запускаются из каталога с модулями.
- `shorts_gate.py` — модель критерия приёмки: Shorts 9:16 ≤58 с через сервис
  из контейнера бота без ffmpeg.
- `patch_tail.txt` — готовый хвост к `post_media_prep.py` (генерируется
  `media_shim.patch_tail()`).
- `APPLY-OPE3288.md` — инструкция применения в живом дереве bbq-workspace
  (переменные бота `MEDIA_TOOLS_URL`/`MEDIA_TOOLS_TOKEN`, точки патча,
  проверки после применения).

Сборка образов сервиса эти файлы не затрагивает (`COPY src`, `COPY tests` —
только Python-пакет фасада/воркера), но workflow `myrmidon-media-tools.yml`
среагирует на изменения в `tools/media-mcp/**` и прогонит юнит-тесты сервиса.
