# 2026-09-20, Т-2-fix: машинная сверка имён полей против td_api.tl

Тикет: OPE-2494 (Фаза 2, ветка ope-2270-t2-fix). Источник: ревью
3a2b45d3/d0d89c6b — пункты (а)–(г): исправить имена полей, зафиксировать
целевую схему моков, включить машинную сверку в прогоны сдач.

## Метод

1. Схема: официальный `td/generate/scheme/td_api.tl` ветки master TDLib
   (raw.githubusercontent.com, 16313 строк, 2535 конструкторов после
   парсинга). Команда:
   `curl -s -o /tmp/td_api.tl https://raw.githubusercontent.com/tdlib/td/master/td/generate/scheme/td_api.tl`
2. Скрипт `tools/td_schema_check.py`: парсит конструкторы схемы
   (имя + имена полей), извлекает из Dart-файлов строковые литералы
   snake_case ключей с их @type-контекстом (стек map-литералов),
   ассертит каждое имя поля в соответствующем конструкторе схемы.
   Литералы в сравнениях (== 'name') отбрасываются: это имена
   конструкторов, не полей. Легаси-конструкторы (ADR-0001:
   setDatabaseEncryptionKey, authorizationStateWaitEncryptionKey)
   пропускаются как задокументированные.
3. Охват: test/mock_td_client.dart (скрипт апдейтов 4.4),
   lib/.../td_auth_flow.dart (request-тела),
   lib/.../td_client_seam.dart (setTdlibParameters),
   lib/.../td_chat_store.dart.

## Наблюдения (прогон на ветке ДО правок)

Скрипт сразу нашёл обе опечатки ревью (подтверждение метода):
- `td_auth_flow.dart`: `allow_sms_retrieval_api` не в
  phoneNumberAuthenticationSettings (мастер-схема: allow_sms_retriever_api
  «For official applications only» — для нас false, но имя провода должно
  совпадать);
- `mock_td_client.dart`: `unread_unmentioned_count` не в
  updateChatUnreadMentionCount (верно: unread_mention_count).

После правок (а)/(б): `td_schema_check: 23 field names verified …
OK: no mismatches` (exit 0).

## Правки по пунктам ревью

- (а) allow_sms_retrieval_api → allow_sms_retriever_api
  (td_auth_flow.dart:179); unread_unmentioned_count →
  unread_mention_count (mock_td_client.dart:195).
- (б) док-комментарий td_db_key_store.dart: cred:telegram:<id> →
  cred:tg:<id> (фактическое поведение и тест без изменений).
- (в) ADR-0001, раздел «Ограничения»: целевая схема моков/швов = мастер
  td_api.tl; легаси-отступления перечислены явно
  (authorizationStateWaitEncryptionKey/setDatabaseEncryptionKey,
  user.username в моке, updateChatAction без topic_id).
- (г) tools/td_schema_check.py добавлен в прогон каждой сдачи Фазы 2
  (после analyze/test, перед коммитом).

## Чек-лист живой проверки (сборочный образ ADM)

- [ ] Прогнать td_schema_check.py против td_api.tl ТЕГА TDLib, на котором
      собирается libtdjson (схема тега может отличаться от master).
- [ ] Живой smoke: setAuthenticationPhoneNumber принимается реальным
      TDLib без «Unexpected field» (валидация имени allow_sms_retriever_api).
- [ ] Живой updateChatUnreadMentionCount с полем unread_mention_count
      проходит через applyUpdate (несовпадений имён нет).
- [ ] user.username/usernames: при живой сверке решить, мигрирует ли мок
      на user.usernames (мастер-схема) — поле не читается кодом Фазы 2.

## Артефакты

- Схема: /tmp/td_api.tl (в образе качается той же командой из Method).
- Прогон: вывод в комментарии сдачи + /srv/dev/OPE-2494/t2-fix-schema.txt.
