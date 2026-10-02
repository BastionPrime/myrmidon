# Путь OCR: PDF в текст в workspace бота

> English version: [ocr.md](ocr.md)

Путь OCR превращает PDF, полученный ботом, — вложение письма, файл, скачанный
через [браузерный мост](bridge-extension.ru.md), документ из его workspace — в
текст, с которым бот может работать, плюс структурную выжимку тендерной
документации (требования, сроки, позиции). Распознанный текст идёт в workspace;
журнал активности видит только метаданные.

## Что вызывает бот

Инструмент, видимый боту, — **`ocr.pdf`**, обслуживаемый по JSON-RPC на
конечной точке компании `POST /api/myrmidon/companies/:companyId/ocr/mcp`
(`initialize`, `tools/list`, `tools/call`; `server/src/myrmidon/ocr/`).

Ввод: `name` (имя файла — оно называет файл в workspace и запись в журнале),
`base64` (сам PDF; префикс `data:` URL допустим), необязательные `origin`
(`mail_attachment` / `browser_download`) и `sourceId`.

Вывод: `text`, `pages`, `structure`, `metadata`. Неудачное распознавание
возвращается как **результат инструмента с `isError`** и стабильным кодом в
`structuredContent.code` — не как ошибка транспорта, — чтобы бот мог решить
(взять другой файл, сообщить оператору) вместо слепого повтора.

Коды ошибок: `ocr_disabled`, `not_a_pdf`, `document_too_large`,
`too_many_pages`, `empty_document`, `backend_failed`, `workspace_write_failed`,
`journal_failed`, `invalid_tool_input`.

## Куда ложится текст

Полный текст возвращается в результате инструмента. Когда задана
`MYRMIDON_OCR_WORKSPACE_DIR`, копия пишется туда как `<name>-<hash>.txt`
(права 0600; хэш считается по имени и содержимому, поэтому второй документ не
затирает первый). Без настройки текст живёт только в ответе инструмента —
контейнерный бот пишет его в свой workspace сам.

Журнал (`activity_log`) получает одну строку только с метаданными: `name`,
`sizeBytes`, `pages`, `origin`, `sourceId`, `backend`, `chars`, `truncated`.
**Текст и байты PDF в журнал не попадают.**

## Бэкенды

Выбираются `MYRMIDON_OCR_BACKEND`:

- `ragflow` (по умолчанию) — MCP JSON-RPC `tools/call` к серверу RAGFlow
  (парсинг DeepDOC); `MYRMIDON_OCR_MODEL` называет инструмент парсинга
  (по умолчанию `parse_document`).
- `litellm` — OpenAI-совместимый chat-запрос к общему шлюзу с PDF как файловой
  частью; `MYRMIDON_OCR_MODEL` называет модель и **обязателен** — без него
  профиль не собирается, и вызовы отвечают `ocr_disabled`.

Неизвестное значение бэкенда откатывается на `ragflow` (опечатка не должна
закрывать путь).

## Лимиты и выключатели

Все лимиты отказывают **до** обращения к бэкенду — а отказ по размеру происходит
до раскодирования base64:

| Настройка | По умолчанию | Отказ |
|---|---|---|
| `MYRMIDON_OCR_BASE_URL` | не задана | не задана — путь закрыт: каждый вызов отвечает `ocr_disabled`, ни один запрос не уходит |
| `MYRMIDON_OCR_KEY_SECRET` | не задана | имя секрета компании с ключом контура; не задана — путь закрыт |
| `MYRMIDON_OCR_MAX_BYTES` | 32 МиБ | `document_too_large` |
| `MYRMIDON_OCR_MAX_PAGES` | 500 | `too_many_pages` |
| `MYRMIDON_OCR_MAX_CHARS` | 2 000 000 | остаток отрезается; `metadata.truncated: true` |
| `MYRMIDON_OCR_TIMEOUT_SEC` | 120 | таймаут запроса к бэкенду (5–600) |

Полная таблица и заметки оператора: [../SETTINGS.ru.md](../SETTINGS.ru.md). Ключ
контура OCR — **секрет компании**, названный `MYRMIDON_OCR_KEY_SECRET`; значение
читается на каждый вызов для компании — владелицы задачи и не появляется в
настройке, логах и журнале.

## Связанные документы

- [../SETTINGS.ru.md](../SETTINGS.ru.md) — каждая переменная `MYRMIDON_OCR_*`.
- [bridge-extension.ru.md](bridge-extension.ru.md) — как PDF приходит через
  браузерный мост.
- [cloud-files-connector.ru.md](cloud-files-connector.ru.md) — вложения писем
  как источник для OCR.
