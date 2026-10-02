# Консоль серверов (SC1): проект и контракт API

Редакция 30.09.2026, серия 1.4, шаг «SERVER-CONSOLE, часть A». Решение о продукте —
шаг 0 тикета SERVER-CONSOLE: Apache Guacamole, пользователя авторизует панель, Guacamole
принимает только подписанный auth-JSON. Этот документ — контракт панели и Guacamole: реестр
узлов, выдача токена, журнал. Контракт меняется только обратно совместимо.

## 0. Коротко

- Узлы флота живут в таблице `myrmidon_fleet_servers` (аддитивная миграция `0287`), по компаниям.
- Панель выдаёт на клик «Консоль» **одноразовый по сроку** auth-JSON для guacamole-auth-json:
  HMAC/SHA-256 + AES-128-CBC, ключ из секрет-хранилища панели, срок 5 минут.
- Токен читает Guacamole; браузер получает только шифротекст. Пароль узла лежит внутри токена и
  в браузер открытым текстом не попадает.
- Доступ — только роль владельца компании (у администратора инстанса и локальной доски остаётся
  полный доступ доски, как везде в панели).
- Каждая выдача и каждое закрытие пишутся в журнал панели (`activity_log`): кто, когда, какой
  узел; при закрытии — длительность.
- Клиент Guacamole панель не поднимает: адрес задаёт эксплуатация (`MYRMIDON_FLEET_CONSOLE_URL`).
  Пока адрес не задан, выдача токена отвечает `503` (`console_not_configured`).

## 1. Роли и путь пользователя

| Шаг | Кто | Что происходит |
|---|---|---|
| 1 | владелец | открывает «Настройки компании» → раздел «Server console» |
| 2 | панель | `GET /api/myrmidon/fleet/servers` — список узлов компании |
| 3 | владелец | жмёт «Console» у узла |
| 4 | панель | `POST /api/myrmidon/fleet/console-token` — проверяет владельца, собирает auth-JSON, подписывает и шифрует, пишет журнал |
| 5 | браузер | встраивает клиент Guacamole по адресу `.../#/?data=<base64>`; клиент меняет токен на свою сессию |
| 6 | guacd | подключается к узлу (ssh или vnc) под узловой учёткой |
| 7 | владелец | жмёт «Close session» → `POST /api/myrmidon/fleet/console-sessions/close` — журнал получает длительность |

Узловая учётка (`fleet-console` с sudo) создаётся **не этой частью**: реестр хранит только имя
пользователя и ссылку на секрет с паролем. Ключи и пароли узла в браузер не попадают.

## 2. Реестр узлов

Таблица `myrmidon_fleet_servers` (`packages/db/src/schema/myrmidon_fleet_servers.ts`), все запросы
ограничены компанией:

| Поле | Смысл |
|---|---|
| `slug` | короткое имя узла, уникально внутри компании, `^[a-z0-9][a-z0-9-]{0,62}$` |
| `name` | имя соединения в Guacamole и подпись в списке |
| `hostname`, `port` | адрес узла и порт (по умолчанию 22 для ssh, 5900 для vnc) |
| `protocol` | `ssh` или `vnc` (vnc — путь консоли Proxmox, шаг 0 §4) |
| `username` | узловая учётка, по умолчанию `fleet-console` |
| `passwordSecretKey` | имя секрета панели с паролем узла; пусто — вход по ключу |
| `enabled` | выключенный узел не открывается (`409`) |

Узлы и браузеры (BROWSER-CONSOLE) — разные сущности и разные файлы; реестры не пересекаются.

## 3. Токен Guacamole

Алгоритм — ровно как в эталоне вендора
(`extensions/guacamole-auth-json/doc/encrypt-json.sh`):

1. подписать байты JSON ключом HMAC/SHA-256 и приписать бинарную подпись **перед** JSON;
2. зашифровать подпись+JSON через AES-128-CBC с нулевым вектором и PKCS#5-дополнением;
3. закодировать результат в base64.

Документ внутри:

```json
{
  "username": "fleet-console-<владелец>",
  "expires": 1446323765000,
  "connections": {
    "Node A": { "protocol": "ssh", "parameters": { "hostname": "...", "port": "22", "username": "fleet-console", "password": "..." } }
  }
}
```

- `expires` — миллисекунды UNIX, `сейчас + 5 минут` (константа `FLEET_CONSOLE_TOKEN_TTL_MS` в
  `server/src/myrmidon/fleet-console/settings.ts`). После `expires` Guacamole токен не принимает.
- Ключ — 32 hex-цифры (128 бит). Другой формат значения — отказ `503` (`console_secret_invalid`),
  а не тихая выдача нерабочего токена.
- Тест `server/src/myrmidon/fleet-console/token.myrmidon.test.ts` сверяет нашу подпись с байтами,
  которые даёт конвейер OpenSSL эталона (вектор в тесте). Любое изменение порядка подписи, режима,
  вектора или дополнения ломает эту проверку.
- Токен не хранится и нигде не печатается: в журнал попадает только идентификатор сессии.

## 4. Контракт API

Все четыре маршрута требуют доски и роли владельца компании (иначе `403`); компании вне доступа
дают `403`; агентские ключи — `403`.

| Метод и путь | Тело | Ответ |
|---|---|---|
| `GET /api/myrmidon/fleet/servers?companyId=` | — | `{ servers: [...] }` |
| `PUT /api/myrmidon/fleet/servers` | `{ companyId, slug, name, hostname, port?, protocol?, username?, passwordSecretKey?, description?, enabled? }` | `{ server }` — создаёт строку или заменяет поля строки с тем же `slug` |
| `POST /api/myrmidon/fleet/console-token` | `{ companyId, serverId? \| slug? }` (ровно одно из двух) | `{ sessionId, serverId, serverSlug, serverName, protocol, token, guacamoleUrl, consoleUrl, expiresAt }` |
| `POST /api/myrmidon/fleet/console-sessions/close` | `{ companyId, sessionId }` | `{ sessionId, serverId, durationMs, closedAt }` |

Ошибки выдачи токена: `404 console_server_not_found`, `409 console_server_disabled`,
`503 console_not_configured` (нет `MYRMIDON_FLEET_CONSOLE_URL`), `503 console_secret_missing`
(в хранилище нет секрета с именем `guacamole-json-secret-key`), `503 console_secret_invalid`
(значение не 32 hex), `503 console_node_secret_missing` (строка ссылается на отсутствующий секрет).
Закрытие неизвестной сессии — `404 console_session_not_found`.

## 5. Журнал сессий

Пишется в `activity_log` — журнал панели, видимый на экране активности:

| Действие | Когда | Поля `details` |
|---|---|---|
| `myrmidon.console.token_issued` | перед возвратом токена | `serverId`, `serverSlug`, `serverName`, `hostname`, `protocol`, `nodeUsername`, `sessionId`, `issuedAt`, `expiresAt` |
| `myrmidon.console.session_closed` | по закрытию сессии | `serverId`, `sessionId`, `durationMs`, `closedAt` |

Обе записи имеют `entityType = myrmidon_console_session` и `entityId = sessionId`; длительность
считается по `issuedAt` из первой записи. Ни токена, ни ключа, ни пароля в журнале нет — это
проверяет тест маршрутов.

## 6. Настройки и секреты

- `MYRMIDON_FLEET_CONSOLE_URL` — базовый адрес клиента Guacamole, например
  `https://guac.example.com`. Не задан — выдача токена отвечает `503`. Строка в `SETTINGS.md`.
- Секрет компании `guacamole-json-secret-key` — общий ключ с клиентом Guacamole
  (`json-secret-key`). Значение читается на сервере, в ответ и журнал не попадает.
- Секрет узла (`passwordSecretKey` строки реестра) — пароль узловой учётки.

## 7. Что не сделано в этой части

- Запись сессии на стороне Guacamole (`recording-path`): журнал панели есть, видеозапись — шаг
  стенда и эксплуатации Guacamole.
- Таймаут бездействия и закрытие сессии по нему: закрывает владелец кнопкой, иначе в журнале
  остаётся только выдача токена без длительности.
- Создание узловой учётки `fleet-console` на узлах и раскладка секретов: эксплуатация.
- Консоль Proxmox (noVNC) как отдельный путь: реестр уже умеет `vnc`, экран Fleet из плана 2.0 не
  заведён — раздел живёт в настройках компании.

## 8. Как проверить на стенде

```sh
# 1. Выдать токен (доска, владелец компании)
curl -sS -X POST "$PANEL/api/myrmidon/fleet/console-token" \
  -H 'Content-Type: application/json' \
  --data '{"companyId":"<id>","slug":"node-a"}'

# 2. Убедиться, что токен читается тем же ключом и имеет срок
#    (та же проверка, что делает тест, — можно скриптом эталона вендора:
#     ./encrypt-json.sh <hex-ключ> auth.json должен дать тот же base64)

# 3. Открыть consoleUrl в браузере: клиент Guacamole покажет терминал узла
```

Критерии приёмки части: владелец получает терминал, не-владелец получает `403`, токен перестаёт
работать после `expires`, в журнале панели есть обе записи.