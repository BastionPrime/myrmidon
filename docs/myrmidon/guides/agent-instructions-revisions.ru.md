# Инструкции агента: история ревизий и откат

> English version: [agent-instructions-revisions.md](agent-instructions-revisions.md)

Каждое изменение бандла инструкций агента — запись файла, удаление файла,
патч бандла — снимается в таблицу `agent_instructions_revisions` (миграция
0288). Снимок хранит весь бандл (все файлы с содержимым, entry-файл, источник
изменения, автор), а не дельту. Любую прежнюю ревизию можно восстановить через API; сам откат становится новой
ревизией, поэтому история остаётся append-only.

## Что предлагает API

Все маршруты живут под `/api/agents/:id/instructions-revisions`:

| Маршрут | Что делает |
|---|---|
| `GET /api/agents/:id/instructions-revisions` | Список ревизий агента, новые сверху. Размер страницы по умолчанию — 50. |
| `GET /api/agents/:id/instructions-revisions/:revisionId` | Сводка одной ревизии (номер, entry-файл, изменённые файлы, источник, автор, дата). |
| `GET /api/agents/:id/instructions-revisions/:revisionId/files` | Полный набор файлов ревизии (путь + содержимое). |
| `POST /api/agents/:id/instructions-revisions/:revisionId/rollback` | Восстанавливает файлы ревизии в бандл агента. |

Сводка (`revisionSummary`) несёт поля: `id`, `revisionNumber`, `entryFile`,
`fileCount`, `changedFiles`, `source`, `createdByAgentId`, `createdByUserId`,
`rolledBackFromRevisionId`, `createdAt`.

## Как записывается ревизия

Запись встроена в вендорские маршруты инструкций
(`server/src/routes/agents.ts`, метка `myrmidon(H2)`):

- `PUT /api/agents/:id/instructions-bundle/file` → источник
  `instructions_bundle_file_put`
- `DELETE /api/agents/:id/instructions-bundle/file` → источник
  `instructions_bundle_file_delete`
- `PATCH /api/agents/:id/instructions-bundle` → источник
  `instructions_bundle_patch`
- откат → источник `rollback`

Номера ревизий выделяются в транзакции с блокировкой строки агента
(`select ... for update`), поэтому два одновременных изменения не займут один
номер. Пустой набор файлов не записывается. Ошибка записи логируется
предупреждением и не ломает само редактирование.

## Как работает откат

`POST .../rollback` восстанавливает весь снимок через вендорский
`materializeManagedBundle` (только managed-режим). Он перезаписывает файлы
бандла на диске и исправляет `adapterConfig` агента на managed-корень. Затем
сам откат записывается как новая ревизия с `source: "rollback"` и
`rolledBackFromRevisionId`, указывающим на восстановленную ревизию, — история
остаётся append-only, и откат обратим.

Внешний бандл откатить нельзя: маршрут отвечает 422 с подсказкой сначала
переключить агента на managed-бандл.

Доставка инструкций в прогон не меняется: бандл читается с диска каждый
прогон (W2a/G4), поэтому восстановленная ревизия доезжает до следующего
прогона без изменений в доставке.

## Права

Маршруты следуют тем же правилам, что вендорские маршруты бандла инструкций:

- **Чтение** — любой вызывающий с доступом на чтение компании агента. Агент
  чужой компании неотличим от отсутствующего (404).
- **Откат** — тот же protected-change гейт, что у вендорской записи бандла:
  board-актёры с грантом `agents:configure` проходят напрямую; агентские
  актёры откатываются на change-consent гейт. Когда бандл внешний, вызывающий
  должен быть instance admin.

## Журнал активности

Каждый откат пишет строку в журнал активности компании с действием
`agent.instructions_revision_rollback`. В строке — id и номер восстановленной
ревизии, id новой ревизии и число файлов.
