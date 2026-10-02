# Контракт хелпера подписи (native messaging)

> English version: [signing-host-contract.md](signing-host-contract.md)

Расширение подписывает документы через процесс-помощник на ПК клиента. Стороны
говорят по Chrome Native Messaging, а контракт сообщений —
`extension/src/native-host-contract.ts` — только типы и валидаторы, без
реализации. Конкретный помощник (привязка middleware токена, хранение PIN)
специфичен для развёртывания и живёт вне публичного форка; обе стороны
компилируются против этого контракта.

## Транспорт и граница доверия

Проводной формат — Chrome Native Messaging: каждое сообщение — UTF-8
JSON-объект с префиксом из 4 байт little-endian длины, передаваемый по
stdio-каналу, который браузер открывает хосту. Браузер запускает только те
хосты, чей манифест `allowed_origins` совпадает с ID расширения, поэтому эта
регистрация — единственная граница доверия; сетевых интерфейсов у хостов нет.

Через границу расширение ↔ хост проходят только команда и результат. Секреты
вроде PIN или закрытых ключей не должны появляться ни в одном направлении, а
помощник никогда не сохраняет документ.

## Запрос

`SignRequestMessage` — единственный тип входящего сообщения:

| Поле | Тип | Примечания |
|---|---|---|
| `type` | `"sign"` | константа |
| `id` | `number` | конечное; возвращается в ответе |
| `actionType` | `SignActionType` | закрытый enum, см. ниже |
| `documentRef` | `string` | непустая ссылка на workspace |
| `document` | `DocumentPayload` | байты или дайджест, см. ниже |

`actionType` — закрытый enum (`SIGN_ACTION_TYPES`): неизвестные значения
отклоняются:

- `sign`
- `sign_and_submit`
- `sign_attachment`

`document` (`DocumentPayload`) — ровно один из двух вариантов:

- `{ kind: "bytes", bytesBase64: string }` — сырые байты документа в base64;
  `bytesBase64` обязан быть непустой строкой. Расширение само скачивает/читает
  документ.
- `{ kind: "digest", digestHex: string }` — предвычисленный SHA-256 документа;
  `digestHex` обязан соответствовать `^[0-9a-f]{64}$` (без учёта регистра).

## Ответ

`SignResponseMessage`: `type` — `"sign_result"`, `id` повторяет id запроса,
`result` — `SignResult`:

- успех — `{ ok: true, hash }`, где `hash` — hex-дайджест подписанного
  документа (его записывает журнал действий);
- отказ — `{ ok: false, error, message? }`, где `error` — `SignErrorCode`, а
  `message` — необязательный произвольный текст.

Коды ошибок — закрытое множество (`SIGN_ERROR_CODES`):

| Код | Значение |
|---|---|
| `invalid_request` | запрос не прошёл валидацию |
| `unknown_action_type` | `actionType` вне enum |
| `unsupported_payload` | помощник не может принять такую форму payload |
| `pin_unavailable` | PIN недоступен на этом ПК |
| `middleware_error` | сбой middleware токена |
| `cancelled` | человек отменил шаг |

## Валидация

Контракт экспортирует три валидатора, покрытые
`extension/tests/native-host-contract.spec.ts`:

- `isSignActionType` — принадлежность enum;
- `isDocumentPayload` — форма payload (непустой base64 для `bytes`, hex
  SHA-256 для `digest`);
- `isSignRequestMessage` — полная валидация запроса.

Сообщение, не прошедшее полную валидацию, либо отбрасывается (нет пригодного
id запроса), либо отвечается явным отказом `invalid_request` — до логики
подписи оно не доходит никогда.

## См. также

- [bridge-extension.ru.md](bridge-extension.ru.md) — само расширение.
- [browser-bridge-gateway.ru.md](browser-bridge-gateway.ru.md) — сторона доски
  и политика подписи (`general.browserBridge.signing`).
