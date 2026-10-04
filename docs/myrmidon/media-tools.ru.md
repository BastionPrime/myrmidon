# Общие медиа- и офисные инструменты для контейнерных ботов

> English version: [media-tools.md](media-tools.md)

В образе бота нет ffmpeg, LibreOffice, poppler, Tesseract. Вместо того чтобы класть их в каждый
контейнер, они вынесены в отдельные сервисы, а боту отдан один MCP-адрес. Код —
`tools/media-mcp/`, образы собирает `.github/workflows/myrmidon-media-tools.yml`.

```
бот ──MCP/HTTP──▶ media-mcp (фасад) ──▶ media-worker  (ffmpeg, ffprobe, pdftoppm)
  сеть myrmidon-bots      │        ├──▶ gotenberg     (LibreOffice, Chromium; готовый образ по digest)
                          │        └──▶ tika          (Tika full + Tesseract rus+eng)
                          └─ сеть media-backend: internal, наружу и к ботам выхода нет
```

## Инструменты

| Инструмент | Что делает |
|---|---|
| `file_put`, `file_get`, `file_list`, `file_delete` | личное хранилище бота (квота, срок хранения) |
| `media_probe` | ffprobe: длительность, потоки, кодеки |
| `audio_loudness` | громкость EBU R128 (LUFS, LRA, пик) |
| `ffmpeg_submit`, `job_status`, `job_cancel` | монтаж и перекодирование очередью; спек с белыми списками, не сырые аргументы |
| `audio_split` | режет длинную запись на куски wav 16 кГц моно со смещениями `startMs` (задание в очереди, как ffmpeg) |
| `stt_transcribe` | речь → текст + сегменты через STT-шлюз, синхронно |
| `image_transform` | масштаб, обрезка, поворот, формат (jpg/png/webp) |
| `pdf_to_images` | страницы PDF в png/jpeg (poppler), до 40 за вызов |
| `office_to_pdf` | docx/xlsx/pptx/odt/… в PDF (Gotenberg, LibreOffice) |
| `html_to_pdf` | HTML-строка и локальные ассеты в PDF (Chromium без JavaScript, грузятся только свои ассеты) |
| `extract_text` | текст документа или OCR картинки/скана (Tika, Tesseract rus+eng) |
| `dwg_convert` | DWG/DXF → DXF, SVG, PDF (LibreDWG + ezdxf), см. ниже |

Произвольные node- и shell-скрипты сервис не выполняет. Живые страницы рендерит браузерный MCP,
режима URL у `html_to_pdf` нет.

## Файлы

- Мелкие: base64 в вызове (`{"base64": "...", "name": "a.docx"}` или `file_put`); запрос до 24 МиБ,
  inline-результат до 4 МиБ.
- Крупные: `curl -T видео.mp4 "http://media-mcp:8080/v1/files?name=видео.mp4"` и
  `curl -o out.mp4 "http://media-mcp:8080/v1/files/<file_id>"`, идентичность та же, что у MCP-вызова.
- У каждого бота свой каталог; идентификатор файла проверяется, чужой файл открыть нельзя.
  Квота на бота 4 ГиБ, файл до 512 МиБ, хранение 48 ч.
- В квоту входит всё, что бот держит на диске: файлы, недозагруженные файлы и каталоги заданий
  (`jobs/<id>/in`, `out`). Результат задания ограничен остатком квоты (и по размеру файла, и по сумме
  всех файлов задания); превысил, задание падает, `in/` и `out/` удаляются сразу, а не по сроку хранения.
- Общий потолок на все боты: `MEDIA_SPOOL_MAX_BYTES` (по умолчанию 64 ГиБ) и
  `MEDIA_SPOOL_MIN_FREE_BYTES` (2 ГиБ свободного места на файловой системе spool); сверх этого
  новые данные не принимаются. Второй предел работает, только если spool лежит на своей
  файловой системе ограниченного размера, а не на корневом диске хоста (см. «Развёртывание»).
- `extract_text` и `office_to_pdf` принимают файл до 64 МиБ (`MEDIA_MAX_CONVERT_BYTES`); файл
  отдаётся конвертеру потоком. Ответ Tika читается только до `max_chars` (`truncated: true`, `chars`
  тогда нижняя граница), PDF от Gotenberg пишется потоком в файл и обрывается на 128 МиБ
  (`MEDIA_MAX_PDF_BYTES`) или на остатке квоты.

## DWG/DXF (dwg_convert)

`dwg_convert` повторяет хостовые dwg2dxf/dwg2SVG как инструмент медиасервиса (в образе бота CAD-утилит нет,
отдельный образ бота запрещён CONVENTIONS §8). Вход — `.dwg` или `.dxf`, выход — DXF, SVG или PDF:

- `kind=dxf`: DXF пишется LibreDWG (DWG-вход) или ezdxf (DXF-вход, версия `dxf_version` R12…R2018,
  по умолчанию R2010). Замечание: LibreDWG пишет DXF входной ревизии (до r2013), `dxf_version`
  действует только на DXF-вход.
- `kind=svg`: рендер ezdxf (SVGBackend); `width`/`height` (по умолчанию 1600×1200) — размер страницы.
- `kind=pdf`: рендер через SVG + LibreOffice, если LibreOffice есть в образе воркера; в базовом образе
  его нет — воркер честно откажет («ask for svg»), PDF-путь оставлен для образа с LibreOffice.
- Результат — обычный файл в хранилище бота (квота и срок хранения те же), при `inline=true`
  маленькие файлы возвращаются base64.
- Инструмент синхронный (таймаут 300 с), лимиты вывода — как у остальных заданий воркера.

Проверка после выкладки: конвертация тестового DWG в DXF и SVG, округление DXF→DXF со сменой версии.

## Распознавание речи (audio_split, stt_transcribe)

Два инструмента обслуживают записи встреч. `audio_split` — задание в очереди (kind
`audio_split`, та же очередь, что у ffmpeg): ffmpeg segment muxer режет вход на куски
wav 16 кГц моно `pcm_s16le` (`chunk_%06d.wav`); `chunk_sec` — 5..1800 с
(по умолчанию 300), а обязательный предел `-t` ограничивает прогон величиной
`chunk_sec × max_parts` (не больше 600 частей) и остатком квоты бота. Когда задание
завершено, `job_status` перечисляет каждый кусок как файл в хранилище бота со
смещением `startMs` от начала исходной записи. `stt_transcribe` синхронный: шлёт
файл multipart-запросом на `${MEDIA_STT_BASE_URL}/v1/audio/transcriptions` с моделью
(и необязательным `language` вида `ru` или `en-US`) и нормализует ответ к
`{text, segments: [{speaker, startMs, endMs}]}` — ответы в секундах и
миллисекундах и сегменты только с длительностью допускаются, сегменты сверх 4000
отбрасываются, говорящие не выдумываются. Аргумент `start_ms` сдвигает таймкоды
сегментов куска обратно в исходную запись, поэтому связка такая: `audio_split` →
один `stt_transcribe` на кусок с его `startMs` как `start_ms`.

Настройки (переменные окружения сервиса, как остальные в этом разделе):
`MEDIA_STT_BASE_URL` (по умолчанию `http://stt-gateway:8000`), `MEDIA_STT_API_KEY` /
`MEDIA_STT_API_KEY_FILE` (docker-секрет; ключ попадает только в заголовок
`Authorization`, никогда — в ответы или логи), `MEDIA_STT_DEFAULT_MODEL`
(по умолчанию `whisper-large-v3`), `MEDIA_STT_MAX_MULTIPART_BYTES`
(по умолчанию 32 МиБ — файл больше отклоняется с указанием на `audio_split`),
`MEDIA_STT_MAX_RESPONSE_BYTES` (по умолчанию 64 МиБ). Задаются при старте сервиса;
runtime-переопределения на компанию нет — та сторона живёт в серверном ядре
VOICE-STT (`MYRMIDON_STT_*`, см. SETTINGS.md).

При выключенной функции: инструменты остаются зарегистрированными, но вызов
отказывается чисто — бот, у которого их нет в списке `tools`, получает обычный
отказ белого списка, а без `MEDIA_STT_API_KEY` вызов уходит без заголовка
`Authorization`, и ответ шлюза возвращается как ошибка. Стабильные ответы об
ошибках, которые видит бот:
`model <name> is not registered on the transcription gateway` (HTTP 404 от шлюза),
`transcription gateway refused the request (HTTP <code>)`,
`transcription gateway unavailable (<error class>)` при сбое сети,
`audio larger than <N> MiB for transcription; split it first (audio_split)`,
`transcription response larger than <N> MiB`,
`transcription gateway returned a non-JSON answer`,
`chunk_sec must be in [5.0, 1800.0] seconds`,
`too many active jobs (limit 3); wait or job_cancel`.

## Аутентификация бота

`config/bots.json` (образец — `tools/media-mcp/config.example.json`), ключ — имя бота:

- `peer_host`: имя контейнера бота в docker-сети (`myrmidon-bot-<botKey>`); фасад сверяет с ним
  адрес источника. Работает при общей записи `MYRMIDON_BOT_MCP_SERVERS` с `"noAuth": true`.
  Обращаться нужно по имени `media-mcp` внутри сети ботов: адрес шлюза хоста или опубликованный
  порт скрывают источник, и боты станут неразличимы.
- `token_sha256`: собственный bearer у бота (в конфиге только хеш). Общая запись
  `MYRMIDON_BOT_MCP_SERVERS` даёт всем один токен, поэтому персональный токен пока требует
  отдельной записи на бота; можно задать вместе с `peer_host`, тогда нужны оба условия.
- `tools`: какие инструменты открыты боту; `quota_bytes`, `rate_per_min`: свои пределы.

## Развёртывание

1. Образы: `ghcr.io/itkadr-git/myrmidon-media-mcp`, `…-media-worker`, `…-media-tika` (теги `main`,
   `sha-…`, `X.Y.Z`); Gotenberg закреплён по digest в `compose.example.yml`.
2. Создать `config/bots.json` и `secrets/worker_token` (случайная строка от 32 знаков). Том `spool`
   именованный: в образах каталог `/spool` создан и принадлежит пользователю 10001, Docker при первом
   использовании копирует владельца из образа, ничего готовить не нужно. Если том привязывается к
   каталогу хоста (`driver_opts`, см. `compose.example.yml`), каталог нужно выдать
   `chown 10001:10001`. Без ограничения размера том может занять весь диск: положите spool
   на отдельную файловую систему ограниченного размера (раздел, LV или смонтированный
   образ) и выставьте `MEDIA_SPOOL_MAX_BYTES` меньше её размера.
3. `docker compose -f tools/media-mcp/compose.example.yml up -d` (сеть `myrmidon-bots` уже есть).
4. Приёмка: `media_probe` на коротком ролике; `ffmpeg_submit` со `subtitles`; `extract_text` на
   скане с русским текстом; `office_to_pdf` на docx; `.xlsm` с автозапуском макроса не оставляет
   следов; бот B не открывает файл бота A; лишний запрос выше `rate_per_min` получает 429.
   Для `dwg_convert`: тестовый DWG → DXF и → SVG от имени бота с инструментом в `tools`.
   Для STT: `audio_split` длинной записи, затем `stt_transcribe` одного куска — ответ вида
   `{text, segments}`.
5. Добавить `{"name":"media","url":"http://media-mcp:8080/mcp","noAuth":true}` в
   `MYRMIDON_BOT_MCP_SERVERS` (перезапустит контейнеры ботов).

Пределы памяти в compose: фасад 512 МБ, воркер 3 ГБ, Gotenberg 2 ГБ, Tika 1,5 ГБ.

## Границы изоляции (что сервис не обещает)

- Сеть `media-backend` внутренняя: наружу выхода нет, но внутри неё сервисы видят друг друга. Поэтому
  «Chromium без сети» неверно. Chromium в Gotenberg запущен с `--chromium-disable-javascript=true`
  и `--chromium-allow-list=^(file:///tmp/|data:)`: грузятся только файлы запроса и `data:`,
  запросы на `http(s)` к другим сервисам сети отклоняются.
- `/tmp` Gotenberg общий для всех его запросов: файлы одного запроса лежат рядом с файлами другого,
  пока идёт конвертация. Разделения по ботам внутри Gotenberg нет, запросы к нему идут через два слота фасада.
- Фильтры ffmpeg: из строки фильтра запрещён обратный слеш (ffmpeg раскрывает экранирование дважды,
  через него можно добавить опцию `filename=` и открыть чужой файл или адрес), `force_style`
  принимает только `A-Za-z0-9=,&.- ` и пробел.
- Воркер (ffmpeg, poppler) работает под одним пользователем и видит весь spool, то есть каталоги всех
  ботов. Уязвимость в разборе медиа даёт доступ к файлам всех ботов на срок хранения. Раздельные
  воркеры по ботам сейчас не сделаны.
- Доступ к MCP-адресу проверяет заголовок Host (`MEDIA_ALLOWED_HOSTS`, по умолчанию
  `media-mcp,media-mcp:8080`); если боты ходят по другому имени, добавьте его.

## Скрипты на стороне бота

Готовые клиентские модули для скриптов, которые раньше звали локальный ffmpeg/ffprobe,
лежат в `tools/media-mcp/bot-scripts/`: stdlib-only клиент MCP (`media_client.py`),
drop-in слой `media_shim.py` (контракты `video_info`/`CompletedProcess`, fast-path на
локальном ffmpeg) и инструкция применения в живом дереве ботов (`APPLY.md`).
Скрипт бота получает адрес и токен из `MEDIA_TOOLS_URL`/`MEDIA_TOOLS_TOKEN`; токен —
персональная запись бота в `config/bots.json` (см. «Аутентификация бота»).

## Настройки фасада и воркера

Переменные окружения сервиса (не сервера доски): `MEDIA_BOTS_FILE`, `MEDIA_DATA_DIR`,
`MEDIA_WORKER_TOKEN`/`MEDIA_WORKER_TOKEN_FILE`, `MEDIA_GOTENBERG_URL`, `MEDIA_TIKA_URL`,
`MEDIA_WORKER_URL`, `MEDIA_MAX_REQUEST_BYTES`, `MEDIA_MAX_INLINE_RESULT_BYTES`,
`MEDIA_MAX_FILE_BYTES`, `MEDIA_BOT_QUOTA_BYTES`, `MEDIA_SPOOL_MAX_BYTES`, `MEDIA_SPOOL_MIN_FREE_BYTES`,
`MEDIA_MAX_CONVERT_BYTES`, `MEDIA_MAX_PDF_BYTES`, `MEDIA_ALLOWED_HOSTS`, `MEDIA_FILE_TTL_HOURS`,
`MEDIA_MAX_ACTIVE_JOBS_PER_BOT`, `MEDIA_RATE_PER_MIN`, `MEDIA_MAX_TEXT_CHARS`,
`MEDIA_BACKEND_TIMEOUT_S`, `WORKER_CONCURRENCY`. Блок STT (`MEDIA_STT_*`) описан
в разделе «Распознавание речи» выше. Код вендора не затрагивается, поэтому строк в
`SETTINGS.md` и `DIVERGENCE.md` нет.
