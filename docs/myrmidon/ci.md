# CI Myrmidon

Здесь описано, какие проверки запускаются в `itkadr-git/myrmidon`, почему они устроены так, и
что из вендорских workflow у нас не работает.

## Обязательные проверки

Workflow [`myrmidon-ci.yml`](../../.github/workflows/myrmidon-ci.yml) — на каждый
`pull_request`, на `push` в `main` и вручную (`workflow_dispatch`). Все job идут на
раннерах GitHub (`ubuntu-latest`), секреты не нужны.

| Проверка (имя в GitHub) | Что делает |
|---|---|
| `typecheck` | `pnpm install --frozen-lockfile`, `pnpm typecheck` (= `pnpm -r typecheck`, включая `cargo fmt --check` и `cargo check` раннера) |
| `tests (server 1/5)` … `tests (server 5/5)` | vitest, группа `general-server`, 5 частей |
| `tests (workspaces-a 1/2)`, `tests (workspaces-a 2/2)` | vitest, группа `general-workspaces-a` (ui, cli), 2 части |
| `tests (workspaces-b)` | vitest, группа `general-workspaces-b` |
| `tests (serialized 1/5)` … `tests (serialized 5/5)` | vitest, серверные наборы, которым нужен отдельный процесс |
| `build` | `pnpm build` (с `NODE_OPTIONS=--max-old-space-size=4096`), включая релизную сборку раннера на Rust |
| `script tests` | `node --test` по `scripts/myrmidon/**/*.test.mjs`. Пока файлов нет — проходит пусто с пометкой |
| **`CI result`** | Сводная: зелёная, только если зелёные все проверки выше |

Все `tests (…)` вместе — это ровно `pnpm test:run`: `scripts/run-vitest-stable.mjs` без
режима запускает те же общие группы и серверные наборы по очереди. Разбиение такое же, как в
вендорском `pr-trusted.yml`, чтобы укладываться по времени.

**Для ruleset `main-protection` достаточно одной проверки — `CI result`.** Её имя не меняется
при изменении числа частей тестов. Остальные проверки можно не добавлять.

Проверки лицензий, секретов, внутренних адресов, совместимости плагинов и образа добавляются
следующими шагами трека 1 (разделы ниже).

### Пропущенные тесты

Тестов, пропущенных из-за секретов или живой сети вендора, нет: общие группы vitest у
вендора тоже идут без секретов. Если такой тест появится, он пропускается явно и
перечисляется здесь с причиной.

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
pnpm typecheck
pnpm test:run          # или по частям: pnpm test:run:general -- --group general-server --shard-index 0 --shard-count 5
pnpm build
node --test $(find scripts/myrmidon -name '*.test.mjs')
```
