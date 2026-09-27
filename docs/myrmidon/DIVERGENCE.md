# Реестр отличий Myrmidon от Paperclip

**База:** Paperclip `v2026.916.1` (коммит `d554c47`). Текущая база — самый свежий тег вендора,
достижимый из `main`: `git tag --merged main 'v20*' --sort=-v:refname | head -1`.

**Правило.** Каждое наше изменение в файлах вендора и каждый перенесённый коммит вендора — одна
строка, добавленная в том же PR, что и изменение. Трек пишет только в свой раздел: так PR разных
треков не конфликтуют в этом файле. Бот еженедельного переноса (R2) читает этот реестр и по
колонке «Как снимать» предлагает убрать то, что вендор уже закрыл.

**Колонки:**

- **ID** — номер функции (`P1`, `S2`…) или `vendor:<короткий sha>` для перенесённого коммита
  вендора.
- **Что меняем** — одной фразой.
- **Файлы вендора** — какие файлы вендора правим. Наши новые файлы — через `+`.
- **Причина** — зачем. Номер issue или PR вендора, если есть.
- **Тест-сторож** — путь к тесту, который краснеет на коде вендора.
- **Как снимать** — условие (например, «вендор влил #N» или «никогда, наше поведение») и
  способ: удалить куски с меткой `myrmidon(<ID>)`, что сделать с тестом.
- **PR** — ссылка.

## Трек 1 — платформа

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|

## Трек 2 — ядро побудок и прогонов

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| vendor:c221589b | Перенос коммита вендора: прокси процесса песочницы закрывает вход и выходит после завершения удалённого процесса. Предпосылка теста #13793 | `packages/adapter-utils/src/execution-target.ts` | Вендорский PR #13777; тест #13793 опирается на его помощник `runProxyWithInput(…, keepStdinOpen)` | `packages/adapter-utils/src/execution-target-sandbox.test.ts` | Уходит сам при переносе тега вендора, который содержит этот коммит | [#31](https://github.com/itkadr-git/myrmidon/pull/31) |
| vendor:4b8ec588f | Перенос коммита вендора: контекст побудки больше не дублируется в окружении адаптеров (`PAPERCLIP_WAKE_PAYLOAD_JSON` и др.) | `packages/adapter-utils/src/{server-utils,acpx-engine/execute}.ts`, `packages/adapters/{claude,codex,cursor,gemini,grok,kimi,opencode,pi}-local/src/server/execute.ts`, `packages/adapters/{hermes,cursor-cloud}/src/server/execute.ts`, документы | Вендорский PR #13891; часть P3 (`spawn E2BIG` на длинной истории) | `packages/adapter-utils/src/server-utils.test.ts`, `packages/adapter-utils/src/acpx-engine/execute.test.ts`, `packages/adapters/hermes/src/server/execute.onspawn.test.ts` | Уходит сам при переносе тега вендора, который содержит этот коммит | [#31](https://github.com/itkadr-git/myrmidon/pull/31) |
| vendor:8326e33ad | Перенос коммита вендора: большой запуск процесса в песочнице идёт через приватный файл, а не аргументами | `packages/adapter-utils/src/execution-target.ts`, `doc/acp-run-lifecycle.md` | Вендорский PR #13793; часть P3 | `packages/adapter-utils/src/execution-target-sandbox.test.ts` | Уходит сам при переносе тега вендора, который содержит этот коммит | [#31](https://github.com/itkadr-git/myrmidon/pull/31) |

## Трек 3 — шлюз инструментов и адаптер Hermes

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| P10 | GET с `Accept: text/event-stream` на оба GET-обработчика MCP-шлюза получает 405 и `Allow: POST`; обычный GET — вендорская визитка | `server/src/routes/tool-gateway.ts` + `server/src/myrmidon/tool-gateway-sse.ts` | Спецификация MCP Streamable HTTP: без SSE-потока сервер обязан ответить 405; клиент MCP, открывающий фоновый GET-поток, на 200 с JSON терял инструменты. У вендора открыт PR #11433 (безусловный 405) | `server/src/__tests__/tool-gateway-sse.myrmidon.test.ts` | Когда вендор отвечает 405 на SSE GET (например, влит #11433): удалить куски `myrmidon(P10)`, наш модуль и тест | [#27](https://github.com/itkadr-git/myrmidon/pull/27) |
| P5 | Агентский checkout прогоном без контекста задачи получает 403 `cross_issue_influence_run_context_required` до захвата блокировки; 409 конфликтов блокировки содержат `checkoutRunStatus` (`running`/`terminal`/`missing`) | `server/src/routes/issues.ts`, `server/src/services/issues.ts`, `server/src/services/cross-issue-influence-limit.ts` (экспорт `readRunSourceIssueId`), `server/src/__tests__/issue-stale-execution-lock-routes.test.ts` (два случая: у прогона-претендента есть контекст задачи) + `server/src/myrmidon/issue-checkout-guard.ts` | Прогон без контекста брал блокировку, а писать в задачу не мог: «слепая блокировка» до конца прогона. У вендора гейта на checkout нет | `server/src/__tests__/issue-checkout-guard.myrmidon.test.ts` | Никогда, пока вендор не проверяет контекст прогона на checkout; тогда удалить куски `myrmidon(P5)`, наш модуль и тест, вернуть два случая вендорского теста | [#34](https://github.com/itkadr-git/myrmidon/pull/34) |
| P4 | `hermes_local` читает `ctx.runtimeMcp`: временный `HERMES_HOME` на прогон (ссылки на профиль, своя `config.yaml` 0600 с серверами прогона, удаляется после выхода процесса), имена серверов дописываются в `-t`; промпт через stdin (`--query-file -`); размер конверта argv+env проверяется до запуска (`spawn_envelope_too_large`); подмена origin адреса шлюза — только по настройке | `packages/adapters/hermes/src/server/execute.ts`, `packages/adapters/hermes/src/server/execute.onspawn.test.ts` (промпт ищется в stdin, а не в argv) + `packages/adapters/hermes/src/server/myrmidon-runtime-mcp.ts` | Адаптер Hermes не читал `runtimeMcp`, инструменты подключений не доходили до агента; длинный промпт в argv падал с `E2BIG`. У вендора `runtimeMcp` в адаптере Hermes нет | `packages/adapters/hermes/src/server/execute.runtime-mcp.myrmidon.test.ts` | Когда вендор начнёт передавать `runtimeMcp` и промпт через stdin в адаптере Hermes: удалить куски `myrmidon(P4)`, наш модуль и тест, вернуть строку вендорского теста | [#35](https://github.com/itkadr-git/myrmidon/pull/35) |

## Трек 4 — чаты и навыки

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| vendor:6d0342868 | Представления чата агента с синтетическим id `chat:<uuid>` не шлют запросы коннекторов задачи; маршруты отвечают 400 на id не-UUID вместо 500 | `server/src/routes/chat-channels.ts`, `server/src/routes/email.ts`, `server/src/routes/openapi.ts`, `ui/src/components/EmailTaskActivity.tsx`, `ui/src/components/chat/ExternallyConnectedTaskBanner.tsx` + тесты вендора | P7b, вендорский #13654: открытие чата агента давало 500 (`invalid input syntax for type uuid`) | `server/src/__tests__/task-connector-read-routes.test.ts`, `ui/src/components/task-only-connector-queries.test.tsx` | Уходит сам при переносе тега вендора, который содержит этот коммит | [#28](https://github.com/itkadr-git/myrmidon/pull/28) |
| P7 | Отправитель в Telegram получает отдельное сообщение в тот же тред: какие вложения не импортированы и почему (до 3 файлов, остальные — «and N more»); повтор доставки не дублирует его | `server/src/services/chat-channels.ts` (учёт имён в `ingestAttachments`, постановка уведомления в обеих ветках приёма, отправка после обработки побудки), `server/src/__tests__/chat-channels.integration.test.ts` (один новый `it` и одна проверка в соседнем) + `server/src/myrmidon/chat-attachment-omission.ts` | Вложение, отброшенное при импорте, терялось молча: отправитель видел обычное «принято» | `server/src/__tests__/chat-channels.integration.test.ts` («names an omitted Telegram attachment…»), `server/src/__tests__/chat-attachment-omission.myrmidon.test.ts` | Когда вендор заведёт своё уведомление о пропущенных входящих вложениях: удалить куски с меткой `myrmidon(P7)`, модуль и тесты | [#36](https://github.com/itkadr-git/myrmidon/pull/36) |
| P8 | Потолок скачивания файла Telegram задаётся переменной `MYRMIDON_TELEGRAM_FILE_LIMIT_BYTES`; без неё — вендорские 25 МБ | `patches/@chat-adapter__telegram@4.39.0.patch` (две строки в вендорском pnpm-патче), `pnpm-lock.yaml` (хэш патча) | Свой Bot API отдаёт файлы до 2 ГБ, а вендорский патч адаптера режет всё больше 25 МБ | `server/src/__tests__/telegram-file-limit.myrmidon.test.ts` | Никогда, пока вендор зажимает предел константой. Снимать: вернуть две строки с меткой `myrmidon(P8)` в патче к `TELEGRAM_FILE_LIMIT`, `pnpm install`, удалить тест. При обновлении версии адаптера — перенести две строки в новый патч | [#30](https://github.com/itkadr-git/myrmidon/pull/30) |

## Трек 5 — эксплуатация

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|

## Трек 6 — безопасность и модели

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| S2 | Процесс прогона наследует из окружения сервера только разрешённые переменные; `inheritProcessEnv` возвращает поведение вендора | `packages/adapter-utils/src/server-utils.ts` (`runChildProcess`), `packages/adapter-utils/src/execution-target.ts` (опция `inheritProcessEnv`) + `packages/adapter-utils/src/myrmidon-run-env.ts` | Прогон получал `DATABASE_URL`, `BETTER_AUTH_SECRET`, облачные ключи сервера; идея из вендорского #10052 | `packages/adapter-utils/src/server-utils-run-env.myrmidon.test.ts` | Никогда, наше поведение. Если вендор введёт свой белый список — сверить, удалить куски `myrmidon(S2)` и модуль, тест переписать на вендорский механизм | S2-1 |

## Известные пробелы

Что сознательно не сделано и где это может проявиться. Одна строка на пункт, раздел общий: сюда
пишут редко.

| ID | Пробел | Где проявится | Когда закрывать |
|---|---|---|---|
