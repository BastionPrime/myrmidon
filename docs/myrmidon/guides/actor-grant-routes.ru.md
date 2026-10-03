# Агенты-акторы с грантами прав: окружения и tool-подключения

> English version: [actor-grant-routes.md](actor-grant-routes.md)

Часть маршрутов, прежде доступных только доске, теперь пускает **агента-актора**, если компания выдала агенту соответствующее право. Это руководство перечисляет, какие именно маршруты изменились, какой ключ права требует каждый, что видит агент без гранта и что путь board-актора не изменился.

Это зонт ADMIN-AGENT, часть B (грантовые проверки актора), слита в PR #412 для релиза 1.6.1.

## Как работает проверка

Все изменённые маршруты делегируют одному помощнику —
`assertActorCompanyPermission` в `server/src/routes/authz.ts` (или его
файловым двойникам `assertBoardToolPermission` / `assertBoardAnyToolPermission`
в `tool-access.ts` и `assertBoardPermission` в `tool-gateway.ts`, тем же
образом):

- Доступ к компании проверяется по-прежнему первым: ключ агента чужой компании
  отказывает ровно как раньше (`Agent key cannot access another company`).
- **Board-актор** сохраняет прежнее поведение: локальная неявная доска и
  инстанс-админы проходят, вошедший участник проходит с грантом через
  `access.canUser`, зрители остаются только на чтение при мутациях, а
  `local_implicit` обходит проверку гранта.
- **Агент-актор** проходит, когда компания выдала агенту этот ключ права
  (`access.hasPermission(companyId, "agent", agentId, key)`); без гранта
  маршрут отвечает `403` с `Missing permission: <key>` (или
  `Missing one of permissions: …`, где достаточно любого из перечисленных).

Грант — строка в таблице `principal_permission_grants`, той же, что страница
прав компании использует для участников-людей. Агенты — тоже участники
(`principalType: "agent"`): оператор выдаёт агенту право из UI доски так же,
как участнику-человеку, или через
`PATCH /api/companies/:companyId/members/:memberId/permissions` с массивом
`grants`. Сам этот маршрут закрыт правом `users:manage_permissions` и
атомарно заменяет весь набор грантов получателя, поэтому передавайте полный
желаемый список, а не только новый ключ.

## Маршруты и требуемые ключи прав

### Окружения (`server/src/routes/environments.ts`)

Маршруты окружений инстанса и кастомных образов используют три стража;
агент-актор с резолвленным контекстом `companyId` проходит с ключом:

| Страж | Относится к | Правило для агента |
|---|---|---|
| `assertCanAccessInstanceEnvironments` | управление и мутации окружений инстанса (`POST /api/companies/:companyId/environments`, `PATCH`/`DELETE /api/environments/:id`, пробы, сессии настройки кастомных образов, откат) | своя компания + `environments:manage`; агент **без** контекста компании отвергается как раньше (управление окружениями инстанса остаётся за операторами доски) |
| `assertCanReadInstanceEnvironments` | поверхности чтения (`GET /api/companies/:companyId/environments` и алиасы) | своя компания + `environments:manage`; без контекста компании агент получает прежний отказ |
| `assertCustomImageCompanyAccess` | чтение/запись шаблонов кастомных образов в рамках компании | своя компания + `environments:manage` |

Чтение списка окружений компании
(`GET /api/companies/:companyId/environments`) теперь требует грант
`environments:manage` у агента-актора — оно перечисляет общий каталог
окружений инстанса, поэтому агент без гранта получает здесь тоже `403`.

Board-актор не изменился: мутации окружений инстанса по-прежнему требуют
инстанс-админа (или локальной неявной доски), а участники доски с доступом к
компании читают как раньше.

### Tool-подключения (`server/src/routes/tool-access.ts`)

| Страж | Требуемый ключ (ключи) |
|---|---|
| `assertToolsAdmin` (`tools:admin`) | `GET`/`POST /api/companies/:companyId/tools/stdio-templates` (одобренные stdio-шаблоны команд и их отключение) |
| `assertToolsRuntimeManage` (`tools:manage_runtime`) | `GET /api/companies/:companyId/tools/runtime-slots`, `POST …/runtime-slots/:id/stop`, `POST …/runtime-slots/:id/restart` |
| `assertBoardAnyToolPermission` (любой из) | `GET /api/tool-connections/:connectionId/test-agents` и другие маршруты тестирования подключения: `tools:use` **или** `tools:manage_connections` |
| `assertBoardToolPermission` (`tools:manage_connections`) | страж «менеджера подключений», где путь настройки подключения проверяет грант |

Остальные маршруты подключений сохраняют прежнюю логику членства/ролей для
board-акторов и остаются только для доски на мутациях, если не перечислены
выше; собственные маршруты жизненного цикла подключений агента
(`/agents/me/connections/…`) этим изменением не затронуты.

### Шлюз инструментов (`server/src/routes/tool-gateway.ts`)

Страж грантов шлюза покрывает сырые поверхности управления шлюзом:

| Маршрут | Требуемый ключ |
|---|---|
| `GET /api/tool-gateway/runtime-slots` | `tools:manage_runtime` |
| `POST /api/tool-gateway/runtime-slots/:slotId/stop` | `tools:manage_runtime` |
| `POST /api/tool-gateway/runtime-slots/:slotId/restart` | `tools:manage_runtime` |
| `GET /api/tool-gateway/audit` | `tools:view_audit` |
| `GET`/`POST /api/companies/:companyId/tools/gateways`, `PATCH /api/tool-gateway/gateways/:gatewayId`, создание/отзыв токенов | `tools:admin` |

До этого изменения агент-актор получал `Board access required` на всём этом;
теперь агент с нужным грантом проходит, а без него получает
`403 Missing permission: <key>`.

## Атрибуция в журнале активности

Мутации tool-подключений (действия `tool_connection.*`, `tool_application.*`,
`paperclip_cloud_connector.*`, `tool_stdio_command_template.*`,
`tool_app.*`) теперь записывают **реально действующее лицо** вместо
захардкоженной заглушки `user` / `req.actor.userId ?? "board"`: мутация от
агента-актора пишет `actorType: "agent"` с идентификаторами агента и прогона,
так что изменение, сделанное агентом, находится в журнале активности компании.
Раньше строка утверждала, что изменение сделал участник доски.

## Заметки оператору

- Строка реестра — запись ADMIN-AGENT часть B в
  [../DIVERGENCE.md](../DIVERGENCE.md).
- Гранты выдаются по участнику со страницы прав компании; ключи прав —
  вендорский список `PERMISSION_KEYS` (`environments:manage`,
  `tools:admin`, `tools:manage_connections`, `tools:manage_profiles`,
  `tools:manage_runtime`, `tools:view_audit`, …).
- Отказ по умолчанию: агент без грантов видит ровно прежнее поведение (403),
  ничего не выдав — ничего не меняешь.
- Агент действует ключом своей компании: вызов в чужую компанию отказывает на
  проверке доступа к компании, до проверки гранта.
