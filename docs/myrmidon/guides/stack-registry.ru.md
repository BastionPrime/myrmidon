# Реестр стека

> English version: [stack-registry.md](stack-registry.md)

Реестр стека — единый на доске список компонентов, из которых состоит
развёртывание: сама доска, её вендорский апстрим, общие сервисы вокруг. Для
каждого компонента реестр хранит то, что процесс сервера доски может увидеть
локально, — версию, коммит, дайджест образа или честное «неизвестно» с
причиной. Это часть A трека обновлений стека (SUA); сравнение с внешними
релизами и панель обновлений придут в следующих частях.

## Что в реестре

Список компонентов задан сидом в коде
(`server/src/myrmidon/stack-registry/domain.ts`, `STACK_SEED`) и сейчас
включает: `paperclip`, `myrmidon`, `hermes-agent`, `litellm`, `ragflow`,
`hindsight`, `langfuse`, `clickhouse`, `zabbix`, `playwright-chromium-mcp`,
`dockergate`, `media-tools`, `base-images`, `proxmox-ve`, `node-os`.

Каждая запись компонента несёт:

- `name`, `releaseSource`, `upstream` — нейтральные публичные координаты
  компонента (без хостов, без внутренних идентификаторов);
- `localProbe` — как узнаётся локальное состояние: `health-commit` (сама
  доска, из того же среза, что `/api/health`), `docker-image` (дайджесты
  образов по unix-сокету Docker), `env`, `manual`, `container-labels`, `none`;
- `local` — результат пробы: `version`, `commit`, `digest`, `runningOn`,
  `checkedAt`, а при отсутствии значения — `unknownReason`;
- `local.patches` — наши дельты поверх апстрима; сначала пусто, заполняется
  частью B.

## API

Оба маршрута живут под `/api`:

- `GET /api/myrmidon/stack` — отдаёт закэшированный документ. Читать может
  любой board-актор с доступом к компании; агентам и анонимным вызывающим —
  403. До первого refresh маршрут отдаёт сид-вид: все компоненты с
  `local.unknownReason: "not refreshed yet"` и `refreshedAt: null`.
- `POST /api/myrmidon/stack/refresh` — пересобирает локальное состояние и
  перезаписывает кэш. Только instance-admin: ключи агентов и не-админы доски
  получают 403, ничего не пишется.

```sh
curl https://board.example.com/api/myrmidon/stack \
  -H "Authorization: Bearer ***"

curl -X POST https://board.example.com/api/myrmidon/stack/refresh \
  -H "Authorization: Bearer ***"
```

Что собирает refresh:

- компонент доски (`myrmidon`) получает коммит сборки из того же среза
  server-info, что отдаёт `/api/health`, — одна истина о версии доски; если
  git-метаданные недоступны, компонент деградирует в честное «неизвестно»
  (`board build commit unavailable (<reason>)`);
- каждый компонент с пробой `docker-image` опрашивается через Docker API
  (`GET /images/{ref}/json`, версия API `v1.45`, таймаут 10 секунд) по
  unix-сокету; первый найденный repo-тег становится `version`, первый
  дайджест — `digest`;
- компоненты `manual`, `env`, `container-labels` и `none` отдаются как
  «неизвестно» с фиксированной причиной (например, `managed by the operator;
  no automatic probe`, `not visible from the board server process`).

Правила сбоев:

- сломанная инфраструктурная проба — сокет Docker недоступен или демон отвечает
  ошибкой — валит весь refresh с **503** и сохраняет прежний кэш; в теле
  ответа — ошибка и последний сохранённый документ;
- образ, которого просто нет на хосте, — **не** сбой: компонент записывается
  как «неизвестно» (`image not present on the Docker host reachable from the
  board`), и refresh завершается успешно.

## Хранение

Кэш живёт в `instance_settings.general` под ключом `myrmidonStack` — без
миграции. Записи идут по схеме режима обслуживания (замок строки плюс
`jsonb_set`), а вендорский `updateGeneral` переносит ключ без изменений, так
что сохранение настроек из UI не может уронить кэш реестра.

## Настройка

Одна переменная, [`MYRMIDON_STACK_DOCKER_SOCKET`](../SETTINGS.ru.md): путь к
unix-сокету Docker, по которому работают пробы образов. По умолчанию
`/var/run/docker.sock`; читается при каждом refresh, так что изменение
действует со следующего `POST /api/myrmidon/stack/refresh` без перезапуска
сервера. Если сервер доски вовсе не может достучаться до сокета Docker,
оставьте умолчание — refresh будет отвечать 503, а сид-вид (или последний
удачный кэш) останется читаемым.

## Заметки оператору

- Запускайте `POST /api/myrmidon/stack/refresh` после выката, чтобы обновить
  коммит доски и дайджесты образов; до первого refresh GET-маршрут показывает
  сид-вид с `unknownReason: "not refreshed yet"`.
- 503 на refresh означает сбой пробы Docker, а не потерю реестра — проверьте,
  что контейнер доски монтирует сокет, названный в
  `MYRMIDON_STACK_DOCKER_SOCKET`, и что демон отвечает.
- В части A реестр не обращается к внешним лентам релизов; поля
  `releaseSource` и `upstream` носят информационный характер до части B.
- Строка доски — SUA в [../DIVERGENCE.md](../DIVERGENCE.md); маршруты
  смонтированы в `server/src/app.ts` (метка `myrmidon(SUA)`), модуль —
  `server/src/myrmidon/stack-registry/`.
