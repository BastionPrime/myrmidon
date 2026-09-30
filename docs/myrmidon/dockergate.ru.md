# dockergate

> English version: [dockergate.md](dockergate.md)

Прокси перед сокетом Docker для драйвера контейнеров ботов доски (`server/src/myrmidon/bot-containers/`). Код: `tools/dockergate/` (Go, только стандартная библиотека), образ: `docker/dockergate/Dockerfile`, публикация: `.github/workflows/myrmidon-dockergate.yml` в `ghcr.io/itkadr-git/myrmidon-dockergate`.

## Зачем

Сервер доски работает под тем же uid, что и боты с терминалом. Доступ доски к сокету демона Docker равен root хоста для любого такого бота: контейнер с `Privileged`, с монтированием `/` и так далее создаётся одним вызовом. dockergate стоит между доской и демоном и пропускает только вызовы, которые делает драйвер, и только с телами, которые драйвер строит. Всё остальное запрещено (запрет по умолчанию). Сырой сокет демона доске не монтируется, доске отдаётся сокет dockergate (`MYRMIDON_BOT_DOCKER_SOCKET`, см. [SETTINGS.md](SETTINGS.md)).

Дополнительные read-only тома бота (общие каталоги) описаны в
[bot-extra-mounts.md](bot-extra-mounts.md); на стороне dockergate их разрешает
ключ `mountSources`.

## Как решается

1. **Вызывающий.** Соединение принимается, только если его открыл закреплённый процесс доски (`SO_PEERCRED`, затем сверка процесса по `/proc`): первый потомок главного процесса контейнера доски с ожидаемым `argv`. Чужой вызывающий получает статический отказ или молчаливое закрытие; слот соединения он не занимает. Режим `caller.mode: uid` (только uid и gid) нужен для CI и отвергается проверкой конфигурации при боевом `volumeRoot`.
2. **Маршруты.** Сопоставляется сырой request-target, без раскодирования процентных escape-последовательностей; допускаются только литералы шаблона. Метод, версия API (только `v1.45`) и заголовки проверяются жёстко.
3. **Тела.** Тело создания контейнера разбирается строгой схемой (неизвестный ключ, дубликат ключа, `null`, дробное число и экранированная буква отклоняются), затем пересобирается канонически, и сравнивается побайтно с полученным. Пересборка идёт от значений из `bots[]`, а не из запроса. Tar-загрузки (`ustar`) проверяются побайтно и пересобираются так же: типы, uid/gid, режимы, пути, порядок, содержимое.
4. **Согласованность бота.** `botKey` берётся из имени контейнера; метка, тома, сеть и скрипт помощника обязаны ему соответствовать. Дополнительные тома сверх трёх томов бота разрешены только как read-only binds, источник которых целиком назван в `mountSources`, а точка монтирования не занята; у помощника дополнительных томов нет. Пределы памяти, CPU и числа процессов не могут превышать записанные в `bots[]`.
5. **Состояние.** Перед вызовом dockergate сам смотрит контейнер и проверяет предусловия (метка бота, статус, наличие `.next`).
6. **Ответы урезаются** до полей, которые читает драйвер, с потолком размера.

## Таблица разрешённых вызовов

| ID | Вызов | Назначение |
|---|---|---|
| A1 | `GET /v1.45/images/<ref>/json` для `ref` из `images` | метки образа (контракт среды бота) |
| A2 | `GET /v1.45/containers/myrmidon-bot-<K>/json` | состояние контейнера |
| A3 | `GET .../myrmidon-bot-<K>/archive?path=<маркер применённого профиля>` | чтение маркера |
| A4 | `POST /v1.45/containers/create?name=myrmidon-bot-<K>[.next\|.helper]` | создание бота, `.next` или помощника |
| A5 | `PUT .../myrmidon-bot-<K>.helper/archive?path=<том>&noOverwriteDirNonDir=true` | запись профиля через помощника (tar) |
| A6 | `POST .../myrmidon-bot-<K>[.helper]/start` | запуск |
| A7 | `POST .../myrmidon-bot-<K>.helper/wait?condition=not-running` | ожидание помощника |
| A8 | `GET .../myrmidon-bot-<K>.helper/logs?stdout=true&stderr=true&tail=20` | журнал помощника |
| A9 | `DELETE .../myrmidon-bot-<K>[.next\|.helper]?force=true&v=true` | удаление |
| A10 | `POST .../myrmidon-bot-<K>/stop?t=30` | остановка (только внутри recreate) |
| A11 | `POST .../myrmidon-bot-<K>/restart?t=30` | перезапуск (с пределом частоты) |
| A12 | `POST .../myrmidon-bot-<K>.next/rename?name=myrmidon-bot-<K>` | завершение recreate |

`K` — строчный UUID. Любой другой путь (в том числе `exec`, `attach`, `commit`, `build`, `images/create`, `volumes`, `networks`, `info`, `events`, `system`, `swarm`) получает 403 `route_not_allowed`.

## Конфигурация

Файл JSON. Неизвестный ключ на любом уровне и отсутствие обязательного не дают запуститься (`check-config` и `serve` выходят с кодом не 0).

| Ключ | Смысл |
|---|---|
| `listen` | абсолютный путь сокета dockergate |
| `upstream` | абсолютный путь сокета демона |
| `apiVersion` | только `1.45` |
| `caller` | обязательно. `container` (имя контейнера доски), `containerLabels`, `uid`, `gid`, `argv`, `maxStartDelayTicks`, `mode` (`container-main-process` по умолчанию, `uid` только для CI) |
| `volumeRoot` | каталог томов ботов на хосте; том бота `<root>/<botKey>/{hermes,workspace,scratch}` |
| `mountSources` | каталоги хоста, которые бот может смонтировать дополнительно, только для чтения (пустой или отсутствующий список — ни одного). Каждый дополнительный bind в теле создания должен начинаться с одного из этих путей целиком, иметь суффикс `ro` и точку монтирования вне `/data/hermes`, `/workspace`, `/scratch`, `/tmp`; иначе `mount_source_not_allowed` или `binds_mismatch`. Список применим и при `SIGHUP` |
| `network` | единственная сеть ботов |
| `images` | непустой список образов, только по дайджесту (`имя@sha256:...`), тег не допускается |
| `bots[]` | запись бота: `botKey`, `maxMemoryMb`, `maxCpus`, `maxPids` |
| `limits` | лимиты и таймауты: размеры заголовка и тел, таймауты чтения и апстрима, число соединений и вызовов в полёте, общая частота, частота отказов на процесс, окна частоты по ботам (`createPerWindow`, `startPerWindow`, `restartPerWindow`, `stopPerWindow`, `putArchivePerWindow`, `rateWindowSec`). Пропущенный ключ берёт значение по умолчанию |
| `statsFile` | абсолютный путь файла счётчиков |

`SIGHUP` перечитывает файл; применяются только `bots`, `images`, `network`, `volumeRoot` и `mountSources`. Неверный файл или файл, меняющий что-либо ещё, отклоняется, работает прежняя конфигурация.

## Журнал и счётчики

Журнал (JSON, одна строка на решение) содержит маршрут, `botKey`, решение, код причины, и для отказа по полю тела: путь поля, длину значения и первые 12 символов sha256. Тел запросов и ответов, имён из tar, значений окружения, заголовков клиента и секретов в нём нет по построению. События без решения: `caller_decoy`, `reject_flood`, `caller_resolve_failed`, `caller_not_board_main`, `config_reload_failed`.

Коды причин: `caller_resolve_failed`, `caller_not_board_main`, `caller_pin_stale`, `target_form`, `method_not_allowed`, `api_version`, `route_not_allowed`, `header_forbidden`, `content_type`, `body_not_allowed`, `body_too_large`, `json_syntax`, `json_duplicate_key`, `json_unknown_key`, `json_type`, `json_value`, `json_not_canonical`, `bot_not_enrolled`, `image_not_allowed`, `image_contract`, `image_user`, `helper_image_mismatch`, `name_label_mismatch`, `binds_mismatch`, `mount_source_not_allowed`, `network_mismatch`, `limit_exceeds_enrollment`, `script_mismatch`, `nonce_invalid`, `tar_syntax`, `tar_type`, `tar_owner`, `tar_mode`, `tar_path`, `tar_nonce`, `tar_order`, `tar_content`, `tar_too_large`, `tar_not_canonical`, `foreign_container`, `state_precondition`, `volume_root_invariant`, `rate_limited`, `concurrency_limited`, `upstream_error`, `upstream_timeout`, `upstream_upgrade`, `response_too_large`, `marker_too_large`.

`statsFile` (JSON, переписывается атомарно) хранит только числа и имена: разрешения и отказы по маршрутам и причинам, `denyPeer`, `rejectDropped`, `resolveFailures`, `resolveDecoys`, ошибки апстрима, `markerTooLarge`, `rateLimited`, состояние закрепления, ответ демона на ping, гистограмму длительности по маршрутам. Значений из запросов и ответов демона в нём нет. Полезные сигналы для мониторинга: рост `denyPeer` или `resolveDecoys`, отказы кроме ожидаемых, `pinned: false`, устаревший `updatedAt`.

## Запись бота

1. Подготовить каталог тома бота `<volumeRoot>/<botKey>`: каталог принадлежит root и не
   записываем группой и прочими (проверка `CheckVolumeRoot` отклоняет режим с битами
   групповой/общей записи, то есть 0755 или строже); подкаталоги `hermes`, `workspace`,
   `scratch` — root или пользователь бота (uid 10001), тоже без групповой/общей записи.
   Содержимое не трогать. (uid 65532 — это пользователь самого контейнера dockergate,
   к владельцу тома он отношения не имеет.)
2. Добавить запись в `bots[]` (структурной правкой JSON, не регуляркой) с потолками памяти, CPU и числа процессов.
3. Если боту нужны дополнительные read-only тома, добавить их источники в `mountSources` (тоже структурной правкой); источник, не названный здесь, до демона не дойдёт.
4. Проверить: `dockergate check-config --config <файл>`.
5. Отправить `SIGHUP` процессу dockergate.

## Выкат и откат

1. Образ берётся из `ghcr.io/itkadr-git/myrmidon-dockergate` строго по дайджесту; метка OCI `org.opencontainers.image.revision` сверяется с коммитом `main` или тега `myr-v*`.
2. Каталог сокета `/run/myrmidon-dockergate/` создаётся при загрузке (tmpfiles) и монтируется в контейнер доски; сырой сокет демона в него не монтируется.
3. dockergate запускается отдельным контейнером без привилегий: пользователь 65532, файловая система только для чтения, все capabilities сброшены, лимиты памяти и CPU заданы; доступ к сокету демона получает только он.
4. В окружении доски `MYRMIDON_BOT_DOCKER_SOCKET=/run/myrmidon-dockergate/engine.sock`, перезапуск доски (окно без пересборки ботов).
5. Приёмка: `check-config`, полный цикл драйвера (status, create, writeProfile, start, restart, recreate) на одном боте, в журнале нет отказов кроме ожидаемых.
6. Откат: вернуть прежнее значение `MYRMIDON_BOT_DOCKER_SOCKET`, перезапустить доску; dockergate остановить. Состояние контейнеров ботов при этом не меняется.

## Остаточные риски

- Процесс с uid доски, который через ptrace или `/proc/<pid>/mem` заставляет главный процесс доски сделать вызов, получает полномочия драйвера над записанными в `bots[]` ботами (не root хоста). Смягчение: `kernel.yama.ptrace_scope=1`; полностью: боты вне контейнера доски.
- Поток соединений от процесса с uid доски может задержать законный вызов до следующего прохода реконсиляции.
- Доверие к демону и образам: образ проверяется по дайджесту из `images` и метке контракта; сам образ dockergate не подписывается.

## Что не сделано

В первый PR не вошли: фаззинг, интеграционные тесты с настоящим dockerd, матрица правил `RULES.md` со сверкой в CI, скрипты хоста (выкат, запись бота, правка compose, tmpfiles), два теста доски со стороны `agent-self-update`, триггеры мониторинга. Они идут отдельными PR.
