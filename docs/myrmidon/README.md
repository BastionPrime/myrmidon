# Myrmidon

Myrmidon — плоскость управления компаниями из ИИ-агентов: доска задач, агенты и их прогоны,
инструменты MCP, чаты, рутины. Это самостоятельный продукт на основе Paperclip. Мы развиваем его
для постоянной работы большого парка агентов: прогоны не теряются, агенты изолированы друг от
друга, доску можно обслуживать и обновлять без потерь.

## Отношение к Paperclip

- Основан на Paperclip **2026.916.1**: тег вендора `v2026.916.1`, коммит `d554c47`,
  <https://github.com/paperclipai/paperclip>.
- Лицензия — **MIT**, как у вендора. `LICENSE` вендора (Copyright (c) 2025 Paperclip AI) не
  меняется. Сторонние уведомления в дереве сохраняются: `packages/adapters/hermes/LICENSE`,
  `ui/public/fonts/NOTICE.md`, `ui/public/brands/**`,
  `packages/paperclip-runner/devtools/issue-thread/src/fonts/NOTICE.md`. Файл `NOTICE` в корне —
  наш: в нём сказано, что Myrmidon основан на Paperclip (MIT), и перечислены эти уведомления.
- Myrmidon не связан с Paperclip AI, и они его не одобряли. Имя Paperclip в коде (пакеты
  `@paperclipai/*`, переменные `PAPERCLIP_*`, CLI `paperclipai`) оставлено ради совместимости и
  лёгкого переноса обновлений. Как название нашего продукта оно не используется.
- Раз в неделю переносим последний стабильный релиз вендора. Свои изменения вендору не
  отправляем.
- Каждое наше отличие от кода вендора записано в [DIVERGENCE.md](DIVERGENCE.md): что изменено,
  зачем, каким тестом проверено и когда правку можно снять.

## Что добавляет первый выпуск (V1.0)

- **Надёжность прогонов:** аренды окружения освобождаются, побудки не гаснут, прогон стартует
  при длинной истории задачи, один сбойный инструмент не отключает весь каталог MCP.
- **Безопасность:** прогон агента не получает окружение сервера (пароль базы, секреты
  подписи). Агент не может менять свои настройки. Значения секретов маскируются в журналах и
  сообщениях.
- **Эксплуатация:** режим обслуживания, выкат по отпечатку образа с откатом, еженедельный
  перенос релизов вендора, CI с проверкой лицензий и поиском секретов.
- **Агенты Hermes:** инструменты MCP доски доступны в прогоне, навыки ставятся в профиль своего
  агента, модели для текста, зрения, видео, слуха, голоса и резервные модели задаются в карточке.

Подробно — в [ROADMAP.md](ROADMAP.md).

## Телеметрия

Myrmidon не отправляет телеметрию вендору. В коде нет адресов вендора, по умолчанию телеметрия
выключена. Включить её можно только явно, указав свой адрес приёма.

## Статус (27.09.2026)

- В репозитории — история вендора до `v2026.916.1`, своих изменений кода пока нет.
- Идёт работа над V1.0: шесть параллельных треков, см. [tracks/](tracks/).
- Выпусков пока нет. Образ будет публиковаться в `ghcr.io/itkadr-git/myrmidon`.
- Для боевого использования Myrmidon ещё не готов.

## Документы

| Файл | О чём |
|---|---|
| [ROADMAP.md](ROADMAP.md) | Состав V1.0 с критериями готовности, порядок V1.x, «Потом» |
| [CONVENTIONS.md](CONVENTIONS.md) | Как мы работаем: ветки, PR, тесты, слияние, открытость, карта файлов по трекам |
| [DIVERGENCE.md](DIVERGENCE.md) | Реестр наших отличий от вендора |
| [SETTINGS.md](SETTINGS.md) | Наши настройки (переменные `MYRMIDON_*`) и их значения по умолчанию |
| [board-key-rotation.md](board-key-rotation.md) | Runbook оператора: ротация и отзыв ключей доски / PAT по ролям (ROLE-SCOPED-TOKENS) |
| [stack-updates.md](stack-updates.md) | Цикл обновлений стека: откуда «наше» и «у автора», отставание, вердикт «патч закрыт», плановая сверка и карточка `stack_update` (STACK-UPDATES часть D) |
| [tracks/](tracks/) | Задания шести треков V1.0 |
| [SESSION-PROMPTS.md](SESSION-PROMPTS.md) | Промпты для запуска сессий по трекам |

### Руководства (guides/)

Руководства пользователя и администратора; у каждого файла есть русская версия `*.ru.md`.

| Файл | О чём |
|---|---|
| [guides/run-limits.md](guides/run-limits.md) | Лимиты допуска прогонов: четыре лимита, источники значений, изменение из UI и API |
| [guides/run-stall.md](guides/run-stall.md) | Обнаружение зависших прогонов: что считается прогрессом, прерывание `run_stalled`, возврат задачи в `todo`, настройки |
| [guides/stale-block.md](guides/stale-block.md) | Сторож мёртвых блоков (STALE-BLOCK B): какие причины мертвы, снятие блока с системным комментарием, карточка `stale_block` в attention-фиде, настройки |
| [guides/workspace-cleanup.md](guides/workspace-cleanup.md) | Очистка рабочих копий после слияния и сигнал о застрявшей копии |
| [guides/cloud-files-connector.md](guides/cloud-files-connector.md) | Коннектор Microsoft 365 для ботов-контейнеров: настройка и журнал |
| [guides/maintenance-banner.md](guides/maintenance-banner.md) | Как баннер обслуживания группирует окна агентов |
| [guides/access-hub.md](guides/access-hub.md) | Хаб доступов в настройках: секреты парка, выдача агентам, ротация, SSH-ключи, журнал |
| [guides/emergency-stop.md](guides/emergency-stop.md) | Аварийная остановка прогонов, которые осушаемая пауза оставила дорабатывать |
| [guides/bot-container-card.md](guides/bot-container-card.md) | Раздел «Container» карточки агента: настройки контейнера, лимит одновременных прогонов, статус |
| [guides/agent-memory-card.md](guides/agent-memory-card.md) | Вкладка «Memory» карточки агента: просмотр, выгрузка и удаление записей банка памяти, журнал |
| [guides/browsers.md](guides/browsers.md) | Раздел «Браузеры» в настройках: экран живого браузера, пауза ботов на время сессии, журнал, очистка данных сайта |
| [guides/stack-registry.md](guides/stack-registry.md) | Реестр компонентов стека и экран «Стек» (Company → Stack): колонки, отстающие сверху, кнопки refresh/check (503 показан на месте), планирование обновления в backlog-задачу, сверка релизов и вердикт «патч закрыт» |
| [guides/cloud-connector.md](guides/cloud-connector.md) | Облака через коннектор (1.4): аккаунт владельца, корни-папки, раздача доступа агентам, инструменты, журнал |
| [guides/tracing-health.md](guides/tracing-health.md) | Здоровье LLM-трейсинга: карточка «LLM tracing» в настройках компании, состояния, сигнал оператору, журнал переходов |
| [guides/reference-task-evals.md](guides/reference-task-evals.md) | Эталоны и судья (1.6 EVALS-A): корпус эталонных задач, LLM-судья за шлюзом, вердикт «порог+повтор», экспорт в Langfuse |
| [guides/bridge-extension.md](guides/bridge-extension.md) | Браузерный мост, расширение (части C и D): действия open/read/click/fill/download/screenshot, шаг подтверждения человеком, сопряжение кодом, сборка и load-unpacked |
| [guides/browser-bridge-gateway.md](guides/browser-bridge-gateway.md) | Браузерный мост, шлюз (EXTCASE-B): исходящее WSS-соединение расширения, сопряжение кодом, allowlist, политика подписи, журнал |
| [guides/connector-panel.md](guides/connector-panel.md) | Панель коннекторов (Company settings → Connectors): устройства, выдача кодов, allowlist, политика подписи, журнал |
| [guides/ocr.md](guides/ocr.md) | Путь OCR: PDF в текст в workspace бота — инструмент `ocr.pdf`, бэкенды, лимиты, журнал |
| [guides/owner-telegram-cards.md](guides/owner-telegram-cards.md) | Доставка карточек вопросов и согласований владельцу задачи в Telegram-личку с агентом-автором (U2) |
| [guides/cto-chat-planner.md](guides/cto-chat-planner.md) | Планировщик чата с доской (CTO-CHAT B): текст владельца — в предложенный эпик с задачами и критериями приёмки, карточка согласования, вход из Telegram DM, коды ошибок |
| [guides/external-mcp-connectors.md](guides/external-mcp-connectors.md) | Внешние MCP-коннекторы: подключение любого HTTP MCP-сервера без кода форка — вердикт разведки, две точки входа, гранты агентам, регламент и проверка здоровья |
| [guides/agent-instructions-revisions.md](guides/agent-instructions-revisions.md) | История ревизий инструкций агента: снимки, откат, журнал |
| [guides/auto-resume.md](guides/auto-resume.md) | Автовозобновление агента из `error`: бэкофф 1/5/15, карточка оператору после потолка попыток, настройки |
| [guides/ui2-shell.md](guides/ui2-shell.md) | Оболочка Myrmidon 2.0 за флагом `enableMyrmidonUi2`: включение на инстанс и лично через `?ui=`, рамка (рейка/верхняя панель/телефонный каркас), экраны 2.0, токены и шрифты |
| [guides/task-pr-sync.md](guides/task-pr-sync.md) | Закрытие задачи по слитым PR: проход по рабочим продуктам `pull_request`, возврат исполнителю без слияния, гейты после выката, сторож побудок |
| [guides/commander-chat.md](guides/commander-chat.md) | Экран «Чат с Полководцем» в интерфейсе 2.0 (CTO-CHAT A): входы (рейка, телефон, палитра с подсказкой `Ctrl K`), запрос свободным текстом, предложенный план, карточка согласования, тот же поток из Telegram-лички |
| [guides/alibaba-image-connector.md](guides/alibaba-image-connector.md) | Коннектор alibaba-image (1.6): бесплатные генерация и правка картинок для агентов — инструменты и модели реестра, запуск контейнера в окне выката (порт 8083, ключ :ro, общий workspace), подключение ботам через external-MCP и гранты, смоук |
| [guides/wiki-regulations.md](guides/wiki-regulations.md) | Регламенты компании в вики (1.6 WIKI-CORTEX): жизненный цикл «черновик → одобрено», ревизии и откат, роли и ключ `*`, доставка `REGULATIONS.md` в профиль бота, агент-википедист |
| [guides/agent-board-admin.md](guides/agent-board-admin.md) | Администратор доски из агентов (1.6.1 ADMIN-AGENT): переключатель «Board administrator» на вкладке Permissions карточки агента, кто его видит, страница Members с бейджем админа-агента, fail-closed чтение флага, серверная семантика — 17 ключей операторского набора, снимок грантов, запрет само-включения |
| [guides/wip-limit.md](guides/wip-limit.md) | Лимит WIP (1.6.1 WIP-LIMIT): экран «WIP limit» в настройках компании (умолчание и лимиты по агентам, живая загрузка), бейдж wip/limit в списке агентов, сигнал сверх лимита (карточка внимания + system-notice, sweep 300 с, лид-правило), контракт API |
| [guides/foraging.md](guides/foraging.md) | Фуражировка (1.6 FORAGING): реестр источников по ролям, проход сравнения снимков, находки и кандидаты в навыки, бюджет прохода, экран «Foraging», API |

| [media-tools.md](media-tools.md) | Общие медиа- и офисные инструменты для контейнерных ботов: сервис media-mcp, хранилище и квоты, инструменты (ffmpeg, офис, OCR, `dwg_convert`), развёртывание и границы изоляции |

## Сборка и запуск

Пока всё как у вендора: [doc/DEVELOPING.md](../../doc/DEVELOPING.md),
[doc/DOCKER.md](../../doc/DOCKER.md). Нужны Node 24 (не ниже 24.11) и pnpm 9.15.4.
Сборку образа и выкат трек 1 опишет в `docs/myrmidon/ci.md` и `docs/myrmidon/deploy.md`.
