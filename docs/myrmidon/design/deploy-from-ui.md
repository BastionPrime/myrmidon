# Deploy from the interface (R5-A): design and API contract

Редакция 30.09.2026, трек 5, R5-A (пункт 8 выпуска 1.3); дополнена 01.10.2026 разделами
1.1/1.2 (R5-C, пункт 10: автооткат по здоровью и флаг автообновления). Контракт API из
раздела 4 — для
экрана настроек инстанса и хостового исполнителя. Меняется только обратно совместимо.

## 0. Коротко

- Выкат доски запускается из интерфейса: вставить digest → проверить → выкатить. Правила
  образа и окна — те же, что у `scripts/myrmidon/deploy/deploy.sh`; интерфейс не вводит
  вторую политику.
- Доска сама docker не запускает и compose не пересоздаёт: переключение делает хостовая
  половина — `deploy-from-job.sh`, который запускает тот же `deploy.sh` и пишет отчёт.
- Всё выключено по умолчанию: без `MYRMIDON_DEPLOY_ENABLED=1` запись отвечает 503.

## 1. Работа (job) и её состояния

Одна работа — один digest. Не больше одной незавершённой работы (вторая — 409).

```
 pending → verifying → verified → maintenance_entering → maintenance_on → running → succeeded
                │                      │                                             │
                └→ failed_verification └→ maintenance_failed                          ├→ rolling_back → auto_rolled_back
                                                                                          │         └→ failed_rollback
                └→ aborted (до running)                                                  └→ failed_health (выкл. автооткат)
```

| Статус | Что происходит | Кто двигает |
|---|---|---|
| `pending` → `verified` | Проверка CI-образа (см. §2) | сервис, в `create` и тике |
| `failed_verification` | Образ отказан, ничего не менялось, работа уходит в history | сервис |
| `maintenance_entering` | Окно инстанса открыто (reason `deploy <префикс digest>`), ждём `on` | тик по maintenance API |
| `maintenance_on` | Окно `on`; исполнитель может забирать | тик |
| `running` | Исполнитель заявил работу (отчёт `claimed`/`switching`) | тик по отчёту |
| `succeeded` | Исполнитель дал `health-ok`, и `/api/health` доски согласен; окно закрыто | тик |
| `failed_health` | Здоровье не сошлось (отчёт или свёрка) при ВЫключенном автооткате; окно ОСТАЁТСЯ для отката руками | тик |
| `rolling_back` | Провал здоровья при включённом `MYRMIDON_DEPLOY_AUTO_ROLLBACK`: исполнитель откатывает образ; окно остаётся (оно покрывает и откат) | тик по отчёту |
| `auto_rolled_back` | Откат дошёл до прежнего образа, его health прошёл; окно закрыто, человек не участвовал | тик |
| `failed_rollback` | Сам откат не удался; окно ОСТАЁТСЯ для оператора | тик |
| `aborted` | Отмена оператором (до `running`) или таймаут шага | маршрут/тик |

Таймаут шага: `MYRMIDON_DEPLOY_STEP_TIMEOUT_SEC` (по умолчанию 1800) в одном статусе —
работа отменяется, окно закрывается.

### 1.1 Автооткат по здоровью (R5-C, п. 10)

При провале проверки здоровья (отчёт `health-failed`/`error`, или `health-ok`, с которым
не согласен `/api/health`) и включённом `MYRMIDON_DEPLOY_AUTO_ROLLBACK` (по умолчанию
включён) работа не завершается `failed_health`: она переходит в `rolling_back`, и
хостовый исполнитель тут же запускает `rollback.sh` на образ, который `deploy.sh` запомнил
перед переключением (локально известный прежний образ; откат — аварийный путь, CI-проверка
цели отката там только предупреждает). Фазы отчёта расширяются:
`rolling-back` (идёт), `rolled-back` (успех → работа `auto_rolled_back`, окно закрывается),
`rollback-failed` (провал → работа `failed_rollback`, окно остаётся для оператора).
Хостовая половина того же выключателя — `AUTO_ROLLBACK` в deploy.env (по умолчанию 1);
обе стороны должны совпадать, иначе работа на доске и действия исполнителя разойдутся.

### 1.2 Автообновление без подтверждения

`MYRMIDON_DEPLOY_AUTO_UPDATE` (по умолчанию ВЫключен) разрешает выкат без подтверждения в
интерфейсе. Пока стенд не прошёл сценарий выпуска (STAND, 1.1.2), флаг держат выключенным —
риск назван в плане 1.3: автообновление без стенда не включать. Каждый выкат из интерфейса
требует явного подтверждения («Confirm deploy»); флаг задокументирован, чтобы решение
включения было одной настройкой после STAND.

## 2. Проверка образа — та же, что у скрипта

До открытия окна, в `create` и в `preview`:

1. Ссылка — ровно `ghcr.io/itkadr-git/myrmidon@sha256:<64 hex>` (голый digest принимается и
   дополняется репозиторием). Тег — отказ.
2. Образ есть в реестре: метки читаются без скачивания слоёв (ghcr.io: токен → манифест →
   config blob; или `MYRMIDON_DEPLOY_REGISTRY_INSPECT_URL`).
3. Метки CI: `org.opencontainers.image.revision` — полный sha коммита,
   `org.opencontainers.image.source` — наш репозиторий.
4. Коммит достижим из `origin/main` или несёт тег `myr-v*` — через GitHub API (compare,
   matching-refs), без git-клона на хосте доски.

Флага обхода нет — ни настройки, ни «повторить с силой». Отказ пишется в работу и журнал
активности (`myrmidon.deploy_jobs.image_refused`).

## 3. Хранение и переносимость

Ключ `myrmidonDeployJobs` в `instance_settings.general` (как `myrmidonMaintenance` у R3):
чтение-запись сырой строки под замком `SELECT … FOR UPDATE`; вендорский `updateGeneral`
переносит ключ (точка вызова `myrmidon(R5-A)` в `instance-settings.ts`). Миграций нет.
Перезапуск: незавершённая работа поднимается тиком при старте (`startDeployJobs`).

## 4. API

Монтировано под `/api`, та же авторизация, что у остального API доски.

### `GET /api/myrmidon/deploy-jobs`

Права: любой пользователь доски с доступом к организации. Ответ — живая (или последняя)
работа и history (последние 20).

### `POST /api/myrmidon/deploy-jobs/preview`

Права: как GET. Тело `{ "reference": "sha256:…" }`. Ответ — вердикт проверки: `{ok, digest,
version, commit, reason}`. Ничего не меняет и работу не создаёт.

### `POST /api/myrmidon/deploy-jobs`

Права: только администратор инстанса. Тело `{ "reference": "sha256:…", "reason? }`.
Создаёт работу, проверяет образ, при успехе открывает окно. Ответ 201 — работа. Отказы:
400 (ссылка), 409 (работа уже идёт), 503 (функция не включена).

### `POST /api/myrmidon/deploy-jobs/:id/abort`

Права: администратор инстанса. Тело `{ "id": "<uuid>" }`. Отменяет работу до начала
переключения (иначе 409 с подсказкой про откат) и закрывает окно.

## 5. Хостовая половина

`scripts/myrmidon/deploy/deploy-from-job.sh --config <deploy.env> [--once] [--timeout N]`:

- опрашивает `GET /api/myrmidon/deploy-jobs`, забирает работу в `maintenance_on`
  (и в `rolling_back` — см. §1.1);
- ждёт, пока окно инстанса станет `on` (иначе — отчёт `error`);
- запускает тот же `deploy.sh --config … --digest <digest>` (вся его проверка, дамп,
  дренаж, здоровье — без изменений);
- при провале и включённом `AUTO_ROLLBACK` (по умолчанию 1; хостовая половина
  `MYRMIDON_DEPLOY_AUTO_ROLLBACK`) немедленно запускает тот же `rollback.sh`
  без аргументов цели — на запомненный прежний образ;
- пишет `$STATE_DIR/job-<id>.json`: `{jobId, phase: claimed|switching|health-ok|
  health-failed|rolling-back|rolled-back|rollback-failed|error, version, commit, at}`;
  лог — `$STATE_DIR/job-<id>.log` (там же и лог отката);
- один исполнитель на хост: замок каталогом `$STATE_DIR/executor.lock`.

Каталог `$STATE_DIR` монтируется в контейнер доски read-only как
`MYRMIDON_DEPLOY_REPORTS_DIR`; доска только читает.

## 6. Экран

Раздел «Board update» в общих настройках инстанса (после «Maintenance» и «Run limits»):
поле digest с клиентской валидацией, «Verify image» (preview), «Deploy» с подтверждением,
карточка живой работы со шагами и «Abort» (пока можно), history. Тексты — английские,
дизайн — только токены (`pnpm check:token-gates`).

## 7. Настройки

См. `docs/myrmidon/SETTINGS.md`, раздел «Трек 5»: `MYRMIDON_DEPLOY_ENABLED`,
`MYRMIDON_DEPLOY_HEALTH_URL`, `MYRMIDON_DEPLOY_REPORTS_DIR`, таймауты,
`MYRMIDON_DEPLOY_REGISTRY_INSPECT_URL`, `MYRMIDON_DEPLOY_GITHUB_HEADERS_JSON`.

## 8. Тесты

`server/src/myrmidon/deploy-jobs/*.myrmidon.test.ts` (домен, сервис с фейками, маршруты,
чтение отчётов), `scripts/myrmidon/deploy/deploy-from-job.test.mjs` (node:test, фейковые
docker/curl/git), `ui/src/components/myrmidon/DeployJobsPanel.myrmidon.test.tsx`.
Ключевой сценарий приёмки — «не-CI образ отклоняется» — закреплён с обеих сторон: домен
(список отказов) и исполнитель (deploy.sh отказал — отчёт health-failed, pull не было).

## 9. Чего сознательно нет

- Очереди работ: один выкат за раз; следующий — после завершения.
- Канарейки: это R5-B (соседний пункт), не этот. Автооткат здесь — только выкат доски;
  откат ботов живёт в канареечном модуле (`bot-canary.md` §9).
- Автопилота выбора образа: «автообновление» — это флаг-разрешение (§1.2), код, который сам
  выбирает свежий digest и запускает выкат, появится после прогона STAND.
- Запуска docker из контейнера доски: никогда; только файловый канал отчётов.
