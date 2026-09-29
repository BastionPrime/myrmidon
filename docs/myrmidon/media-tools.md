# Общие медиа- и офисные инструменты для контейнерных ботов

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
| `image_transform` | масштаб, обрезка, поворот, формат (jpg/png/webp) |
| `pdf_to_images` | страницы PDF в png/jpeg (poppler), до 40 за вызов |
| `office_to_pdf` | docx/xlsx/pptx/odt/… в PDF (Gotenberg, LibreOffice) |
| `html_to_pdf` | HTML-строка и локальные ассеты в PDF (Chromium без сети) |
| `extract_text` | текст документа или OCR картинки/скана (Tika, Tesseract rus+eng) |

Произвольные node- и shell-скрипты сервис не выполняет. Живые страницы рендерит браузерный MCP,
режима URL у `html_to_pdf` нет.

## Файлы

- Мелкие: base64 в вызове (`{"base64": "...", "name": "a.docx"}` или `file_put`); запрос до 24 МиБ,
  inline-результат до 4 МиБ.
- Крупные: `curl -T видео.mp4 "http://media-mcp:8080/v1/files?name=видео.mp4"` и
  `curl -o out.mp4 "http://media-mcp:8080/v1/files/<file_id>"`, идентичность та же, что у MCP-вызова.
- У каждого бота свой каталог; идентификатор файла проверяется, чужой файл открыть нельзя.
  Квота на бота 4 ГиБ, файл до 512 МиБ, хранение 48 ч.

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
2. Создать `config/bots.json`, `secrets/worker_token` (случайная строка от 32 знаков), каталог
   для тома `spool` доступен пользователю 10001.
3. `docker compose -f tools/media-mcp/compose.example.yml up -d` (сеть `myrmidon-bots` уже есть).
4. Приёмка: `media_probe` на коротком ролике; `ffmpeg_submit` со `subtitles`; `extract_text` на
   скане с русским текстом; `office_to_pdf` на docx; `.xlsm` с автозапуском макроса не оставляет
   следов; бот B не открывает файл бота A; лишний запрос выше `rate_per_min` получает 429.
5. Добавить `{"name":"media","url":"http://media-mcp:8080/mcp","noAuth":true}` в
   `MYRMIDON_BOT_MCP_SERVERS` (перезапустит контейнеры ботов).

Пределы памяти в compose: фасад 512 МБ, воркер 3 ГБ, Gotenberg 2 ГБ, Tika 1,5 ГБ.

## Настройки фасада и воркера

Переменные окружения сервиса (не сервера доски): `MEDIA_BOTS_FILE`, `MEDIA_DATA_DIR`,
`MEDIA_WORKER_TOKEN`/`MEDIA_WORKER_TOKEN_FILE`, `MEDIA_GOTENBERG_URL`, `MEDIA_TIKA_URL`,
`MEDIA_WORKER_URL`, `MEDIA_MAX_REQUEST_BYTES`, `MEDIA_MAX_INLINE_RESULT_BYTES`,
`MEDIA_MAX_FILE_BYTES`, `MEDIA_BOT_QUOTA_BYTES`, `MEDIA_FILE_TTL_HOURS`,
`MEDIA_MAX_ACTIVE_JOBS_PER_BOT`, `MEDIA_RATE_PER_MIN`, `MEDIA_MAX_TEXT_CHARS`,
`MEDIA_BACKEND_TIMEOUT_S`, `WORKER_CONCURRENCY`. Код вендора не затрагивается, поэтому строк в
`SETTINGS.md` и `DIVERGENCE.md` нет.
