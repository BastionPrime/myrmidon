# CI Myrmidon

Здесь описано, какие проверки запускаются в `itkadr-git/myrmidon`, почему они устроены так, и
что из вендорских workflow у нас не работает.

## Два уровня CI

Workflow [`myrmidon-ci.yml`](../../.github/workflows/myrmidon-ci.yml) — на каждый
`pull_request`, на `push` в `main` и вручную (`workflow_dispatch`). Все job идут на
раннерах GitHub (`ubuntu-latest`), секреты не нужны. Уровень выбирает job `plan`
(`scripts/myrmidon/ci/affected-tests.mjs plan`):

| Уровень | Когда | Что запускается |
|---|---|---|
| **docs** | PR меняет только `docs/myrmidon/**`, `scripts/myrmidon/**` (кроме `scripts/myrmidon/ci/**`), `CLAUDE.md`, `NOTICE`, `.github/README.md`, `.gitleaks.toml` | `checks` |
| **fast** | Остальные PR | `typecheck` (без Rust раннера), `build` (без релизной сборки Rust), `tests (affected)`, `checks` |
| **full** | `push` в `main`; ручной запуск; PR с меткой `full-ci`; PR, который трогает основу (список ниже); PR, где отбор дал больше 60 файлов тестов на один большой пакет | Всё: `typecheck` и `build` полностью, 13 частей `tests (…)` (= `pnpm test:run`), `tests (other packages)`, `tests (runner)`, `checks` |

**Обязателен для слияния быстрый уровень** (сводная проверка `CI result` на PR). Полный
уровень гарантируется на `main` после слияния; его сбой сразу виден (ниже).

**Основа — PR получает полный уровень:** `pnpm-lock.yaml`, `pnpm-workspace.yaml`, корневой
`package.json`, `.npmrc`, `patches/**`, корневые `tsconfig*.json` и `vitest.config.*`,
скрипты в корне `scripts/` (запуск тестов и сборки), `.github/workflows/myrmidon-ci.yml`,
`scripts/myrmidon/ci/**`, `packages/db/**`, `packages/shared/**`, `packages/plugins/sdk/**`,
`packages/paperclip-runner/**`, `Dockerfile`.

### Какие тесты берёт быстрый уровень

`tests (affected)` запускает (`scripts/myrmidon/ci/select.mjs`):

1. все тесты изменённого пакета — кроме больших (`server`, `ui`, `cli`), их целиком не берём;
2. изменённые файлы тестов;
3. тесты, которые **напрямую** импортируют изменённый пакет (`import`/`vi.mock` по имени
   пакета) или изменённый модуль (относительный путь).

Пример: правка `packages/adapters/grok-local` — все тесты адаптера плюс тесты `server`/`ui`,
которые импортируют `@paperclipai/adapter-grok-local`. Правка
`server/src/services/heartbeat.ts` — тесты, импортирующие `heartbeat`; если их больше 60,
PR получает полный уровень.

Серверные наборы, которые `run-vitest-stable.mjs` запускает по одному (маршруты, authz и его
явный список), и здесь идут по одному в отдельном процессе; остальные — одним запуском в один
поток, как в полном уровне.

**Чего быстрый уровень не ловит:** косвенные эффекты — тест, который зависит от изменённого
кода через цепочку импортов. Это ловит полный прогон на `main`.

### Сбой на `main`

Job `report main status` после полного прогона на `main`:

- красный — открывает issue с меткой `main-red` (или дописывает комментарий в открытый):
  коммит, ссылка на прогон, упавшие job и строки упавших тестов из журнала;
- зелёный — закрывает открытый `main-red` комментарием.

Кто сломал — видно по коммиту; чинит трек, чей PR это внёс (правила — CONVENTIONS).

### Полный прогон на PR вручную

- поставить на PR метку **`full-ci`** и запушить в ветку (или перезапустить прогон,
  Re-run all jobs): план увидит метку и выберет полный уровень. Сама установка метки прогон не
  запускает — иначе прогон по метке создал бы на том же коммите новую проверку `CI result`;
- или Actions → Myrmidon CI → Run workflow по ветке PR.

Для рискованных PR (ядро прогонов, миграции состояния, сквозные правки) — ставить метку.

### Проверки

| Проверка (имя в GitHub) | Уровень | Что делает |
|---|---|---|
| `plan` | все | Выбирает уровень и тесты, план — артефакт `test-plan` |
| `typecheck` | fast, full | `pnpm -r typecheck`; на fast без `typecheck:rust` раннера |
| `build` | fast, full | `pnpm build` (`NODE_OPTIONS=--max-old-space-size=4096`); на fast раннер собирается только как TypeScript, без релизной сборки Rust |
| `tests (affected)` | fast | Отобранные тесты |
| `tests (server 1/5)` … `(server 5/5)`, `tests (serialized 1/5)` … `(5/5)`, `tests (workspaces-a 1/2)`, `(2/2)`, `tests (workspaces-b)` | full | Весь `pnpm test:run`, разбиение как у вендора |
| `tests (other packages)` | full | Пакеты, которые `pnpm test:run` не запускает (ниже) |
| `tests (runner)` | full | `pnpm --filter @paperclipai/paperclip-runner check:all`, как отдельная проверка раннера у вендора |
| `checks` | все | Шаги: `shellcheck` скриптов выката; `node --test` по `scripts/myrmidon/**/*.test.mjs`; секреты (gitleaks); внутренние адреса (частные сети и запрещённые шаблоны); лицензии зависимостей; совместимость плагинов. Каждый шаг выполняется, даже если предыдущий упал: в журнале видно все сбои сразу |
| **`CI result`** | все | Сводная: зелёная, если `plan` прошёл и каждая проверка прошла или не требовалась уровнем |
| `report main status` | только `main` | issue `main-red` (выше) |

**Для ruleset `main-protection` достаточно одной проверки — `CI result`.** Она есть в каждом
прогоне на PR любого уровня, включая `docs`: пропущенные уровнем проверки она принимает как
«не требовались», но только если `plan` прошёл. У отменённого прогона (новый push) `CI result`
не запускается вовсе — ложного зелёного нет.

### Тесты, которые `pnpm test:run` не запускает

`scripts/run-vitest-stable.mjs` вендора запускает `server` и явный список пакетов. Тесты ещё
нескольких пакетов не запускал никто — в том числе адаптера `hermes` (там же тесты
`*.myrmidon.test.ts` треков 3, 4, 6), адаптеров cursor, gemini, kimi, pi, MCP-серверов и
плагинов. Их запускает `tests (other packages)` по списку
[`scripts/myrmidon/ci/extra-test-lanes.json`](../../scripts/myrmidon/ci/extra-test-lanes.json).
Тест `scripts/myrmidon/ci/coverage.test.mjs` падает, если в workspace появился пакет с
тестами, который не запускает ни одна проверка.

**Известные падения вендора** — [`known-failures.json`](../../scripts/myrmidon/ci/known-failures.json).
Эти тесты падают и на чистом `v2026.916.1`, вендор их в CI не запускает. Они дают
предупреждение, а не сбой; любое другое падение — сбой. На 27.09.2026:

| Тест | Причина |
|---|---|
| `packages/adapters/cursor-local/src/server/execute.test.ts` — «reruns sandbox command resolution after managed runtime setup…» | Падает на базе вендора |
| `packages/mcp-server/src/tools.test.ts` — «allows create issue requests to omit status…» | Падает на базе вендора |
| `packages/plugins/paperclip-plugin-fake-sandbox/src/plugin.test.ts` — 2 теста | Падают на базе вендора |
| `packages/plugins/plugin-llm-wiki/tests/{plugin,wiki-route-sidebar-ui}.spec.ts` — наборы не загружаются | Импортируют `react`, которого нет в зависимостях пакета |

### Пропущенные тесты

Тестов, пропущенных из-за секретов или живой сети вендора, нет.

### Экономия раннеров

На бесплатном аккаунте одновременно идёт около 20 job. Быстрый уровень — 6 job вместо 17.
Устаревшие прогоны отменяются и на PR, и на `main` (вердикт нужен последнему коммиту);
у отменённого прогона `CI result` не запускается, красного креста на промежуточном коммите
нет. Метки прогон не запускают.

### Кеши

- Хранилище pnpm: пишет только job `typecheck`, остальные читают. Ключ — хеш `pnpm-lock.yaml`.
- Зависимости Rust (`Swatinem/rust-cache`): сохраняются только на `push` в `main`, PR их
  только читают.

## Лицензии зависимостей

`node scripts/myrmidon/check-licenses.mjs` запускает `pnpm licenses list --prod --json` и
сверяет каждый пакет с политикой [`scripts/myrmidon/license-policy.json`](../../scripts/myrmidon/license-policy.json):

- разрешены MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, CC0-1.0, Unlicense,
  BlueOak-1.0.0, Python-2.0, OFL-1.1 (без учёта регистра). Выражение `A OR B` проходит, если
  разрешена хотя бы одна сторона; `A AND B` — если разрешены обе;
- запрещены GPL-\*, AGPL-\*, SSPL-\* и `Unknown` (лицензия не указана);
- всё остальное (MPL-2.0, LGPL, «SEE LICENSE IN …») тоже не проходит без исключения;
- исключение задаётся парой «имя пакета + лицензия ровно как её пишет pnpm» и обязательно с
  причиной. Если у пакета сменится лицензия, исключение перестанет действовать.

Локально: `node scripts/myrmidon/check-licenses.mjs` (после `pnpm install`). Новую зависимость с
неразрешённой лицензией — заменить или добавить исключение с причиной в том же PR.

Исключения на 27.09.2026 (18 пакетов): MIT-0 (`@csstools/*`), BSD-2 без SPDX-метки
(`url-template`), MIT без поля `license` (`khroma`, бинарники `opencode-linux-*`), MPL-2.0
(`lightningcss*`), LGPL-3.0 (`@img/sharp-libvips-*`, динамическая библиотека) и
проприетарные SDK адаптеров вендора (`@anthropic-ai/claude-agent-sdk*`, `@cursor/sdk*`).
Последние помечены для решения сопровождающего.

## Поиск секретов

gitleaks **8.30.1**, архив проверяется по sha256 (в workflow). Сканируются только новые коммиты:
на PR — `base..head`, на `push` в `main` — `before..after`. Настройки —
[`.gitleaks.toml`](../../.gitleaks.toml): правила по умолчанию плюс список файлов вендора с
заведомо ложными срабатываниями (тестовые токены, литералы заголовков PEM, примеры в
документах). Наши файлы туда не добавляем: вместо этого убираем значение.

Полный скан истории 27.09.2026 (4050 коммитов): 57 срабатываний, все в коммитах вендора,
все — тестовые или примерные значения (34 generic-api-key, 15 private-key, 6 jwt,
1 discord-api-token, 1 curl-auth-header). С `.gitleaks.toml` — 0.

Локально: `gitleaks git --config .gitleaks.toml --log-opts="origin/main..HEAD" .`

## Внутренние адреса

`node scripts/myrmidon/scan-diff.mjs` смотрит только добавленные строки диффа
(`git diff base...head`) и не печатает найденные значения: только файл, строку и правило.

- **Частные адреса** (всегда): IPv4 из частных сетей `10/8`, `172.16/12`, `192.168/16` и `100.64/10`
  (CGNAT). Для примеров — `192.0.2.0/24`, `198.51.100.0/24`, `localhost`,
  `127.0.0.1` (CONVENTIONS, раздел 9). Исключения по путям —
  [`scripts/myrmidon/scan-diff-allowlist.json`](../../scripts/myrmidon/scan-diff-allowlist.json)
  с причиной. На ветках `sync/*` (перенос вендора) тестовые файлы пропускаются: в тестах
  вендора бывают примерные адреса.
- **Запрещённые шаблоны** — из секрета репозитория `MYRMIDON_FORBIDDEN_PATTERNS`: по одному
  регулярному выражению на строку, `#` — комментарий, без учёта регистра. Сам список в
  открытом репозитории не лежит, и в журнал CI не попадает ни шаблон, ни совпадение — только
  номер строки шаблона. Если секрет не задан (или PR из чужого форка, где секретов нет), шаг
  проходит с предупреждением.

Сопровождающему: завести секрет `MYRMIDON_FORBIDDEN_PATTERNS` (Settings → Secrets and
variables → Actions) — наши домены, имена хостов, подсети, имена ботов.

## Совместимость плагинов

Плагины, которые стоят на наших установках, — в
[`scripts/myrmidon/plugin-compat/plugins.json`](../../scripts/myrmidon/plugin-compat/plugins.json)
с точными версиями. hindsight (`@vectorize-io/hindsight-paperclip`) — обязательный: его сбой
красит CI. Остальные (`@pingstray/paperclip-lang-ru`, `paperclip-claude-auth`,
`paperclip-plugin-telegram`) — «предупреждение, не блок»: сбой виден как warning в сводке.

Как проверяется (шаги `Plugin compatibility — …` job `checks`):

1. **Снимки манифестов** (`plugin-compat/fixtures/*.manifest.json`, без сети) проходят через
   проверки хоста из репозитория: схема манифеста (`pluginManifestV1Schema`), версия API
   плагинов, согласованность возможностей (`pluginCapabilityValidator`), минимальная версия
   хоста. Это те же проверки, что делает `plugin-loader` при установке.
2. **Установка как на сервере:** `install.mjs` ставит каждый плагин в свой чистый каталог
   (`npm install --ignore-scripts`), затем заменяет все копии `@paperclipai/plugin-sdk` и
   `@paperclipai/shared` пакетами, собранными из репозитория (`pnpm pack` — ровно то, что было
   бы опубликовано). Так плагин работает с нашим SDK, а не с версией из npm.
3. **Проверка установленного пакета** (`check.ts`): модуль манифеста загружается, проходит
   те же проверки, файл воркера на месте. Затем воркер запускается через
   `createPluginWorkerHandle` сервера — настоящий процесс и RPC хоста: `initialize` и
   `health`. `health` со статусом `error` — сбой; `degraded` (плагину не хватает настроек,
   например токена бота) — норма.

Полный старт сервера со встроенным postgres и установкой через API не делаем: это ещё
несколько минут на каждый PR, а шаги выше уже проходят тот же код хоста (валидаторы и
менеджер воркеров).

Локально:

```sh
pnpm --filter @paperclipai/plugin-sdk ensure-build-deps
node scripts/myrmidon/plugin-compat/install.mjs --work /tmp/plugin-compat
pnpm --filter @paperclipai/server exec tsx ../scripts/myrmidon/plugin-compat/check.ts --work /tmp/plugin-compat
```

Новая версия плагина на установке: поменять версию в `plugins.json` и обновить снимок
манифеста (JSON того, что экспортирует `dist/manifest.js` пакета).

## Образ

Workflow [`myrmidon-image.yml`](../../.github/workflows/myrmidon-image.yml), job `image`.
Вендорский `docker.yml` не правим: он строит `ghcr.io/${{ github.repository }}` для двух
архитектур по тегам `v*` вендора, с его схемой тегов и каналами npm. Свой файл проще и не
конфликтует при переносе.

- **Когда:** `push` в `main`, git-тег вида `<версия вендора>-myr.<N>` (первый —
  `2026.916.1-myr.1`), вручную. На `pull_request` не запускается вовсе, плюс проверка
  `github.repository == 'itkadr-git/myrmidon'`: PR из чужих форков образ не собирают.
- **Что:** `Dockerfile` вендора, стадия `production`, только `linux/amd64`. Кеш BuildKit — в
  реестре (`ghcr.io/itkadr-git/myrmidon:buildcache`).
- **Версия и коммит** для `/api/health`: `PAPERCLIP_BUILD_VERSION` и
  `PAPERCLIP_BUILD_COMMIT`. На теге выпуска версия — сам тег (сверяется с тегом вендора в
  основе коммита). На `main` — `git describe` от тега вендора, сервер показывает его как
  `2026.916.1+<N>.git.<sha>`.
- **Порядок:** образ сначала публикуется только по digest, затем smoke: `docker run` с
  `local_trusted` (он отдаёт версию без входа), `/api/health` должен ответить `status: ok` и
  ровно ожидаемыми версией и коммитом. Только после этого digest получает теги. Упал smoke —
  тегов нет.
- **Теги:** `sha-<короткий коммит>` на каждый запуск, `main` — плавающий на `main`, тег
  выпуска — на теге.
- **Метки OCI:** `org.opencontainers.image.title=Myrmidon`, `source` — адрес репозитория,
  `licenses=MIT`, `version` — версия, которую покажет `/api/health`, `revision` — коммит,
  `io.github.itkadr-git.myrmidon.base.paperclip-version` — версия вендора в основе. Скрипты
  выката берут ожидаемые версию и коммит из этих меток.
- **Сводка job** — digest, версия, коммит, теги.
- **Версии CLI агентов** в стадии `production` закреплены аргументами сборки
  (`CLAUDE_CODE_VERSION`, `CODEX_VERSION`, `OPENCODE_VERSION`, `GEMINI_CLI_VERSION`,
  `KIMI_CODE_VERSION`; у вендора — `@latest`). Обновлять — правкой значений по умолчанию в
  `Dockerfile`.
- Медиа-инструментов (ffmpeg, yt-dlp и т. п.) в образе нет; тест
  `scripts/myrmidon/image/image.test.mjs` следит за этим, за закреплёнными версиями CLI и за
  тем, что workflow не срабатывает на PR.

Сопровождающему: после первой публикации проверить видимость пакета
`ghcr.io/itkadr-git/myrmidon` (Package settings) — новый пакет может оказаться закрытым.

## Доказательство: проверки краснеют

Черновой PR [#73](https://github.com/itkadr-git/myrmidon/pull/73) «[proof, do not merge]»
(закрыт без слияния, автослияние не включалось) внёс четыре находки сразу; в job `checks`
каждый шаг выполняется независимо, поэтому каждая проверка покраснела отдельно в одном
прогоне [36335498882](https://github.com/itkadr-git/myrmidon/actions/runs/36335498882):

| Случай | Что покраснело | Прогон |
|---|---|---|
| Нарочно падающий тест в `cli/src/__tests__/update-notice.myrmidon.test.ts` (уровень fast) | `tests (affected)` | [job](https://github.com/itkadr-git/myrmidon/actions/runs/36335498882/job/108665540148) |
| Фальшивый ключ `api_key = "…"` в документе | `checks` → «Secrets (gitleaks, new commits)» | [job](https://github.com/itkadr-git/myrmidon/actions/runs/36335498882/job/108665440331) |
| Из `license-policy.json` убран `ISC` (пакеты под ISC стали нарушениями) | `checks` → «Licenses of production dependencies» | [job](https://github.com/itkadr-git/myrmidon/actions/runs/36335498882/job/108665440331) |
| Адрес из частной сети `10/8` в документе | `checks` → «Internal addresses (private networks)» | [job](https://github.com/itkadr-git/myrmidon/actions/runs/36335498882/job/108665440331) |
| Запрещённые шаблоны | `checks` → «Internal addresses (forbidden patterns…)» — **зелёный с предупреждением**: секрет `MYRMIDON_FORBIDDEN_PATTERNS` не задан. Не показано | — |

Остальные шаги `checks` (скрипты, совместимость плагинов) остались зелёными. Сводная
`CI result` при любой красной проверке красная, а обязательна для слияния — автослияние
такой PR не сольёт.

## Почему не вендорский `pr.yml`

`pr.yml` вендора вызывает `paperclipai/paperclip/.github/workflows/pr-trusted.yml@master`, то
есть выполняет в нашем репозитории незакреплённый чужой код. Локальная копия
`pr-trusted.yml` тоже не подходит: она проверяет, что репозиторий — `paperclipai/paperclip`,
выбирает раннеры вендора в AWS, заливает `pnpm-lock.yaml`, проверяет пакеты выпуска npm
вендора и каждый PR прогоняет через e2e на браузере. Править её — значит конфликтовать с
вендором при каждом переносе. Поэтому `pr.yml` остаётся выключенным, а у нас свой
`myrmidon-ci.yml`; файлы вендора не трогаем.

## Вендорские workflow в нашем репозитории

Большинство workflow вендора срабатывают на `push` в `master` или `pull_request` в `master`.
У нас ветка `main`, поэтому они не запускаются, и мы их не трогаем.

**Уже выключены сопровождающим** (на 27.09.2026): `release.yml`, `runner-chaos-evals.yml`,
`runner-full-stack-e2e.yml`, `runner-live-evals.yml`, `runner-protocol-live-evals.yml`,
`commitperclip-review.yml`, `pr.yml`.

**Могут сработать у нас:**

| Workflow | Когда | Что будет | Рекомендация |
|---|---|---|---|
| `docker.yml` | push git-тега `v*`, `nightly/v*`, `beta/v*` (например, при переносе тегов вендора) | Соберёт и опубликует образ в `ghcr.io/itkadr-git/myrmidon` с тегами вендора, в обход нашей схемы тегов | Выключить (образ Myrmidon собирает свой workflow, шаг 4) |
| `docker-runner-check.yml` | PR, меняющий `Dockerfile` или код раннера | Сборка раннера в Docker, секретов не требует | Оставить |
| `refresh-lockfile.yml`, `cloud-readiness.yml`, `cloud-migrator-artifacts.yml`, `agent-runtime-images.yml` | Только `push` в `master` или вручную | Не срабатывают | Можно выключить, чтобы никто не запустил вручную |
| `storybook-visual.yml` | PR в `master` | Не срабатывает | Не трогать |

Команды для сопровождающего (нужен `gh` с правами администратора репозитория):

```sh
gh workflow disable docker.yml --repo itkadr-git/myrmidon
# по желанию:
for wf in refresh-lockfile.yml cloud-readiness.yml cloud-migrator-artifacts.yml agent-runtime-images.yml; do
  gh workflow disable "$wf" --repo itkadr-git/myrmidon
done
```

То же через REST API:

```sh
curl -X PUT -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/itkadr-git/myrmidon/actions/workflows/docker.yml/disable
```

## Как проверить CI локально

```sh
pnpm install --frozen-lockfile
# какой уровень и какие тесты получит ветка
node scripts/myrmidon/ci/affected-tests.mjs plan --base origin/main --head HEAD --out /tmp/plan.json
node scripts/myrmidon/ci/affected-tests.mjs run --plan /tmp/plan.json   # быстрый уровень
pnpm typecheck
pnpm test:run          # полный уровень, или по частям: pnpm test:run:general -- --group general-server --shard-index 0 --shard-count 5
node scripts/myrmidon/ci/affected-tests.mjs extra                       # прочие пакеты
pnpm build
node --test $(find scripts/myrmidon -name '*.test.mjs')
```
