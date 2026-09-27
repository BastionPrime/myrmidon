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
| **docs** | PR меняет только `docs/myrmidon/**`, `scripts/myrmidon/**` (кроме `scripts/myrmidon/ci/**`), `CLAUDE.md`, `NOTICE`, `.github/README.md`, `.gitleaks.toml` | `script tests` |
| **fast** | Остальные PR | `typecheck` (без Rust раннера), `build` (без релизной сборки Rust), `tests (affected)`, `script tests` |
| **full** | `push` в `main`; ручной запуск; PR с меткой `full-ci`; PR, который трогает основу (список ниже); PR, где отбор дал больше 60 файлов тестов на один большой пакет | Всё: `typecheck` и `build` полностью, 13 частей `tests (…)` (= `pnpm test:run`), `tests (other packages)`, `tests (runner)`, `script tests` |

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
| `script tests` | все | `node --test` по `scripts/myrmidon/**/*.test.mjs` |
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
